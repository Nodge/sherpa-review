import { describe, expect, it, vi } from 'vitest';

import { createSessionStore, DEFAULT_THREADS_SHOW } from './session-store.js';

describe('session store', () => {
    it('returns a stable snapshot and changes it on setView', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const first = store.getSnapshot();

        expect(store.getSnapshot()).toBe(first);

        store.setView('diff');
        expect(store.getSnapshot()).toEqual({
            view: 'diff',
            filter: 'all',
            threadsShow: DEFAULT_THREADS_SHOW,
            paletteOpen: false,
        });
    });

    it('notifies subscribers of changes and stays silent when the same value repeats', () => {
        const store = createSessionStore({ initial: { view: 'overview', filter: 'all' } });
        const listener = vi.fn();
        store.subscribe(listener);

        store.setView('route');
        store.setView('route');

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('stops notifications after unsubscribing', () => {
        const store = createSessionStore({ initial: { view: 'overview', filter: 'all' } });
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        unsubscribe();
        store.setView('diff');

        expect(listener).not.toHaveBeenCalled();
    });

    it('calls persist on each change with the new state', () => {
        const persist = vi.fn();
        const store = createSessionStore({ initial: { view: 'overview', filter: 'all' }, persist });

        store.setView('diff');
        store.setView('diff');

        expect(persist.mock.calls).toEqual([
            [{ view: 'diff', filter: 'all', threadsShow: DEFAULT_THREADS_SHOW, paletteOpen: false }],
        ]);
    });

    it('keeps the snapshot unchanged when nothing changes so useSyncExternalStore skips unnecessary renders', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const before = store.getSnapshot();

        store.setView('route');
        store.setFilter('all');

        expect(store.getSnapshot()).toBe(before);
    });

    it('changes the filter independently of the view and persists it too', () => {
        const persist = vi.fn();
        const store = createSessionStore({ initial: { view: 'diff', filter: 'all', threadsShow: DEFAULT_THREADS_SHOW }, persist });

        store.setFilter('pci');

        expect(store.getSnapshot()).toEqual({
            view: 'diff',
            filter: 'pci',
            threadsShow: DEFAULT_THREADS_SHOW,
            paletteOpen: false,
        });
        expect(persist.mock.calls).toEqual([
            [{ view: 'diff', filter: 'pci', threadsShow: DEFAULT_THREADS_SHOW, paletteOpen: false }],
        ]);
    });

    it('keeps palette open state in the session without changing other fields', () => {
        const store = createSessionStore({ initial: { view: 'diff', filter: 'all' } });

        store.setPaletteOpen(true);

        expect(store.getSnapshot()).toMatchObject({ view: 'diff', filter: 'all', paletteOpen: true });
    });

    it('thread filters change in a single session write', () => {
        const store = createSessionStore({ initial: { view: 'diff', filter: 'all' } });

        store.setThreadsShow({ people: true, bots: true, resolved: false });

        expect(store.getSnapshot().threadsShow).toEqual({ people: true, bots: true, resolved: false });
    });
});
