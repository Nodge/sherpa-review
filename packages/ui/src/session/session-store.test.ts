import { describe, expect, it, vi } from 'vitest';

import { createSessionStore } from './session-store.js';

describe('session store', () => {
    it('returns a stable snapshot and changes it on setView', () => {
        const store = createSessionStore({ initial: { view: 'route' } });
        const first = store.getSnapshot();

        expect(store.getSnapshot()).toBe(first);

        store.setView('diff');
        expect(store.getSnapshot()).toEqual({ view: 'diff' });
    });

    it('notifies subscribers of changes and stays silent when the same value repeats', () => {
        const store = createSessionStore({ initial: { view: 'overview' } });
        const listener = vi.fn();
        store.subscribe(listener);

        store.setView('route');
        store.setView('route');

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('stops notifications after unsubscribing', () => {
        const store = createSessionStore({ initial: { view: 'overview' } });
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        unsubscribe();
        store.setView('diff');

        expect(listener).not.toHaveBeenCalled();
    });

    it('calls persist on each change with the new state', () => {
        const persist = vi.fn();
        const store = createSessionStore({ initial: { view: 'overview' }, persist });

        store.setView('diff');
        store.setView('diff');

        expect(persist.mock.calls).toEqual([[{ view: 'diff' }]]);
    });

    it('keeps the snapshot unchanged when nothing changes so useSyncExternalStore skips unnecessary renders', () => {
        const store = createSessionStore({ initial: { view: 'route' } });
        const before = store.getSnapshot();

        store.setView('route');

        expect(store.getSnapshot()).toBe(before);
    });
});
