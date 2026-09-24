import type { RouteSnapshot, RouteStop } from '@sherpa/protocol';

/**
 * Visibility of the synthetic Other stop (docs/design/SPEC-elements.md §4.3) follows one rule
 * throughout the UI. The server always includes it in the snapshot, already ready, but the reviewer sees it
 * only once the route is complete and it has something to show. Anything counting or listing
 * stops uses `visibleStops` or `otherStopVisible`.
 */

/** What is known about the contents of Other. */
export interface OtherStopFacts {
    /** Uncovered changed lines. `null` means not counted yet (patches are not parsed). */
    readonly uncovered: number | null;
    /** Conflict files. Only the Other row can report them (docs/design/SPEC-elements.md §4.1). */
    readonly conflictFiles: number;
}

/** Nothing is known. Other stays hidden until uncovered lines have been counted. */
export const UNKNOWN_OTHER: OtherStopFacts = { uncovered: null, conflictFiles: 0 };

/** The snapshot is still being built: at least one slot is neither ready nor failed. */
export function snapshotFilling(snapshot: RouteSnapshot): boolean {
    return snapshot.stops.some((stop) => stop.status === 'queued' || stop.status === 'filling');
}

/**
 * Other is visible once all other stops are complete (failure is also final, with that stop's
 * lines going to Other) and it contains uncovered lines or conflict files.
 * While the route is being built, uncovered lines are unfilled plan slots, not the model's remainder.
 */
export function otherStopVisible(snapshot: RouteSnapshot, facts: OtherStopFacts): boolean {
    if (snapshotFilling(snapshot)) {
        return false;
    }
    return (facts.uncovered ?? 0) > 0 || facts.conflictFiles > 0;
}

/**
 * The route is complete, but Other's visibility is unknown while the diff is being parsed. The stop count
 * cannot be stated yet because Other may add one more stop.
 */
export function otherStopPending(snapshot: RouteSnapshot, facts: OtherStopFacts): boolean {
    return !snapshotFilling(snapshot) && facts.uncovered === null && facts.conflictFiles === 0;
}

/** Snapshot stops visible to the reviewer, in `stops` array order. */
export function visibleStops(snapshot: RouteSnapshot, facts: OtherStopFacts): readonly RouteStop[] {
    const other = otherStopVisible(snapshot, facts);
    return other ? snapshot.stops : snapshot.stops.filter((stop) => stop.tier !== 'other');
}
