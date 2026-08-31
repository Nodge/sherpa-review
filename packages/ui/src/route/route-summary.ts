import type { RouteSnapshot } from '@sherpa/protocol';

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

/** An old report does not apply to a new snapshot with the same stop IDs. */
export function routeFactsForSnapshot(
    snapshot: RouteSnapshot,
    viewed: ReadonlyMap<string, boolean>,
    reported: ReportedRouteSummary | null,
): RouteFacts {
    if (reported?.snapshotId === snapshot.snapshotId) {
        return reported.value;
    }

    const otherStopId = snapshot.stops.find((stop) => stop.tier === 'other')?.id ?? null;
    const trustViewedOther = reported === null;
    return {
        stopIds: snapshot.stops
            .filter((stop) => stop.tier !== 'other' || (trustViewedOther && viewed.get(stop.id) === true))
            .map((stop) => stop.id),
        otherStopId,
        uncoveredLines: null,
    };
}
