import { describe, expect, it } from 'vitest';

import { createStopProgressStore } from './stop-progress-store.js';

/** Stop marks: optimistic layer, rollback, and replacement with a server snapshot. */
describe('stop mark store', () => {
    it('notifies subscribers of a mark and replaces the entire state with a server snapshot', () => {
        const store = createStopProgressStore([{ stopId: 's01', viewed: true }]);
        let notified = 0;
        store.subscribe(() => {
            notified += 1;
        });

        expect(store.isViewed('s01')).toBe(true);
        store.setViewed('s02', true);
        expect(notified).toBe(1);

        store.setAll([{ stopId: 's03', viewed: true }]);

        expect(store.isViewed('s01')).toBe(false);
        expect(store.isViewed('s03')).toBe(true);
        expect(notified).toBe(2);
    });

    it('does not notify subscribers when repeating the same mark value', () => {
        const store = createStopProgressStore();
        let notified = 0;
        store.subscribe(() => {
            notified += 1;
        });

        store.setViewed('s01', true);
        store.setViewed('s01', true);

        expect(notified).toBe(1);
    });

    it('removes the key instead of writing false when rolling back to no record', () => {
        const store = createStopProgressStore();
        store.setViewed('s01', true);

        store.restore('s01', null);

        expect(store.getSnapshot().has('s01')).toBe(false);
        expect(store.isViewed('s01')).toBe(false);
    });
});
