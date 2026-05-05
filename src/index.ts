/**
 * History View
 * 
 * Shell-agnostic history component.
 * Shows operation history with replay/restore capabilities.
 */

import { H } from "fest/lure";
import { observe } from "fest/object";
import { loadAsAdopted, removeAdopted } from "fest/dom";
import type { View, ViewOptions, ViewLifecycle, ShellContext } from "shells/types";
import type { BaseViewOptions } from "views/types";
import { getItem, setItem } from "core/storage";
import { writeText as writeClipboardText } from "core/modules/Clipboard";
import { HistoryChannelAction } from "views/apis/channel-actions";

// @ts-ignore
import style from "./scss/history.scss?inline";

// ============================================================================
// TYPES
// ============================================================================

interface HistoryEntry {
    id: string;
    timestamp: number;
    action: string;
    description: string;
    content?: string;
    ok: boolean;
    error?: string;
}

const STORAGE_KEY = "rs-history";

// ============================================================================
// HISTORY VIEW
// ============================================================================

export class HistoryView implements View {
    id = "history" as const;
    name = "History";
    icon = "clock-counter-clockwise";

    private options: BaseViewOptions;
    private shellContext?: ShellContext;
    private element: HTMLElement | null = null;
    private entries = observe<HistoryEntry[]>([]);
    
    private _sheet: CSSStyleSheet | null = null;

    lifecycle: ViewLifecycle = {
        onUnmount: () => {
            try {
                if (this._sheet) removeAdopted(this._sheet);
            } catch {
                /* ignore */
            }
            this._sheet = null;
        },
        onShow: () => {
            this._sheet ??= loadAsAdopted(style) as CSSStyleSheet;
            this.loadHistory();
        },
        onHide: () => {
            try {
                if (this._sheet) removeAdopted(this._sheet);
            } catch {
                /* ignore */
            }
            this._sheet = null;
        },
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

        this.loadHistory();

        this.element = H`
            <div class="view-history">
                <div class="view-history__header">
                    <h1>History</h1>
                    <button class="view-history__clear-btn" data-action="clear" type="button">
                        <ui-icon icon="trash" icon-style="duotone"></ui-icon>
                        <span>Clear History</span>
                    </button>
                </div>
                <div class="view-history__list" data-history-list>
                    ${this.renderEntries()}
                </div>
            </div>
        ` as HTMLElement;

        this.setupEventHandlers();
        return this.element;
    }

    getToolbar(): HTMLElement | null {
        return null;
    }

    // ========================================================================
    // PRIVATE METHODS
    // ========================================================================

    private renderEntries(): HTMLElement | string {
        if (this.entries.length === 0) {
            return H`
                <div class="view-history__empty">
                    <ui-icon icon="clock-counter-clockwise" icon-style="duotone" size="48"></ui-icon>
                    <p>No history yet</p>
                </div>
            ` as HTMLElement;
        }

        const fragment = document.createDocumentFragment();
        for (const entry of [...this.entries].reverse()) {
            const item = H`
                <div class="view-history__item ${entry.ok ? '' : 'error'}" data-entry="${entry.id}">
                    <div class="view-history__item-header">
                        <span class="view-history__item-action">${entry.action}</span>
                        <span class="view-history__item-time">${this.formatTime(entry.timestamp)}</span>
                    </div>
                    <p class="view-history__item-desc">${entry.description}</p>
                    ${entry.error ? H`<p class="view-history__item-error">${entry.error}</p>` : ''}
                    ${entry.content ? H`
                        <div class="view-history__item-actions">
                            <button class="view-history__action-btn" data-action="copy" data-id="${entry.id}" type="button">
                                <ui-icon icon="copy" icon-style="duotone" size="14"></ui-icon>
                                Copy
                            </button>
                            <button class="view-history__action-btn" data-action="view" data-id="${entry.id}" type="button">
                                <ui-icon icon="eye" icon-style="duotone" size="14"></ui-icon>
                                View
                            </button>
                        </div>
                    ` : ''}
                </div>
            ` as HTMLElement;
            fragment.appendChild(item);
        }
        return fragment as unknown as HTMLElement;
    }

    private setupEventHandlers(): void {
        if (!this.element) return;

        this.element.addEventListener("click", async (e) => {
            const target = e.target as HTMLElement;
            const button = target.closest("[data-action]") as HTMLButtonElement | null;
            if (!button) return;

            const action = button.dataset.action;
            const entryId = button.dataset.id;

            if (action === "clear") {
                this.clearHistory();
            } else if (action === "copy" && entryId) {
                const entry = this.entries.find(e => e.id === entryId);
                if (entry?.content) {
                    try {
                        const result = await writeClipboardText(entry.content);
                        if (!result.ok) throw new Error(result.error || "Clipboard write failed");
                        this.showMessage("Copied to clipboard");
                    } catch {
                        this.showMessage("Failed to copy");
                    }
                }
            } else if (action === "view" && entryId) {
                const entry = this.entries.find(e => e.id === entryId);
                if (entry?.content) {
                    this.shellContext?.navigate("viewer", { content: entry.content });
                }
            }
        });
    }

    private loadHistory(): void {
        const saved = getItem<HistoryEntry[]>(STORAGE_KEY, []);
        this.entries.length = 0;
        this.entries.push(...saved);
        this.updateList();
    }

    /** Pull latest history entries from storage into the list UI. */
    reloadHistory(): void {
        this.loadHistory();
    }

    private clearHistory(): void {
        this.entries.length = 0;
        setItem(STORAGE_KEY, []);
        this.updateList();
        this.showMessage("History cleared");
    }

    private updateList(): void {
        const list = this.element?.querySelector("[data-history-list]");
        if (!list) return;
        list.replaceChildren();
        const rendered = this.renderEntries();
        if (typeof rendered !== 'string') {
            list.appendChild(rendered);
        }
    }

    private formatTime(timestamp: number): string {
        const date = new Date(timestamp);
        const now = new Date();
        
        if (date.toDateString() === now.toDateString()) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + 
               ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    private showMessage(message: string): void {
        this.shellContext?.showMessage(message);
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

// ============================================================================
// FACTORY
// ============================================================================

export function createView(options?: HistoryViewOptions): HistoryView {
    return new HistoryView(options);
}

/** Alias for createView */
export const createHistoryView = createView;

export default createView;
