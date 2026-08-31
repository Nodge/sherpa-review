import { UI_GONE_GRACE_SECONDS } from '@sherpa/protocol';

export interface UiPresenceOptions {
    /** Injectable clock: tests skip the minute-long grace period without actually waiting. */
    readonly now?: () => Date;
    /** Contract grace period for UI departure. Tests can shorten it through server composition. */
    readonly graceSeconds?: number;
}

/**
 * Reviewer presence via SSE: the UI is gone when its last connection has been closed longer than
 * the grace period. It cannot leave before the first connection. A returning UI starts the state over.
 */
export class UiPresence {
    private readonly now: () => Date;
    private readonly graceMs: number;
    private readonly listeners = new Set<() => void>();

    private connections = 0;
    private connectedBefore = false;
    private gone = false;
    private goneDeadline: number | null = null;
    private goneTimer: NodeJS.Timeout | null = null;
    private closed = false;

    constructor(options: UiPresenceOptions = {}) {
        this.now = options.now ?? ((): Date => new Date());
        this.graceMs = Math.max(options.graceSeconds ?? UI_GONE_GRACE_SECONDS, 0) * 1000;
    }

    /** Number of live UI SSE connections. */
    get connectionCount(): number {
        return this.connections;
    }

    /** The UI was connected and has been absent longer than the grace period. */
    get uiGone(): boolean {
        this.checkNow();
        return this.gone;
    }

    /** Tracks a live SSE connection. The returned function removes it exactly once. */
    connect(): () => void {
        if (this.closed) {
            return () => undefined;
        }

        this.connections += 1;
        this.connectedBefore = true;
        this.gone = false;
        this.goneDeadline = null;
        this.clearGoneTimer();

        let disconnected = false;
        return () => {
            if (disconnected || this.closed) {
                return;
            }
            disconnected = true;
            this.connections -= 1;
            if (this.connections === 0) {
                this.goneDeadline = this.now().getTime() + this.graceMs;
                this.scheduleGoneCheck();
                this.checkNow();
            }
        };
    }

    /** Subscribes to the `uiGone` transition and returns an unsubscribe function. */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Rechecks immediately: tests call this after advancing the injectable clock. */
    checkNow(): void {
        if (
            this.closed ||
            this.gone ||
            !this.connectedBefore ||
            this.connections > 0 ||
            this.goneDeadline === null ||
            this.now().getTime() < this.goneDeadline
        ) {
            return;
        }

        this.gone = true;
        this.goneDeadline = null;
        this.clearGoneTimer();
        for (const listener of [...this.listeners]) {
            listener();
        }
    }

    /** Stops the timer and clears subscriptions when the server shuts down. */
    close(): void {
        this.closed = true;
        this.clearGoneTimer();
        this.listeners.clear();
    }

    /** Production needs the timer. Tests with fake clocks call `checkNow()` themselves. */
    private scheduleGoneCheck(): void {
        this.clearGoneTimer();
        if (this.goneDeadline === null) {
            return;
        }

        const delay = Math.max(this.goneDeadline - this.now().getTime(), 0);
        const timer = setTimeout(() => {
            this.goneTimer = null;
            this.checkNow();
        }, delay);
        timer.unref();
        this.goneTimer = timer;
    }

    private clearGoneTimer(): void {
        if (this.goneTimer !== null) {
            clearTimeout(this.goneTimer);
            this.goneTimer = null;
        }
    }
}
