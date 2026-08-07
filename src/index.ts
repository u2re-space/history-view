/*
 * Filename: index.ts
 * FullPath: apps/CWSP-reborn/src/frontend/submodules/views/history/index.ts
 * Change date and time: 09.45.00_31.07.2026
 * Reason for changes: Transfer History UI — clipboard/files durable log with
 *   type actions, muted expired rows, live progress bar + speed (plan 1C/2A).
 *   2026-07-25e: clipboard-image cards — thumb preview + size subtitle layout.
 *   2026-07-25f: Neu file-backed thumbs via control preview URL; Open File labels.
 *   2026-07-25m: append action buttons via DOM — H`${array}` / Mapped only
 *   keeps the first node, so History showed one button per row.
 *   2026-07-31: skip/coalesce list rebuilds when hidden — Neu poll was freezing UI.
 *   2026-07-31b: pause Neu poll off-screen; progress-only DOM patch; scoped styles.
 *   2026-07-31d: no ui-icon (font-registry); never paint huge data-URL thumbs.
 */

import { H } from "@fest-lib/lure";
import { loadAsAdopted, removeAdopted } from "@fest-lib/dom";
import type { View, ViewOptions, ViewLifecycle, ShellContext } from "shells/types";
import type { BaseViewOptions } from "views/types";
import { HistoryChannelAction } from "views/apis/channel-actions";
import {
    actionsForEntry,
    formatTransferBytes,
    formatTransferSpeed,
    isMutedHistoryStatus,
    transferProgressRatio,
    type TransferHistoryAction,
    type TransferHistoryEntry
} from "@fest-lib/cwsp-shared/v2/transfer-history.ts";
import {
    dispatchHistoryAction,
    getTransferHistoryStore,
    historyImageSrc,
    setTransferHistoryUiActive,
    startCapacitorTransferHistory,
    startNeutralinoTransferHistory
} from "./transfer-history-runtime";

// @ts-ignore
import style from "./scss/history.scss?inline";

export type HistoryViewOptions = BaseViewOptions;

export class HistoryView implements View {
    id = "history" as const;
    name = "History";
    icon = "clock-counter-clockwise";

    private options: BaseViewOptions;
    private shellContext?: ShellContext;
    private element: HTMLElement | null = null;
    private entries: TransferHistoryEntry[] = [];
    private unsub: (() => void) | null = null;
    private _sheet: CSSStyleSheet | null = null;
    /** WHY: cached History stays subscribed after navigate-away; gate DOM work. */
    private visible = false;
    private listRaf = 0;
    private lastListSig = "";
    private lastStructSig = "";

    lifecycle: ViewLifecycle = {
        onUnmount: () => {
            this.teardown();
        },
        onShow: () => {
            this.visible = true;
            this._sheet ??= loadAsAdopted(style) as CSSStyleSheet;
            this.ensureRuntime();
            this.bindStore();
            this.refreshFromStore();
            this.scheduleUpdateList(true);
            // WHY: start Neu poll after first paint so navigate isn't blocked by JSON/DOM.
            requestAnimationFrame(() => {
                if (this.visible) setTransferHistoryUiActive(true);
            });
        },
        onHide: () => {
            this.visible = false;
            setTransferHistoryUiActive(false);
            if (this.listRaf) {
                cancelAnimationFrame(this.listRaf);
                this.listRaf = 0;
            }
            this.teardownSheet();
        }
    };

    constructor(options: BaseViewOptions = {}) {
        this.options = options;
        this.shellContext = options.shellContext;
    }

    render(options?: ViewOptions): HTMLElement {
        if (options) {
            this.options = { ...this.options, ...options };
            this.shellContext = options.shellContext || this.shellContext;
        }
        this.ensureRuntime();
        this.bindStore();
        this.refreshFromStore();
        // First paint mounts the shell; Neu poll arms after paint (see onShow / rAF).
        this.visible = true;

        this.element = H`
            <div class="view-history" data-view="history">
                <div class="view-history__header">
                    <h1>History</h1>
                    <button class="view-history__clear-btn" data-action="clear" type="button">
                        <span aria-hidden="true">⌫</span>
                        <span>Clear</span>
                    </button>
                </div>
                <p class="view-history__hint">
                    Clipboard &amp; file transfers — active, done, and expired (max 100).
                </p>
                <div class="view-history__list" data-history-list></div>
            </div>
        ` as HTMLElement;

        this.setupEventHandlers();
        this.updateList(true);
        requestAnimationFrame(() => {
            if (this.visible) setTransferHistoryUiActive(true);
        });
        return this.element;
    }

    getToolbar(): HTMLElement | null {
        return null;
    }

    private ensureRuntime(): void {
        const g = globalThis as {
            __CWS_NEUTRALINO_BOOT__?: boolean;
            Capacitor?: unknown;
        };
        if (g.__CWS_NEUTRALINO_BOOT__) startNeutralinoTransferHistory();
        if (g.Capacitor) startCapacitorTransferHistory();
        // Always have a local store even if neither boot flag is set yet.
        getTransferHistoryStore();
    }

    private bindStore(): void {
        if (this.unsub) return;
        this.unsub = getTransferHistoryStore().subscribe((list) => {
            this.entries = list;
            // WHY: Neu poll every 1.5s — never rebuild DOM while another view is active.
            this.scheduleUpdateList(false);
        });
    }

    private refreshFromStore(): void {
        this.entries = getTransferHistoryStore().list();
    }

    private teardown(): void {
        this.visible = false;
        setTransferHistoryUiActive(false);
        if (this.listRaf) {
            cancelAnimationFrame(this.listRaf);
            this.listRaf = 0;
        }
        try {
            this.unsub?.();
        } catch {
            /* */
        }
        this.unsub = null;
        this.teardownSheet();
        this.element = null;
        this.lastListSig = "";
        this.lastStructSig = "";
    }

    private teardownSheet(): void {
        try {
            if (this._sheet) removeAdopted(this._sheet);
        } catch {
            /* */
        }
        this._sheet = null;
    }

    private renderEntries(): DocumentFragment {
        const fragment = document.createDocumentFragment();
        if (this.entries.length === 0) {
            fragment.appendChild(
                H`
                <div class="view-history__empty">
                    <span aria-hidden="true" style="font-size:2.5rem;opacity:.45">⏱</span>
                    <p>No transfers yet</p>
                </div>
            ` as HTMLElement
            );
            return fragment;
        }

        for (const entry of this.entries) {
            const muted = isMutedHistoryStatus(entry.status, entry.kind) ? " is-muted" : "";
            const acts = actionsForEntry(entry);
            const showProgress =
                entry.kind === "files" &&
                (entry.status === "progress" ||
                    (typeof entry.bytesDone === "number" &&
                        typeof entry.totalBytes === "number" &&
                        (entry.totalBytes || 0) > 0 &&
                        entry.status !== "expired"));
            const ratio = transferProgressRatio(entry);
            const pct = Math.round(ratio * 100);
            const speed = formatTransferSpeed(entry.speedBps);
            const kindLabel =
                entry.kind === "files"
                    ? "Files"
                    : entry.kind === "clipboard-image"
                      ? "Image"
                      : "Clipboard";
            const isImage = entry.kind === "clipboard-image";
            const thumbSrc = isImage ? historyImageSrc(entry) : "";
            const hasThumb = Boolean(thumbSrc);
            const sizeLabel = formatTransferBytes(entry.totalBytes);

            // WHY: fest/lure `H\`${array}\`` wraps arrays in Mapped; Mapped.element
            // returns only observable[0] when boundParent is set — so only the
            // first action button appeared. Append each button as a real child.
            let actionsEl: HTMLElement | "" = "";
            if (acts.length > 0) {
                const wrap = document.createElement("div");
                wrap.className = "view-history__item-actions";
                for (const a of acts) {
                    const btn = H`<button class="view-history__action-btn" type="button"
                        data-action="${a}" data-id="${entry.id}">
                        ${labelForAction(a, entry)}
                    </button>` as HTMLElement;
                    if (btn) wrap.appendChild(btn);
                }
                actionsEl = wrap;
            }

            const progressEl = showProgress
                ? H`
                <div class="view-history__progress">
                    <progress max="100" value="${pct}"></progress>
                    <span class="view-history__progress-meta">${pct}% · ${speed}${
                          entry.etaMs != null && entry.etaMs > 0
                              ? ` · ~${Math.ceil(entry.etaMs / 1000)}s`
                              : ""
                      }</span>
                </div>
            `
                : "";

            const mediaEl = isImage
                ? H`
                <div class="view-history__media">
                    ${
                        hasThumb
                            ? H`<img class="view-history__thumb" src="${thumbSrc}" alt="" loading="lazy" decoding="async" />`
                            : H`
                        <div class="view-history__thumb view-history__thumb--placeholder" aria-hidden="true">🖼</div>
                    `
                    }
                    <div class="view-history__media-meta">
                        <p class="view-history__item-desc">${entry.title}</p>
                        ${
                            entry.subtitle
                                ? H`<p class="view-history__item-sub">${entry.subtitle}</p>`
                                : sizeLabel
                                  ? H`<p class="view-history__item-sub">${sizeLabel}</p>`
                                  : ""
                        }
                        ${
                            !hasThumb
                                ? H`<p class="view-history__item-sub">Preview unavailable — Accept uses retained file when present</p>`
                                : ""
                        }
                    </div>
                </div>
            `
                : H`
                <p class="view-history__item-desc">${entry.title}</p>
                ${entry.subtitle ? H`<p class="view-history__item-sub">${entry.subtitle}</p>` : ""}
                ${
                    entry.textPreview
                        ? H`<pre class="view-history__item-preview">${entry.textPreview}</pre>`
                        : ""
                }
            `;

            const item = H`
                <div class="view-history__item${muted}${isImage ? " is-image" : ""}" data-entry="${entry.id}" data-status="${entry.status}" data-kind="${entry.kind}">
                    <div class="view-history__item-header">
                        <span class="view-history__item-action">
                            <span class="view-history__kind-chip" data-kind="${entry.kind}">${kindLabel}</span>
                            · ${entry.direction} · ${entry.status}
                        </span>
                        <span class="view-history__item-time">${this.formatTime(
                            entry.lastActionAt || entry.ts
                        )}${
                            entry.lastActionAt &&
                            entry.lastActionAt !== entry.ts
                                ? ` · arrived ${this.formatTime(entry.ts)}`
                                : ""
                        }</span>
                    </div>
                    ${mediaEl}
                    ${progressEl}
                    ${entry.error ? H`<p class="view-history__item-error">${entry.error}</p>` : ""}
                    ${actionsEl}
                </div>
            ` as HTMLElement;
            fragment.appendChild(item);
        }
        return fragment;
    }

    private setupEventHandlers(): void {
        if (!this.element) return;
        this.element.addEventListener("click", (e) => {
            void this.onClick(e);
        });
    }

    private async onClick(e: Event): Promise<void> {
        const target = e.target as HTMLElement;
        const button = target.closest("[data-action]") as HTMLButtonElement | null;
        if (!button) return;
        const action = button.dataset.action as TransferHistoryAction | "clear" | undefined;
        const entryId = button.dataset.id;
        if (action === "clear") {
            getTransferHistoryStore().clear();
            this.shellContext?.showMessage?.("History cleared");
            return;
        }
        if (!action || !entryId) return;
        const entry = this.entries.find((x) => x.id === entryId);
        if (!entry) return;
        button.disabled = true;
        try {
            const ok = await dispatchHistoryAction(entry, action);
            this.shellContext?.showMessage?.(ok ? `${labelForAction(action)} OK` : "Action failed");
        } finally {
            button.disabled = false;
        }
    }

    /** Full row signature including progress (skip when identical). */
    private listSignature(entries: TransferHistoryEntry[]): string {
        let sig = String(entries.length);
        for (const e of entries) {
            sig += `|${e.id}:${e.status}:${e.bytesDone ?? ""}:${e.speedBps ?? ""}:${e.lastActionAt ?? e.ts}`;
        }
        return sig;
    }

    /** Structure without progress — progress-only updates patch bars in place. */
    private structureSignature(entries: TransferHistoryEntry[]): string {
        let sig = String(entries.length);
        for (const e of entries) {
            const thumb = e.thumbDataUrl ? e.thumbDataUrl.length : e.localFilePath ? 1 : 0;
            sig += `|${e.id}:${e.status}:${e.kind}:${e.title}:${e.error ?? ""}:${thumb}`;
        }
        return sig;
    }

    private scheduleUpdateList(force: boolean): void {
        if (!this.visible || !this.element) return;
        if (force) {
            if (this.listRaf) {
                cancelAnimationFrame(this.listRaf);
                this.listRaf = 0;
            }
            this.updateList(true);
            return;
        }
        if (this.listRaf) return;
        this.listRaf = requestAnimationFrame(() => {
            this.listRaf = 0;
            this.updateList(false);
        });
    }

    /** WHY: live file transfers change bytes every poll — avoid full list remount. */
    private patchProgressOnly(): void {
        if (!this.element) return;
        for (const entry of this.entries) {
            // WHY: avoid CSS.escape dependency quirks; ids are store-owned tokens.
            const safeId = String(entry.id).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            const row = this.element.querySelector(
                `[data-entry="${safeId}"]`
            ) as HTMLElement | null;
            if (!row) continue;
            const ratio = transferProgressRatio(entry);
            const pct = Math.round(ratio * 100);
            const speed = formatTransferSpeed(entry.speedBps);
            const progress = row.querySelector("progress");
            const meta = row.querySelector(".view-history__progress-meta");
            if (progress) {
                progress.max = 100;
                progress.value = pct;
            }
            if (meta) {
                const eta =
                    entry.etaMs != null && entry.etaMs > 0
                        ? ` · ~${Math.ceil(entry.etaMs / 1000)}s`
                        : "";
                meta.textContent = `${pct}% · ${speed}${eta}`;
            }
            row.dataset.status = entry.status;
        }
    }

    private updateList(force = false): void {
        if (!this.visible) return;
        const list = this.element?.querySelector("[data-history-list]");
        if (!list) return;
        const fullSig = this.listSignature(this.entries);
        if (!force && fullSig === this.lastListSig) return;
        const structSig = this.structureSignature(this.entries);
        if (!force && structSig === this.lastStructSig && list.childElementCount > 0) {
            this.patchProgressOnly();
            this.lastListSig = fullSig;
            return;
        }
        this.lastListSig = fullSig;
        this.lastStructSig = structSig;
        list.replaceChildren();
        list.appendChild(this.renderEntries());
    }

    private formatTime(timestamp: number): string {
        const date = new Date(timestamp);
        const now = new Date();
        if (date.toDateString() === now.toDateString()) {
            return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        }
        return (
            date.toLocaleDateString([], { month: "short", day: "numeric" }) +
            " " +
            date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        );
    }

    reloadHistory(): void {
        this.refreshFromStore();
        this.scheduleUpdateList(true);
    }

    invokeChannelApi(action: string, _payload?: unknown): unknown {
        if (action === HistoryChannelAction.Reload || action === HistoryChannelAction.Refresh) {
            this.reloadHistory();
            return true;
        }
        return undefined;
    }

    canHandleMessage(): boolean {
        return false;
    }

    async handleMessage(): Promise<void> {}
}

function labelForAction(
    a: TransferHistoryAction | string,
    entry?: TransferHistoryEntry
): string {
    const isImage = entry?.kind === "clipboard-image";
    switch (a) {
        case "accept":
            return "Accept";
        case "dismiss":
            return "Dismiss";
        case "decline":
            return "Decline";
        case "open":
            return "Open";
        case "download":
            // WHY: images Save to disk; text/files keep Download label.
            return isImage ? "Save" : "Download";
        case "cancel":
            return "Cancel";
        case "reveal":
            return isImage ? "Show in folder" : "Open folder";
        case "share":
            // WHY: re-fan when peer/Neu was offline (toast Share parity).
            return "Share again";
        case "remove":
            return "Remove";
        default:
            return String(a);
    }
}

export function createView(options?: HistoryViewOptions): HistoryView {
    return new HistoryView(options);
}

export const createHistoryView = createView;
export default createView;
