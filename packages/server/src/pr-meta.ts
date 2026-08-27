import type { PrMeta, ReviewHost } from '@sherpa/protocol';
import { prMetaSchema } from '@sherpa/protocol';

/** Retry interval for the initial metadata load until the host first responds. */
const RETRY_INTERVAL_MS = 30_000;

export interface PrMetaCacheOptions {
    /** null means the PR has no host adapter: metadata will stay null forever. */
    readonly host: ReviewHost | null;
    readonly retryIntervalMs?: number;
}

/**
 * PR metadata cache for the UI snapshot. `buildState` is synchronous (called by the SSE timer
 * and change pushes), while `getPr()` makes a network request to the host, so metadata loads outside
 * snapshot assembly: at server startup and after verdict publication. Until the first success, `get()` returns null and the UI
 * renders fallbacks. Each update notifies subscribers, sending the snapshot with new metadata over SSE.
 */
export class PrMetaCache {
    private readonly host: ReviewHost | null;
    private readonly retryIntervalMs: number;
    private readonly listeners = new Set<() => void>();
    private meta: PrMeta | null = null;
    private retry: ReturnType<typeof setTimeout> | null = null;
    private closed = false;
    /** Number of the latest issued `refresh()`, increasing in request start order. */
    private started = 0;
    /** Number of the request whose response is currently cached. */
    private applied = 0;

    constructor(options: PrMetaCacheOptions) {
        this.host = options.host;
        this.retryIntervalMs = options.retryIntervalMs ?? RETRY_INTERVAL_MS;
    }

    /** Synchronous source for `buildState`. */
    get(): PrMeta | null {
        return this.meta;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Initial metadata load with retries until the first success. Without it, the UI would keep the breadcrumb
     * fallback until a verdict was published. After success, the host is no longer polled,
     * Events that change metadata trigger its updates.
     */
    start(): void {
        if (this.host === null || this.closed) {
            return;
        }
        void this.refresh().then(() => {
            if (this.meta === null && !this.closed) {
                this.retry = setTimeout(() => {
                    this.retry = null;
                    this.start();
                }, this.retryIntervalMs);
                this.retry.unref();
            }
        });
    }

    /**
     * Reloads metadata from the host. Failures (network, token, response contract) are logged
     * and swallowed: the previous cached value stays on screen and the calling endpoint does not fail.
     */
    async refresh(): Promise<void> {
        if (this.host === null || this.closed) {
            return;
        }
        const generation = ++this.started;
        let meta: PrMeta;
        try {
            meta = prMetaSchema.parse(await this.host.getPr());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`sherpa-server: PR metadata update failed: ${message}\n`);
            return;
        }
        // Concurrent calls can finish out of order: the host has its own retries and timeouts,
        // so a request from start() can outlive the response to publication.
        // Discard a response whose request started before the one already applied. Otherwise
        // the pre-publication status would stay cached forever: the cache stops reloading itself after its first success.
        if (generation < this.applied) {
            return;
        }
        // The response may arrive after server shutdown: no subscribers remain by then,
        // so writing to the cache affects nobody.
        this.applied = generation;
        this.meta = meta;
        for (const listener of this.listeners) {
            listener();
        }
    }

    /** Clears the retry so it cannot fire after server shutdown. */
    close(): void {
        this.closed = true;
        if (this.retry !== null) {
            clearTimeout(this.retry);
            this.retry = null;
        }
        this.listeners.clear();
    }
}
