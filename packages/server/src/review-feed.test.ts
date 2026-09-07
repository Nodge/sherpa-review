import type { ReviewHost, Thread } from '@sherpa/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ReviewFeed } from './review-feed.js';

/**
 * Lazy subscription to host threads and a monotonic revision for SSE. The host is fake. What matters is
 * when the feed subscribes and advances its revision, not what the host sends.
 */

/** Stub thread. The feed only needs the snapshot to be serializable. */
function threadsOf(...ids: string[]): Thread[] {
    return ids.map((id) => ({ id }) as unknown as Thread);
}

interface FakeHost {
    readonly host: ReviewHost;
    /** Sends a thread snapshot as host polling would. */
    readonly emit: (threads: Thread[]) => void;
    readonly watchThreads: ReturnType<typeof vi.fn>;
    readonly unwatch: ReturnType<typeof vi.fn>;
}

function fakeHost(): FakeHost {
    let callback: ((threads: Thread[]) => void) | null = null;
    const unwatch = vi.fn(() => {
        callback = null;
    });
    const watchThreads = vi.fn((onThreads: (threads: Thread[]) => void) => {
        callback = onThreads;
        return unwatch;
    });
    return {
        host: { watchThreads } as unknown as ReviewHost,
        emit: (threads) => {
            if (callback === null) {
                throw new Error('the feed is not subscribed to the host, so there is no recipient');
            }
            callback(threads);
        },
        watchThreads,
        unwatch,
    };
}

describe('review feed', () => {
    it('subscribes to the host with the first listener and unsubscribes with the last', () => {
        const fake = fakeHost();
        const feed = new ReviewFeed(fake.host);

        expect(fake.watchThreads).not.toHaveBeenCalled();

        const release = feed.subscribe(() => undefined);
        expect(fake.watchThreads).toHaveBeenCalledTimes(1);
        expect(fake.unwatch).not.toHaveBeenCalled();

        release();
        expect(fake.unwatch).toHaveBeenCalledTimes(1);
    });

    it('two listeners share one host subscription, repeated unsubscribe leaves the other intact', () => {
        const fake = fakeHost();
        const feed = new ReviewFeed(fake.host);

        const first = feed.subscribe(() => undefined);
        const second = feed.subscribe(() => undefined);
        expect(fake.watchThreads).toHaveBeenCalledTimes(1);

        first();
        first();
        // The second listener remains. Releasing the first any number of times keeps the subscription.
        expect(fake.unwatch).not.toHaveBeenCalled();

        second();
        expect(fake.unwatch).toHaveBeenCalledTimes(1);
    });

    it('an identical snapshot keeps the revision and a changed one advances it', () => {
        const fake = fakeHost();
        const feed = new ReviewFeed(fake.host);
        const seen: number[] = [];
        feed.subscribe((revision) => seen.push(revision));

        fake.emit(threadsOf('t1'));
        expect(feed.revision).toBe(1);

        fake.emit(threadsOf('t1'));
        expect(feed.revision).toBe(1);

        fake.emit(threadsOf('t1', 't2'));
        expect(feed.revision).toBe(2);
        expect(seen).toEqual([1, 2]);
    });

    it('the latest snapshot survives a pause without listeners', () => {
        const fake = fakeHost();
        const feed = new ReviewFeed(fake.host);

        const release = feed.subscribe(() => undefined);
        fake.emit(threadsOf('t1'));
        expect(feed.revision).toBe(1);
        release();

        feed.subscribe(() => undefined);
        // The same snapshot after reconnect is not an event. Otherwise the UI would reread the endpoint needlessly.
        fake.emit(threadsOf('t1'));
        expect(feed.revision).toBe(1);

        fake.emit(threadsOf('t2'));
        expect(feed.revision).toBe(2);
    });

    it('an unserializable snapshot counts as a change', () => {
        const fake = fakeHost();
        const feed = new ReviewFeed(fake.host);
        feed.subscribe(() => undefined);

        const circular: Record<string, unknown> = { id: 't1' };
        circular.self = circular;
        const threads = [circular] as unknown as Thread[];

        fake.emit(threads);
        expect(feed.revision).toBe(1);
        // There is nothing to compare against, so count each such snapshot as new.
        fake.emit(threads);
        expect(feed.revision).toBe(2);
    });

    it('bumpLocalWrite wakes listeners and advances the revision', () => {
        const fake = fakeHost();
        const feed = new ReviewFeed(fake.host);
        const seen: number[] = [];
        feed.subscribe((revision) => seen.push(revision));

        expect(feed.bumpLocalWrite()).toBe(1);
        expect(feed.bumpLocalWrite()).toBe(2);
        expect(seen).toEqual([1, 2]);
        expect(feed.revision).toBe(2);
    });

    it('after close, subscribe is a no-op, the host stays stopped and the revision stays unchanged', () => {
        const fake = fakeHost();
        const feed = new ReviewFeed(fake.host);
        const seen: number[] = [];

        feed.subscribe((revision) => seen.push(revision));
        feed.bumpLocalWrite();
        feed.close();

        expect(fake.unwatch).toHaveBeenCalledTimes(1);

        const release = feed.subscribe((revision) => seen.push(revision));
        expect(fake.watchThreads).toHaveBeenCalledTimes(1);
        release();

        expect(feed.bumpLocalWrite()).toBe(1);
        expect(feed.revision).toBe(1);
        expect(seen).toEqual([1]);
    });

    it('the status subscription is lazy in the same way and stops with the thread subscription', () => {
        const fake = fakeHost();
        const unwatchStatus = vi.fn();
        const watchStatus = vi.fn((_onChange: () => void) => unwatchStatus);
        const onStatusChange = vi.fn();
        const feed = new ReviewFeed(fake.host, { watchStatus, onStatusChange });

        expect(watchStatus).not.toHaveBeenCalled();

        const release = feed.subscribe(() => undefined);
        expect(watchStatus).toHaveBeenCalledTimes(1);
        // The host gets exactly the handler passed to the feed.
        expect(watchStatus.mock.calls[0]?.[0]).toBe(onStatusChange);
        // The status subscription stays live while a listener remains.
        expect(unwatchStatus).not.toHaveBeenCalled();

        release();
        expect(unwatchStatus).toHaveBeenCalledTimes(1);
    });

    it('does not subscribe to status without onStatusChange', () => {
        const fake = fakeHost();
        const watchStatus = vi.fn(() => () => undefined);
        const feed = new ReviewFeed(fake.host, { watchStatus });

        feed.subscribe(() => undefined);

        expect(fake.watchThreads).toHaveBeenCalledTimes(1);
        expect(watchStatus).not.toHaveBeenCalled();
    });

    it('without a host, subscribe starts nothing and a local bump works', () => {
        const watchStatus = vi.fn(() => () => undefined);
        const onStatusChange = vi.fn();
        const feed = new ReviewFeed(null, { watchStatus, onStatusChange });
        const seen: number[] = [];

        const release = feed.subscribe((revision) => seen.push(revision));
        expect(watchStatus).not.toHaveBeenCalled();

        expect(feed.bumpLocalWrite()).toBe(1);
        expect(seen).toEqual([1]);

        release();
        feed.close();
    });
});
