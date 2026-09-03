import type { ReviewHost, Thread } from '@sherpa/protocol';

/**
 * One server subscription to host threads and a monotonic revision for SSE (`UI_REVIEW_EVENT`).
 * The event omits the thread snapshot. The UI rereads the endpoint when the revision advances.
 *
 * Subscribes lazily with the first SSE client and stops with no clients. Otherwise host polling
 * would run with no clients (the server's idle shutdown does not count internal timers as activity,
 * see `idle.ts`).
 */
export interface ReviewFeedOptions {
    /**
     * Host-specific subscription to review status changes (M5-T15): the host exposes a status field
     * in the same lightweight poll. It lives in the feed because it must follow the same lazy lifecycle as threads.
     */
    readonly watchStatus?: (onChange: () => void) => () => void;
    /** On a status change, the server rereads PR metadata. */
    readonly onStatusChange?: () => void;
}

export class ReviewFeed {
    private readonly host: ReviewHost | null;
    private readonly watchStatus: ((onChange: () => void) => () => void) | null;
    private readonly onStatusChange: (() => void) | null;
    private readonly listeners = new Set<(revision: number) => void>();

    private revisionValue = 0;
    private unwatch: (() => void) | null = null;
    private unwatchStatus: (() => void) | null = null;
    /** Last seen snapshot survives unsubscription so reconnecting does not advance the revision falsely. */
    private lastSnapshot: string | null = null;
    private closed = false;

    constructor(host: ReviewHost | null, options: ReviewFeedOptions = {}) {
        this.host = host;
        this.watchStatus = options.watchStatus ?? null;
        this.onStatusChange = options.onStatusChange ?? null;
    }

    get revision(): number {
        return this.revisionValue;
    }

    /** A local write endpoint changed threads. Wake the UI without waiting for host polling. */
    bumpLocalWrite(): number {
        if (this.closed) {
            return this.revisionValue;
        }
        this.revisionValue += 1;
        for (const listener of [...this.listeners]) {
            listener(this.revisionValue);
        }
        return this.revisionValue;
    }

    subscribe(listener: (revision: number) => void): () => void {
        if (this.closed) {
            return () => undefined;
        }

        this.listeners.add(listener);
        this.start();

        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.listeners.delete(listener);
            if (this.listeners.size === 0) {
                this.stop();
            }
        };
    }

    /** Stops the subscription and releases listeners as the server shuts down. */
    close(): void {
        this.closed = true;
        this.listeners.clear();
        this.stop();
    }

    private start(): void {
        if (this.host === null || this.unwatch !== null) {
            return;
        }
        this.unwatch = this.host.watchThreads((threads) => {
            this.onThreads(threads);
        });
        const onStatusChange = this.onStatusChange;
        if (this.watchStatus !== null && onStatusChange !== null) {
            this.unwatchStatus = this.watchStatus(onStatusChange);
        }
    }

    private stop(): void {
        this.unwatch?.();
        this.unwatch = null;
        this.unwatchStatus?.();
        this.unwatchStatus = null;
    }

    private onThreads(threads: Thread[]): void {
        let snapshot: string;
        try {
            snapshot = JSON.stringify(threads);
        } catch {
            // The snapshot is unserializable. Counting it as changed is safer than swallowing it.
            snapshot = `unserializable#${String(this.revisionValue + 1)}`;
        }
        if (snapshot === this.lastSnapshot) {
            return;
        }

        this.lastSnapshot = snapshot;
        this.revisionValue += 1;
        for (const listener of [...this.listeners]) {
            listener(this.revisionValue);
        }
    }
}
