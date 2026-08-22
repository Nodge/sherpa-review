import { describe, expect, it, vi } from 'vitest';

import { createSessionStore } from './session-store.js';

describe('session store', () => {
    it('returns a stable snapshot and changes it on setView', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const first = store.getSnapshot();

        expect(store.getSnapshot()).toBe(first);

        store.setView('diff');
        expect(store.getSnapshot()).toEqual({ view: 'diff', filter: 'all' });
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

        expect(persist.mock.calls).toEqual([[{ view: 'diff', filter: 'all' }]]);
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
        const store = createSessionStore({ initial: { view: 'diff', filter: 'all' }, persist });

        store.setFilter('pci');

        expect(store.getSnapshot()).toEqual({ view: 'diff', filter: 'pci' });
        expect(persist.mock.calls).toEqual([[{ view: 'diff', filter: 'pci' }]]);
    });
});
