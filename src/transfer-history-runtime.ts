/*
 * Filename: transfer-history-runtime.ts
 * FullPath: apps/CWSP-reborn/src/frontend/submodules/views/history/transfer-history-runtime.ts
 * Change date and time: 09.45.00_31.07.2026
 * Reason for changes: Cap+Neu Transfer History runtime — localStorage ring +
 *   Cap bridge events + Neu control poll; action dispatch for History view.
 *   2026-07-25c: Neu poll probes control ports (never NL_PORT / :8434) so History
 *   is not stuck empty when auth globals were poisoned by Neutralino document port.
 *   2026-07-25f: localFilePath + preview URL for Neu file-backed clipboard images.
 *   2026-07-31: batch store mutations per poll; debounce localStorage persist.
 *   2026-07-31b: pause Neu poll while History UI hidden; skip unchanged wire
 *   snapshots; strip large thumbs from localStorage (Neutralino main-thread freeze).
 *   2026-07-31c: clearInterval off-screen (not just no-op); drop large thumbs on
 *   ingest; no boot-time poll — Neutralino WebView was hard-freezing.
 */

import {
    createTransferHistoryStore,
    parseTransferHistory,
    serializeTransferHistory,
    type TransferHistoryAction,
    type TransferHistoryEntry,
    type TransferHistoryStore
} from "@fest-lib/cwsp-shared/v2/transfer-history.ts";

const STORAGE_KEY = "cwsp-transfer-history-v1";
const NEU_POLL_MS = 2500;
/** Neu: tiny thumbs only — large data-URLs freeze Neutralino when stringified / painted. */
const THUMB_KEEP_MAX_NEU = 2_048;
/** Cap: compact JPEG previews are OK in-memory / localStorage. */
const THUMB_KEEP_MAX_CAP = 65_536;
const RETAINED_TEXT_KEEP_MAX = 8_192;
const DEFAULT_CONTROL_PORT = 29110;
const DEFAULT_CONTROL_KEY = "cwsp-neutralino-local";

function isNeuRuntime(): boolean {
    const g = globalThis as {
        __CWS_NEUTRALINO_BOOT__?: boolean;
        __CWS_WEBNATIVE_BOOT__?: boolean;
    };
    return Boolean(g.__CWS_NEUTRALINO_BOOT__ || g.__CWS_WEBNATIVE_BOOT__);
}

function thumbKeepMax(): number {
    return isNeuRuntime() ? THUMB_KEEP_MAX_NEU : THUMB_KEEP_MAX_CAP;
}

let store: TransferHistoryStore | null = null;
let startedCap = false;
let startedNeu = false;
let neuPollTimer: ReturnType<typeof setInterval> | null = null;
/** Last control port that answered GET /service/transfer-history. */
let neuWorkingPort: number | null = null;
/** WHY: boot starts Neu poll — keep it idle until History view is on screen. */
let historyUiActive = false;
let lastNeuWireSig = "";
let neuPollInFlight = false;

function controlPortCandidates(): { port: number; key: string }[] {
    const g = globalThis as unknown as {
        __WEBNATIVE_AUTH__?: { port?: number; key?: string };
        __NEUTRALINO_AUTH__?: { port?: number; key?: string };
        NL_PORT?: number | string;
    };
    const key = String(
        g.__NEUTRALINO_AUTH__?.key || g.__WEBNATIVE_AUTH__?.key || DEFAULT_CONTROL_KEY
    );
    const nlRaw = g.NL_PORT;
    const nlPort =
        typeof nlRaw === "number" ? nlRaw : nlRaw ? Number(nlRaw) : NaN;
    const seen = new Set<number>();
    const out: { port: number; key: string }[] = [];
    const push = (port: number | undefined | null): void => {
        if (typeof port !== "number" || !Number.isFinite(port) || port < 1024) return;
        // WHY: hub :8434 and Neutralino NL_PORT are not control-RPC.
        if (port === 8434) return;
        if (Number.isFinite(nlPort) && port === nlPort) return;
        if (seen.has(port)) return;
        seen.add(port);
        out.push({ port, key });
    };
    // Prefer last known-good, then inject, then default desk control.
    push(neuWorkingPort);
    push(g.__NEUTRALINO_AUTH__?.port);
    push(g.__WEBNATIVE_AUTH__?.port);
    push(DEFAULT_CONTROL_PORT);
    // Always ensure at least the default when inject was poisoned.
    if (!out.length) out.push({ port: DEFAULT_CONTROL_PORT, key });
    return out;
}

/** Best-effort control auth for History POST (prefer last working poll port). */
function readAuth(): { port: number; key: string } | null {
    const list = controlPortCandidates();
    return list[0] || null;
}

/**
 * Neu History image src: inline data URL, else control preview of durable PNG.
 * WHY: toast PNGs are copied to `.data/transfer-history-assets`; large thumbs
 * are omitted from GET JSON and loaded via `?id=&key=`.
 */
export function historyImageSrc(entry: TransferHistoryEntry): string {
    const inline = String(entry.thumbDataUrl || "").trim();
    if (inline.startsWith("data:image/")) {
        // Cap: normal compact JPEG thumbs; Neu: only tiny inline, else preview URL.
        if (!isNeuRuntime() || inline.length <= THUMB_KEEP_MAX_NEU) return inline;
    }
    if (!isNeuRuntime()) return "";
    // Neu: load durable PNG via control even when inline thumb was stripped.
    const auth = readAuth();
    if (!auth) return "";
    const id = encodeURIComponent(entry.id || entry.transferId || entry.contentKey || "");
    if (!id) return "";
    return `http://127.0.0.1:${auth.port}/service/transfer-history/preview?id=${id}&key=${encodeURIComponent(auth.key)}`;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function stripHeavyFields(entry: TransferHistoryEntry): TransferHistoryEntry {
    const next = { ...entry };
    if (next.thumbDataUrl && next.thumbDataUrl.length > thumbKeepMax()) {
        // WHY: Neu serves durable PNG via preview URL; in-memory data-URL kills WebView.
        delete next.thumbDataUrl;
    }
    if (next.retainedText && next.retainedText.length > RETAINED_TEXT_KEEP_MAX) {
        next.retainedText = next.retainedText.slice(0, RETAINED_TEXT_KEEP_MAX);
    }
    if (next.textPreview && next.textPreview.length > 2_000) {
        next.textPreview = next.textPreview.slice(0, 2_000);
    }
    return next;
}

function entriesForPersist(entries: TransferHistoryEntry[]): TransferHistoryEntry[] {
    return entries.map((e) => stripHeavyFields(e));
}

function persist(s: TransferHistoryStore): void {
    try {
        localStorage.setItem(
            STORAGE_KEY,
            serializeTransferHistory(entriesForPersist(s.list()))
        );
    } catch {
        /* quota / private mode */
    }
}

/** WHY: sync persist on every upsert froze the main thread when thumbs are large. */
function schedulePersist(s: TransferHistoryStore): void {
    if (persistTimer != null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        persistTimer = null;
        persist(s);
    }, 400);
}

function stopNeuPollTimer(): void {
    if (neuPollTimer != null) {
        clearInterval(neuPollTimer);
        neuPollTimer = null;
    }
}

function ensureNeuPollTimer(): void {
    if (neuPollTimer != null || !historyUiActive) return;
    neuPollTimer = setInterval(() => {
        void pollNeuHistory();
    }, NEU_POLL_MS);
}

/**
 * History view visibility — Neu poll is expensive (JSON + store + DOM).
 * Call from HistoryView onShow / onHide.
 * INVARIANT: when inactive, the interval is cleared (not merely skipped).
 */
export function setTransferHistoryUiActive(active: boolean): void {
    historyUiActive = Boolean(active);
    try {
        const g = globalThis as unknown as {
            __CWSP_TRANSFER_HISTORY_UI_ACTIVE__?: boolean;
        };
        g.__CWSP_TRANSFER_HISTORY_UI_ACTIVE__ = historyUiActive;
    } catch {
        /* */
    }
    if (!historyUiActive) {
        stopNeuPollTimer();
        return;
    }
    if (startedNeu) {
        ensureNeuPollTimer();
        void pollNeuHistory();
    }
}

/** Cheap wire fingerprint so identical Neu snapshots skip store/DOM work. */
function neuWireSignature(entries: unknown[]): string {
    let sig = String(entries.length);
    for (const raw of entries) {
        if (!raw || typeof raw !== "object") {
            sig += "|?";
            continue;
        }
        const e = raw as Record<string, unknown>;
        const thumbLen =
            typeof e.thumbDataUrl === "string" ? (e.thumbDataUrl as string).length : 0;
        sig += `|${e.id || e.transferId}:${e.status}:${e.bytesDone ?? ""}:${e.speedBps ?? ""}:${e.lastActionAt ?? e.ts ?? ""}:${thumbLen}`;
    }
    return sig;
}

/** Singleton Transfer History store (local to this WebView). */
export function getTransferHistoryStore(): TransferHistoryStore {
    if (store) return store;
    let initial: TransferHistoryEntry[] = [];
    try {
        // WHY: older Neu builds persisted multi-MB data-URL thumbs — one paint freezes WebView.
        initial = parseTransferHistory(localStorage.getItem(STORAGE_KEY)).map(stripHeavyFields);
    } catch {
        initial = [];
    }
    store = createTransferHistoryStore({ initial });
    store.subscribe(() => {
        if (store) schedulePersist(store);
    });
    // Heal bloated localStorage once after boot (thumbs already stripped in memory).
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw && raw.length > 64_000) schedulePersist(store);
    } catch {
        /* */
    }
    return store;
}

function upsertFromUnknown(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const e = raw as Partial<TransferHistoryEntry>;
    if (typeof e.id !== "string" && typeof e.transferId !== "string") return;
    if (typeof e.kind !== "string" || typeof e.direction !== "string") return;
    if (typeof e.status !== "string" || typeof e.title !== "string") return;
    getTransferHistoryStore().upsert(stripHeavyFields({
        id: String(e.id || e.transferId),
        ts: typeof e.ts === "number" ? e.ts : Date.now(),
        kind: e.kind as TransferHistoryEntry["kind"],
        direction: e.direction as TransferHistoryEntry["direction"],
        status: e.status as TransferHistoryEntry["status"],
        title: e.title,
        subtitle: e.subtitle,
        textPreview: e.textPreview,
        retainedText: e.retainedText,
        thumbDataUrl: e.thumbDataUrl,
        localFilePath: e.localFilePath,
        fileNames: e.fileNames,
        transferId: e.transferId,
        bytesDone: e.bytesDone,
        totalBytes: e.totalBytes,
        speedBps: e.speedBps,
        etaMs: e.etaMs,
        expiresAt: e.expiresAt,
        peerId: e.peerId,
        error: e.error,
        contentKey: e.contentKey,
        lastActionAt: typeof e.lastActionAt === "number" ? e.lastActionAt : undefined
    }));
}

function onCapWindowEvent(ev: Event): void {
    try {
        const ce = ev as CustomEvent;
        const detail = ce.detail;
        let parsed: unknown = detail;
        if (typeof detail === "string") {
            parsed = JSON.parse(detail);
        }
        if (parsed && typeof parsed === "object" && "entries" in (parsed as object)) {
            const entries = (parsed as { entries?: unknown[] }).entries;
            if (Array.isArray(entries)) {
                for (const e of entries) upsertFromUnknown(e);
                return;
            }
        }
        upsertFromUnknown(parsed);
    } catch {
        /* ignore malformed bridge payloads */
    }
}

/** Cap: listen for native → WebView history events. */
export function startCapacitorTransferHistory(): void {
    if (startedCap) return;
    startedCap = true;
    getTransferHistoryStore();
    window.addEventListener("cws:transferHistory", onCapWindowEvent as EventListener);
    // COMPAT: also listen on document for Capacitor bridge dispatch variants.
    document.addEventListener("cws:transferHistory", onCapWindowEvent as EventListener);
    // COMPAT: Capacitor plugin nativeMessage envelope { type: transfer-history, entry }.
    void import("com/routing/native/cws-bridge")
        .then(async ({ CwsBridge }) => {
            try {
                await CwsBridge.addListener("nativeMessage", (event) => {
                    const payload = event?.payload;
                    if (!payload || typeof payload !== "object") return;
                    const p = payload as { type?: string; entry?: unknown };
                    if (p.type !== "transfer-history") return;
                    let entry: unknown = p.entry;
                    if (typeof entry === "string") {
                        try {
                            entry = JSON.parse(entry);
                        } catch {
                            return;
                        }
                    }
                    upsertFromUnknown(entry);
                });
            } catch {
                /* plugin optional on web */
            }
        })
        .catch(() => undefined);
}

async function pollNeuHistory(): Promise<void> {
    // WHY: interval keeps ticking after boot; never burn the WebView while History is hidden.
    if (!historyUiActive) return;
    if (neuPollInFlight) return;
    neuPollInFlight = true;
    try {
        await pollNeuHistoryInner();
    } finally {
        neuPollInFlight = false;
    }
}

async function pollNeuHistoryInner(): Promise<void> {
    const candidates = controlPortCandidates();
    for (const auth of candidates) {
        try {
            const res = await fetch(
                `http://127.0.0.1:${auth.port}/service/transfer-history`,
                {
                    headers: { "x-api-key": auth.key },
                    signal:
                        typeof AbortSignal !== "undefined" &&
                        typeof AbortSignal.timeout === "function"
                            ? AbortSignal.timeout(2000)
                            : undefined
                }
            );
            if (!res.ok) continue;
            const data = (await res.json()) as { entries?: unknown[]; replace?: boolean };
            if (!Array.isArray(data.entries)) continue;
            const wireSig = neuWireSignature(data.entries);
            if (wireSig === lastNeuWireSig) return;
            lastNeuWireSig = wireSig;
            neuWorkingPort = auth.port;
            // Heal poisoned globals so later History actions hit the same control.
            try {
                const g = globalThis as unknown as {
                    __NEUTRALINO_AUTH__?: { port: number; key: string };
                    __WEBNATIVE_AUTH__?: { port: number; key: string };
                };
                g.__NEUTRALINO_AUTH__ = { port: auth.port, key: auth.key };
                g.__WEBNATIVE_AUTH__ = { port: auth.port, key: auth.key };
            } catch {
                /* */
            }
            const s = getTransferHistoryStore();
            // WHY: server is SoT on Neu — replace local when snapshot is authoritative.
            // Apply upserts first so a malformed entry cannot leave the UI wiped.
            // Keep rows matched by contentKey too — same paste may keep an older
            // stable id after client-side collapse.
            // INVARIANT: one store.batch → one UI/localStorage notify (not N×rows).
            s.batch(() => {
                if (data.replace) {
                    const ids = new Set<string>();
                    const contentKeys = new Set<string>();
                    for (const raw of data.entries) {
                        if (raw && typeof raw === "object") {
                            const e = raw as {
                                id?: string;
                                transferId?: string;
                                contentKey?: string;
                            };
                            const id = String(e.id || e.transferId || "");
                            if (id) ids.add(id);
                            const ck = String(e.contentKey || "").trim();
                            if (ck) contentKeys.add(ck);
                        }
                        upsertFromUnknown(raw);
                    }
                    for (const local of s.list()) {
                        const keepId =
                            ids.has(local.id) ||
                            (local.transferId != null && ids.has(local.transferId));
                        const keepKey =
                            local.contentKey != null &&
                            contentKeys.has(String(local.contentKey));
                        if (!keepId && !keepKey) {
                            s.remove(local.id);
                        }
                    }
                } else {
                    for (const e of data.entries) upsertFromUnknown(e);
                }
            });
            return;
        } catch {
            /* try next control port */
        }
    }
}

/**
 * Neu: arm Transfer History store. Polling starts only while History UI is active.
 * WHY: boot-time setInterval + large JSON hard-froze Neutralino WebView.
 */
export function startNeutralinoTransferHistory(): void {
    if (startedNeu) return;
    startedNeu = true;
    getTransferHistoryStore();
    if (historyUiActive) {
        ensureNeuPollTimer();
        void pollNeuHistory();
    }
}

export async function dispatchHistoryAction(
    entry: TransferHistoryEntry,
    action: TransferHistoryAction
): Promise<boolean> {
    // WHY: Remove drops the History row; for live files it also Abort/Cancel first.
    if (action === "remove") {
        if (
            entry.kind === "files" &&
            (entry.status === "progress" ||
                entry.status === "actionable" ||
                entry.status === "pending")
        ) {
            const abortAction: TransferHistoryAction =
                entry.status === "progress"
                    ? "cancel"
                    : entry.direction === "in"
                      ? "decline"
                      : "cancel";
            try {
                await dispatchHistoryAction(entry, abortAction);
            } catch {
                /* still remove the row */
            }
        }
        const key = entry.transferId || entry.id;
        getTransferHistoryStore().remove(key);
        const auth = readAuth();
        if (auth && (globalThis as { __CWS_NEUTRALINO_BOOT__?: boolean }).__CWS_NEUTRALINO_BOOT__) {
            try {
                await fetch(`http://127.0.0.1:${auth.port}/service/transfer-history`, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "x-api-key": auth.key
                    },
                    body: JSON.stringify({
                        action: "remove",
                        id: entry.id,
                        transferId: entry.transferId,
                        kind: entry.kind,
                        direction: entry.direction
                    }),
                    signal:
                        typeof AbortSignal !== "undefined" &&
                        typeof AbortSignal.timeout === "function"
                            ? AbortSignal.timeout(5000)
                            : undefined
                });
                void pollNeuHistory();
            } catch {
                /* local remove already applied */
            }
        }
        return true;
    }

    const auth = readAuth();
    // Neu desk: prefer control RPC (hub owns holds).
    if (auth && (globalThis as { __CWS_NEUTRALINO_BOOT__?: boolean }).__CWS_NEUTRALINO_BOOT__) {
        try {
            const res = await fetch(`http://127.0.0.1:${auth.port}/service/transfer-history`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-api-key": auth.key
                },
                body: JSON.stringify({
                    action,
                    id: entry.id,
                    transferId: entry.transferId,
                    kind: entry.kind,
                    direction: entry.direction
                }),
                signal:
                    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
                        ? AbortSignal.timeout(5000)
                        : undefined
            });
            if (res.ok) {
                const data = (await res.json()) as { applied?: boolean };
                void pollNeuHistory();
                return Boolean(data.applied ?? true);
            }
        } catch {
            /* fall through to Cap bridge */
        }
    }

    // Cap: prefer invoke channel (cws-bridge) then direct PluginMethods.
    try {
        const payload = {
            id: entry.id,
            transferId: entry.transferId,
            kind: entry.kind,
            direction: entry.direction,
            // WHY: Cap hold may be gone after toast TTL — prefer full localFilePath
            // over thumbDataUrl (320px JPEG preview only).
            retainedText: entry.retainedText || entry.textPreview || "",
            textPreview: entry.textPreview || "",
            thumbDataUrl: entry.thumbDataUrl || "",
            localFilePath: entry.localFilePath || ""
        };
        const { invokeCwsNative } = await import("com/routing/native/cws-bridge");
        const result = await invokeCwsNative({
            channel: `history:${action}`,
            payload
        });
        if (result?.ok !== false) {
            getTransferHistoryStore().mark(
                entry.transferId || entry.id,
                action === "decline" || action === "dismiss"
                    ? "declined"
                    : action === "accept"
                      ? "done"
                      : entry.status
            );
            return true;
        }
    } catch {
        /* fall through */
    }
    try {
        const bridge = (
            globalThis as {
                Capacitor?: {
                    Plugins?: {
                        CwsBridge?: Record<string, (...args: unknown[]) => Promise<unknown>>;
                    };
                };
            }
        ).Capacitor?.Plugins?.CwsBridge;
        if (bridge) {
            const map: Record<string, string> = {
                accept: "historyAccept",
                dismiss: "historyDismiss",
                decline: "historyDecline",
                open: "historyOpen",
                download: "historyDownload",
                cancel: "historyCancel",
                reveal: "historyReveal",
                share: "historyShare"
            };
            const method = map[action];
            if (method && typeof bridge[method] === "function") {
                await bridge[method]!({
                    id: entry.id,
                    transferId: entry.transferId,
                    kind: entry.kind,
                    direction: entry.direction,
                    retainedText: entry.retainedText || entry.textPreview || "",
                    textPreview: entry.textPreview || "",
                    thumbDataUrl: entry.thumbDataUrl || "",
                    localFilePath: entry.localFilePath || ""
                });
                getTransferHistoryStore().mark(
                    entry.transferId || entry.id,
                    action === "decline" || action === "dismiss"
                        ? "declined"
                        : action === "accept"
                          ? "done"
                          : entry.status
                );
                return true;
            }
        }
    } catch {
        /* */
    }

    // Local-only mark when no native handler (still updates UI).
    if (action === "dismiss" || action === "decline") {
        getTransferHistoryStore().mark(entry.transferId || entry.id, "declined");
        return true;
    }
    return false;
}
