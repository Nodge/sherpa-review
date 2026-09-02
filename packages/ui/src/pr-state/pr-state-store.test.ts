import type { UiPrState, UiPrStatePatch } from '@sherpa/protocol';
import { uiPrStateSchema } from '@sherpa/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    addRecentCommand,
    createUiPrStateStore,
    DEFAULT_UI_PR_STATE,
    PALETTE_RECENT_LIMIT,
    PR_STATE_SEND_DEBOUNCE_MS,
} from './pr-state-store.js';

/** Client-side PR state: optimistic updates, debounced writes, late boot-GET. */

function recording(): {
    readonly patches: UiPrStatePatch[];
    readonly keepalives: boolean[];
    readonly send: (patch: UiPrStatePatch, options?: { readonly keepalive?: boolean }) => Promise<UiPrState>;
} {
    const patches: UiPrStatePatch[] = [];
    const keepalives: boolean[] = [];
    return {
        patches,
        keepalives,
        send: (patch, options) => {
            patches.push(patch);
            keepalives.push(options?.keepalive === true);
            return Promise.resolve(merged(patch));
        },
    };
}

/** Endpoint response: the server always returns the full state after replacing the named fields. */
function merged(patch: UiPrStatePatch): UiPrState {
    return uiPrStateSchema.parse({ ...DEFAULT_UI_PR_STATE, ...patch });
}

/** Sending uses a promise chain, so microtasks need to run (even with fake timers). */
async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

afterEach(() => {
    vi.useRealTimers();
});

describe('UI state for this PR', () => {
    it('returns the contract defaults before loading', () => {
        expect(createUiPrStateStore().getSnapshot()).toEqual({
            treeCollapsed: {},
            diffCollapsed: {},
            paletteRecent: [],
        });
    });

    it('applies a change immediately and sends only the named field after a pause', async () => {
        vi.useFakeTimers();
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send });
        const seen: number[] = [];
        store.subscribe(() => seen.push(Object.keys(store.getSnapshot().treeCollapsed).length));

        store.update({ treeCollapsed: { 'src/api': true } });

        // Updates are synchronous: the tree collapses before any network request.
        expect(store.getSnapshot().treeCollapsed).toEqual({ 'src/api': true });
        expect(seen).toEqual([1]);
        expect(patches).toEqual([]);

        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS);
        await settle();
        expect(patches).toEqual([{ treeCollapsed: { 'src/api': true } }]);
    });

    it('sends two consecutive clicks in one request with the latest value', async () => {
        vi.useFakeTimers();
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send });

        store.update({ treeCollapsed: { 'src/api': true } });
        store.update({ treeCollapsed: { 'src/api': true, 'src/ui': true } });
        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS);
        await settle();

        expect(patches).toEqual([{ treeCollapsed: { 'src/api': true, 'src/ui': true } }]);
    });

    it('flush sends pending changes immediately and marks the request to survive the tab leaving', async () => {
        vi.useFakeTimers();
        const { patches, keepalives, send } = recording();
        const store = createUiPrStateStore({ send });

        store.update({ paletteRecent: ['diff.toggleMode'] });
        store.flush();
        await settle();

        expect(patches).toEqual([{ paletteRecent: ['diff.toggleMode'] }]);
        expect(keepalives).toEqual([true]);

        // The timer will not send the same changes again.
        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS * 2);
        await settle();
        expect(patches).toHaveLength(1);
    });

    it('flush sends nothing when no changes are pending', async () => {
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send });

        store.flush();
        await settle();

        expect(patches).toEqual([]);
    });

    it('does not send a repeated value', async () => {
        vi.useFakeTimers();
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send, initial: { diffCollapsed: { f1: true } } });

        store.update({ diffCollapsed: { f1: true } });
        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS);
        await settle();

        expect(patches).toEqual([]);
    });

    it('treats removing a map key as a change and sends the whole field', async () => {
        vi.useFakeTimers();
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send, initial: { treeCollapsed: { 'src/api': true } } });

        store.update({ treeCollapsed: {} });
        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS);
        await settle();

        expect(store.getSnapshot().treeCollapsed).toEqual({});
        expect(patches).toEqual([{ treeCollapsed: {} }]);
    });

    it('does not roll back collapse state when a write fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const store = createUiPrStateStore({ send: () => Promise.reject(new Error('server is silent')) });

        store.update({ diffCollapsed: { f1: true } });
        store.flush();
        await vi.waitFor(() => {
            expect(warn).toHaveBeenCalled();
        });

        expect(store.getSnapshot().diffCollapsed).toEqual({ f1: true });
        warn.mockRestore();
    });

    it('keeps writes in order', async () => {
        vi.useFakeTimers();
        const order: string[] = [];
        let releaseFirst!: () => void;
        const first = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const store = createUiPrStateStore({
            send: async (patch) => {
                const id = patch.paletteRecent?.[0] ?? '';
                if (id === 'a') {
                    await first;
                }
                order.push(id);
                return merged(patch);
            },
        });

        store.update({ paletteRecent: ['a'] });
        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS);
        await settle();
        store.update({ paletteRecent: ['b'] });
        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS);
        await settle();
        vi.useRealTimers();
        releaseFirst();
        await vi.waitFor(() => {
            expect(order).toHaveLength(2);
        });

        expect(order).toEqual(['a', 'b']);
    });

    it('flush resends a write the server has not acknowledged yet', async () => {
        vi.useFakeTimers();
        const patches: UiPrStatePatch[] = [];
        const keepalives: boolean[] = [];
        const store = createUiPrStateStore({
            send: (patch, sendOptions) => {
                patches.push(patch);
                keepalives.push(sendOptions?.keepalive === true);
                // A request that never arrived: exactly what leaving the tab does to a regular fetch.
                return new Promise<UiPrState>(() => undefined);
            },
        });

        store.update({ treeCollapsed: { 'src/api': true } });
        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS);
        await settle();
        expect(patches).toHaveLength(1);

        store.flush();
        await settle();

        expect(patches).toEqual([{ treeCollapsed: { 'src/api': true } }, { treeCollapsed: { 'src/api': true } }]);
        expect(keepalives).toEqual([false, true]);
    });

    it('flush does not wait for a hanging request and sends keepalive directly in the handler', () => {
        const patches: UiPrStatePatch[] = [];
        const store = createUiPrStateStore({
            send: (patch) => {
                patches.push(patch);
                return new Promise<UiPrState>(() => undefined);
            },
        });

        store.update({ paletteRecent: ['a'] });
        store.flush();
        store.update({ paletteRecent: ['b'] });
        store.flush();

        // No microtasks have run: the queue is stuck on the first request, and the tab is already leaving.
        expect(patches).toEqual([{ paletteRecent: ['a'] }, { paletteRecent: ['b'] }]);
    });

    it('does not resend changes acknowledged by the server', async () => {
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send });

        store.update({ paletteRecent: ['a'] });
        store.flush();
        await settle();
        store.flush();
        await settle();

        expect(patches).toHaveLength(1);
    });

    it('holds writes while boot-GET is in flight and sends them on top of server state', async () => {
        vi.useFakeTimers();
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send });
        let release!: (state: UiPrState) => void;
        const loaded = store.load(
            () =>
                new Promise<UiPrState>((resolve) => {
                    release = resolve;
                }),
        );

        store.update({ diffCollapsed: { f1: true } });
        vi.advanceTimersByTime(PR_STATE_SEND_DEBOUNCE_MS);
        await settle();
        // A map built from defaults would erase server keys, so no writes go out before the response.
        expect(patches).toEqual([]);

        release(uiPrStateSchema.parse({ diffCollapsed: { f2: true } }));
        await loaded;
        await settle();

        expect(store.getSnapshot().diffCollapsed).toEqual({ f2: true, f1: true });
        expect(patches).toEqual([{ diffCollapsed: { f2: true, f1: true } }]);
    });

    it('disables writes when boot-GET fails to preserve saved PR state', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send });

        await store.load(() => Promise.reject(new Error('server is not responding')));
        store.update({ diffCollapsed: { f1: true } });
        store.flush();
        await settle();

        // The reviewer sees the collapse state, but it stays local: the server still has other keys.
        expect(store.getSnapshot().diffCollapsed).toEqual({ f1: true });
        expect(patches).toEqual([]);
        warn.mockRestore();
    });

    it('preserves reviewer choices and server keys when loading server state', async () => {
        const store = createUiPrStateStore();
        store.update({ diffCollapsed: { f1: true }, paletteRecent: ['ui.toggleTree'] });

        await store.load(() =>
            Promise.resolve({
                treeCollapsed: { 'src/api': true },
                diffCollapsed: { f1: false, f2: true },
                paletteRecent: ['diff.toggleMode'],
            }),
        );

        expect(store.getSnapshot()).toEqual({
            // Untouched fields come entirely from the server.
            treeCollapsed: { 'src/api': true },
            // Merge the map by key: reviewer choices go on top, and other server keys stay.
            diffCollapsed: { f2: true, f1: true },
            // There is no way to merge the MRU list: the latest reviewer action wins.
            paletteRecent: ['ui.toggleTree'],
        });
    });

    it('does not treat loaded state as a local change or send it', async () => {
        const { patches, send } = recording();
        const store = createUiPrStateStore({ send });

        await store.load(() =>
            Promise.resolve({ treeCollapsed: { 'src/api': true }, diffCollapsed: {}, paletteRecent: [] }),
        );
        store.flush();
        await settle();

        expect(store.getSnapshot().treeCollapsed).toEqual({ 'src/api': true });
        expect(patches).toEqual([]);
    });

    it('keeps defaults without crashing the UI when the endpoint is unavailable', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const store = createUiPrStateStore();

        await store.load(() => Promise.reject(new Error('server is not responding')));

        expect(store.getSnapshot()).toEqual(DEFAULT_UI_PR_STATE);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

describe('recent palette commands', () => {
    it('puts the latest first without duplicating repeats', () => {
        expect(addRecentCommand(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
        expect(addRecentCommand(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    });

    it('keeps the length within the display limit', () => {
        const ids = Array.from({ length: PALETTE_RECENT_LIMIT + 2 }, (_, index) => `command-${String(index)}`);
        const recent = ids.reduce<string[]>((list, id) => addRecentCommand(list, id), []);

        expect(recent).toHaveLength(PALETTE_RECENT_LIMIT);
        expect(recent[0]).toBe(ids[ids.length - 1]);
    });
});
