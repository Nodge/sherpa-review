import { routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { routeFactsForSnapshot } from './route-summary.js';

const READY = routeFixtures('medium')?.states.ready?.snapshot ?? null;
if (READY === null) {
    throw new Error('medium fixture needs a ready route snapshot');
}
const SNAPSHOT: RouteSnapshot = READY;

describe('route counts for the action bar', () => {
    it('uses the exact report only for the same snapshot', () => {
        const report = {
            snapshotId: SNAPSHOT.snapshotId,
            value: { stopIds: ['s01', 'other'], otherStopId: 'other', uncoveredLines: 32 },
        };

        expect(routeFactsForSnapshot(SNAPSHOT, new Map(), report)).toEqual(report.value);
    });

    it('preserves viewed "Other" from server progress when no report exists', () => {
        expect(routeFactsForSnapshot(SNAPSHOT, new Map([['other', true]]), null).stopIds).toContain('other');
    });

    it('immediately discards previous stops and uncovered lines when the snapshot changes', () => {
        const next: RouteSnapshot = {
            ...SNAPSHOT,
            snapshotId: 'new-snapshot',
            stops: SNAPSHOT.stops.filter((stop) => stop.id !== 's01'),
        };
        const oldReport = {
            snapshotId: SNAPSHOT.snapshotId,
            value: { stopIds: ['s01', 'other'], otherStopId: 'other', uncoveredLines: 32 },
        };

        const facts = routeFactsForSnapshot(next, new Map([['other', true]]), oldReport);

        expect(facts.stopIds).not.toContain('s01');
        expect(facts.stopIds).not.toContain('other');
        expect(facts.otherStopId).toBe('other');
        expect(facts.uncoveredLines).toBeNull();
    });
});
