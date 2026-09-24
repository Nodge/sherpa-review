import { routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { UNKNOWN_OTHER } from './other-stop.js';
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

        expect(routeFactsForSnapshot(SNAPSHOT, report, UNKNOWN_OTHER)).toEqual(report.value);
    });

    it('omits "Other" without a report until uncovered ranges are counted or when the count is zero', () => {
        for (const other of [UNKNOWN_OTHER, { uncovered: 0, conflictFiles: 0 }]) {
            const facts = routeFactsForSnapshot(SNAPSHOT, null, other);

            expect(facts.stopIds).toEqual(
                SNAPSHOT.stops.filter((stop) => stop.tier !== 'other').map((stop) => stop.id),
            );
            expect(facts.otherStopId).toBeNull();
        }
    });

    it('includes nonempty "Other" in the stop set without a report', () => {
        const facts = routeFactsForSnapshot(SNAPSHOT, null, { uncovered: 38, conflictFiles: 0 });

        expect(facts.stopIds).toEqual(SNAPSHOT.stops.map((stop) => stop.id));
        expect(facts.otherStopId).toBe('other');
    });

    it('keeps "Other" for conflicted files even without a report because there is nowhere else to report them', () => {
        const facts = routeFactsForSnapshot(SNAPSHOT, null, { uncovered: null, conflictFiles: 2 });

        expect(facts.stopIds).toContain('other');
        expect(facts.otherStopId).toBe('other');
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

        const facts = routeFactsForSnapshot(next, oldReport, { uncovered: 0, conflictFiles: 0 });

        expect(facts.stopIds).not.toContain('s01');
        expect(facts.stopIds).not.toContain('other');
        expect(facts.otherStopId).toBeNull();
        expect(facts.uncoveredLines).toBeNull();
    });
});
