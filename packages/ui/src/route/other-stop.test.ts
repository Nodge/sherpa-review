import { routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, RouteStopStatus } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { otherStopVisible, snapshotFilling, UNKNOWN_OTHER, visibleStops } from './other-stop.js';

const READY = routeFixtures('medium')?.states.ready?.snapshot ?? null;
if (READY === null) {
    throw new Error('medium fixture needs a ready route snapshot');
}
const SNAPSHOT: RouteSnapshot = READY;

/** A ready snapshot with a different status for its first stop. */
function withFirstStatus(status: RouteStopStatus): RouteSnapshot {
    return {
        ...SNAPSHOT,
        stops: SNAPSHOT.stops.map((stop, index) => (index === 0 ? { ...stop, status } : stop)),
    };
}

describe('Other visibility', () => {
    it('hides Other while the route is being built even if uncovered lines exist', () => {
        expect(snapshotFilling(withFirstStatus('filling'))).toBe(true);
        expect(otherStopVisible(withFirstStatus('filling'), { uncovered: 120, conflictFiles: 0 })).toBe(false);
        expect(otherStopVisible(withFirstStatus('queued'), { uncovered: 120, conflictFiles: 1 })).toBe(false);
    });

    it('hides Other in a completed route without uncovered lines', () => {
        expect(otherStopVisible(SNAPSHOT, { uncovered: 0, conflictFiles: 0 })).toBe(false);
    });

    it('hides Other until uncovered lines have been counted', () => {
        expect(otherStopVisible(SNAPSHOT, UNKNOWN_OTHER)).toBe(false);
    });

    it('shows Other in a completed route with uncovered lines', () => {
        expect(otherStopVisible(SNAPSHOT, { uncovered: 1, conflictFiles: 0 })).toBe(true);
    });

    it('treats a failed section as completed and sends its lines to Other', () => {
        const failed = withFirstStatus('failed');
        expect(snapshotFilling(failed)).toBe(false);
        expect(otherStopVisible(failed, { uncovered: 40, conflictFiles: 0 })).toBe(true);
    });

    it('keeps Other for conflict files even with zero uncovered lines', () => {
        expect(otherStopVisible(SNAPSHOT, { uncovered: 0, conflictFiles: 1 })).toBe(true);
    });

    it('removes hidden Other from the stop list without renumbering the rest', () => {
        const hidden = visibleStops(SNAPSHOT, { uncovered: 0, conflictFiles: 0 });
        const shown = visibleStops(SNAPSHOT, { uncovered: 5, conflictFiles: 0 });

        expect(hidden.map((stop) => stop.tier)).not.toContain('other');
        expect(shown).toEqual(SNAPSHOT.stops);
        expect(hidden.map((stop) => stop.planIndex)).toEqual(shown.slice(0, -1).map((stop) => stop.planIndex));
        // Other has the last plan number, so removing it leaves no gaps in the numbering.
        expect(shown.at(-1)?.tier).toBe('other');
        expect(shown.at(-1)?.planIndex).toBe(Math.max(...SNAPSHOT.stops.map((stop) => stop.planIndex)));
    });
});
