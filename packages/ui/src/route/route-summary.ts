import type { RouteSnapshot } from '@sherpa/protocol';

import type { OtherStopFacts } from './other-stop.js';
import { otherStopVisible, visibleStops } from './other-stop.js';

/** Counts for the completed route, computed after parsing the diff. */
export interface RouteSummary {
    /** Stops in render order, including "Other" if present. */
    readonly stopIds: readonly string[];
    readonly otherStopId: string | null;
    readonly uncoveredLines: number;
}

/** Route data for the action bar. `null` means exact counts are not available yet. */
export interface RouteFacts {
    readonly stopIds: readonly string[];
    readonly otherStopId: string | null;
    readonly uncoveredLines: number | null;
}

export interface ReportedRouteSummary {
    readonly snapshotId: string;
    readonly value: RouteSummary;
}

/**
 * Until the route view reports, the stop set consists of the snapshot's visible stops. An old report never applies to a new
 * snapshot.
 */
export function routeFactsForSnapshot(
    snapshot: RouteSnapshot,
    reported: ReportedRouteSummary | null,
    other: OtherStopFacts,
): RouteFacts {
    if (reported?.snapshotId === snapshot.snapshotId) {
        return reported.value;
    }

    return {
        stopIds: visibleStops(snapshot, other).map((stop) => stop.id),
        otherStopId: otherStopVisible(snapshot, other)
            ? (snapshot.stops.find((stop) => stop.tier === 'other')?.id ?? null)
            : null,
        uncoveredLines: null,
    };
}
