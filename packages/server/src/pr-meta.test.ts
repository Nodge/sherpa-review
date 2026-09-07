import { makeFixtureHost } from '@sherpa/fixtures';
import type { PrMeta, ReviewHost } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrMetaCache } from './pr-meta.js';

/**
 * The PR metadata cache returns null and retries until its first success, then stops polling
 * the host. Metadata comes from the fixture host: a valid `PrMeta` is too involved to build by hand.
 */

const RETRY_MS = 10;

describe('PR metadata cache', () => {
    let base: PrMeta;

    beforeEach(async () => {
        base = await makeFixtureHost('medium').getPr();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function metaWith(title: string): PrMeta {
        return { ...base, title };
    }

    /** A host with a replaceable `getPr`. The mock counts calls. */
    function hostOf(getPr: () => Promise<PrMeta>): { host: ReviewHost; getPr: ReturnType<typeof vi.fn> } {
        const mock = vi.fn(getPr);
        return { host: { getPr: mock } as unknown as ReviewHost, getPr: mock };
    }

    it('returns null and does not notify subscribers before the first success', async () => {
        const { host, getPr } = hostOf(() => Promise.reject(new Error('host is down')));
        const cache = new PrMetaCache({ host, retryIntervalMs: RETRY_MS });
        const woken = vi.fn();
        cache.subscribe(woken);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

        try {
            await cache.refresh();

            expect(cache.get()).toBeNull();
            expect(woken).not.toHaveBeenCalled();
            expect(getPr).toHaveBeenCalledTimes(1);
        } finally {
            stderr.mockRestore();
            cache.close();
        }
    });

    it('stores metadata and notifies subscribers exactly once on success', async () => {
        const { host } = hostOf(() => Promise.resolve(metaWith('first title')));
        const cache = new PrMetaCache({ host, retryIntervalMs: RETRY_MS });
        const woken = vi.fn();
        cache.subscribe(woken);

        try {
            await cache.refresh();

            expect(cache.get()?.title).toBe('first title');
            expect(woken).toHaveBeenCalledTimes(1);
        } finally {
            cache.close();
        }
    });

    it('retries the first failed load on a timer and stops polling after success', async () => {
        let attempt = 0;
        const { host, getPr } = hostOf(() => {
            attempt += 1;
            return attempt < 3 ? Promise.reject(new Error('timeout')) : Promise.resolve(metaWith('arrived'));
        });
        const cache = new PrMetaCache({ host, retryIntervalMs: RETRY_MS });
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

        try {
            cache.start();
            await vi.advanceTimersByTimeAsync(0);
            expect(cache.get()).toBeNull();

            await vi.advanceTimersByTimeAsync(RETRY_MS);
            expect(cache.get()).toBeNull();
            expect(getPr).toHaveBeenCalledTimes(2);

            await vi.advanceTimersByTimeAsync(RETRY_MS);
            expect(cache.get()?.title).toBe('arrived');
            expect(getPr).toHaveBeenCalledTimes(3);

            // The retry is cleared: the cache no longer reloads successful metadata on its own.
            await vi.advanceTimersByTimeAsync(RETRY_MS * 10);
            expect(getPr).toHaveBeenCalledTimes(3);
        } finally {
            stderr.mockRestore();
            cache.close();
        }
    });

    it('keeps previous metadata and writes to stderr when the response breaks the contract', async () => {
        let broken = false;
        const { host } = hostOf(() =>
            broken
                ? Promise.resolve({ ...metaWith('broken'), state: 'no such state' } as unknown as PrMeta)
                : Promise.resolve(metaWith('valid')),
        );
        const cache = new PrMetaCache({ host, retryIntervalMs: RETRY_MS });
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

        try {
            await cache.refresh();
            broken = true;
            await cache.refresh();

            expect(cache.get()?.title).toBe('valid');
            expect(stderr.mock.calls.some((call) => String(call[0]).includes('PR metadata update failed'))).toBe(
                true,
            );
        } finally {
            stderr.mockRestore();
            cache.close();
        }
    });

    it('does not let a late response from an older refresh overwrite newer metadata', async () => {
        const pending: { resolve: (meta: PrMeta) => void }[] = [];
        const { host } = hostOf(
            () =>
                new Promise<PrMeta>((resolve) => {
                    pending.push({ resolve });
                }),
        );
        const cache = new PrMetaCache({ host, retryIntervalMs: RETRY_MS });

        try {
            const first = cache.refresh();
            const second = cache.refresh();
            expect(pending).toHaveLength(2);

            // The second request started later and responded first, so it has the latest metadata.
            pending[1]?.resolve(metaWith('fresh'));
            await second;
            expect(cache.get()?.title).toBe('fresh');

            pending[0]?.resolve(metaWith('stale'));
            await first;
            expect(cache.get()?.title).toBe('fresh');
        } finally {
            cache.close();
        }
    });

    it('releases subscribers on close so an in-flight response cannot notify them', async () => {
        const pending: { resolve: (meta: PrMeta) => void }[] = [];
        const { host } = hostOf(
            () =>
                new Promise<PrMeta>((resolve) => {
                    pending.push({ resolve });
                }),
        );
        const cache = new PrMetaCache({ host, retryIntervalMs: RETRY_MS });
        const woken = vi.fn();
        cache.subscribe(woken);

        const inFlight = cache.refresh();
        cache.close();
        pending[0]?.resolve(metaWith('arrived after close'));
        await inFlight;

        // The cache still stores metadata (the request started before close), but no subscribers remain.
        expect(cache.get()?.title).toBe('arrived after close');
        expect(woken).not.toHaveBeenCalled();
    });

    it('clears the retry on close and stops requesting the host', async () => {
        const { host, getPr } = hostOf(() => Promise.reject(new Error('host is down')));
        const cache = new PrMetaCache({ host, retryIntervalMs: RETRY_MS });
        const woken = vi.fn();
        cache.subscribe(woken);
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

        try {
            cache.start();
            await vi.advanceTimersByTimeAsync(0);
            expect(getPr).toHaveBeenCalledTimes(1);

            cache.close();
            await vi.advanceTimersByTimeAsync(RETRY_MS * 10);

            expect(getPr).toHaveBeenCalledTimes(1);
            // A closed cache makes no host requests and notifies no subscribers.
            cache.start();
            await cache.refresh();
            expect(getPr).toHaveBeenCalledTimes(1);
            expect(woken).not.toHaveBeenCalled();
        } finally {
            stderr.mockRestore();
        }
    });

    it('keeps metadata null without a host, with harmless start and refresh calls', async () => {
        const cache = new PrMetaCache({ host: null, retryIntervalMs: RETRY_MS });
        const woken = vi.fn();
        cache.subscribe(woken);

        cache.start();
        await cache.refresh();
        await vi.advanceTimersByTimeAsync(RETRY_MS * 10);

        expect(cache.get()).toBeNull();
        expect(woken).not.toHaveBeenCalled();
        cache.close();
    });

    it('stops notifying an unsubscribed listener', async () => {
        const { host } = hostOf(() => Promise.resolve(metaWith('metadata')));
        const cache = new PrMetaCache({ host, retryIntervalMs: RETRY_MS });
        const stays = vi.fn();
        const leaves = vi.fn();
        cache.subscribe(stays);
        const release = cache.subscribe(leaves);

        try {
            release();
            await cache.refresh();

            expect(stays).toHaveBeenCalledTimes(1);
            expect(leaves).not.toHaveBeenCalled();
        } finally {
            cache.close();
        }
    });
});
