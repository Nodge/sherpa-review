import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DiffViewSnapshot } from '../../diff-view/store.js';
import { useT } from '../../i18n/index.js';
import type { ProgressWriter } from '../../progress/progress-writer.js';
import type { StopProgressStore } from '../../progress/stop-progress-store.js';
import type { RouteEntry, RouteModel } from '../../route/route-model.js';
import { entryParseFailed, entryPending, entryUnfilled, stopSeenRanges } from '../../route/route-model.js';
import { stopCoveredByProgress } from '../../route/stop-coverage.js';
import type { SessionStore } from '../../session/session-store.js';
import { entryId } from './stop-lookup.js';
import type { RequestJump } from './use-route-jump.js';

export interface StopViewedOptions {
    readonly model: RouteModel;
    /** The route is still being built: "Other" has nothing to mark yet, as it counts unfilled slots. */
    readonly filling: boolean;
    readonly stopViewed: ReadonlyMap<string, boolean>;
    /** Files in the lens. `null` means no lens. Automatic marking reports transitions only for visible content. */
    readonly fileIds: ReadonlySet<string> | null;
    readonly matches: (entry: RouteEntry, ids: ReadonlySet<string> | null) => boolean;
    readonly session: SessionStore;
    readonly stopProgress: StopProgressStore;
    readonly writer: ProgressWriter;
    /** The first server progress snapshot has been applied. Until then, there is nothing to compare coverage with. */
    readonly progressLoaded: boolean;
    readonly diffSnapshot: DiffViewSnapshot;
    readonly requestJump: RequestJump;
}

export interface StopViewed {
    readonly markStop: (stopId: string, viewed: boolean, withFeedback?: boolean) => Promise<void>;
    /** Failed write value by stop. A missing key means no writes have failed. */
    readonly stopFailures: ReadonlyMap<string, boolean>;
    readonly announcement: string;
    readonly unfilledEntry: (entry: RouteEntry) => boolean;
    readonly viewedStops: number;
}

/**
 * The viewed mark on a stop (SPEC §2.10, requirements §3.1): an explicit write with ranges,
 * automatic marking based on file-mark coverage, and an aria announcement of the result.
 */
export function useStopViewed({
    model,
    filling,
    stopViewed,
    fileIds,
    matches,
    session,
    stopProgress,
    writer,
    progressLoaded,
    diffSnapshot,
    requestJump,
}: StopViewedOptions): StopViewed {
    const t = useT();
    /**
     * Nothing to mark: the stop is unfilled, and "Other" on an unfinished route counts
     * everything the agent has not reached yet, rather than what remains in the model.
     */
    const unfilledEntry = useCallback(
        (entry: RouteEntry): boolean => entryUnfilled(entry) || (filling && entry.kind === 'other'),
        [filling],
    );
    const [stopFailures, setStopFailures] = useState<ReadonlyMap<string, boolean>>(EMPTY_FAILURES);
    const [announcement, setAnnouncement] = useState('');
    const autoMarking = useRef(new Set<string>());
    /** Last computed coverage: the first ready snapshot sets the baseline, without counting as a reviewer action. */
    const autoCoverage = useRef(new Map<string, boolean>());
    /** Clearing a mark by hand blocks automatic marking until coverage actually disappears. */
    const manuallyUnmarked = useRef(new Set<string>());
    const stopCoverageSnapshot = useMemo(
        () => ({ progress: diffSnapshot.progress, readState: diffSnapshot.readState }),
        [diffSnapshot.progress, diffSnapshot.readState],
    );
    const viewedStops = useMemo(
        () => model.entries.filter((entry) => stopViewed.get(entryId(entry)) === true).length,
        [model.entries, stopViewed],
    );
    const nextVisibleEntry = useCallback(
        (stopId: string): string | null => {
            const current = model.entries.findIndex((entry) => entryId(entry) === stopId);
            if (current < 0) {
                return null;
            }
            const next = model.entries.slice(current + 1).find((entry) => matches(entry, fileIds));
            return next === undefined ? null : entryId(next);
        },
        [fileIds, matches, model.entries],
    );

    const markStop = useCallback(
        async (stopId: string, viewed: boolean, withFeedback = true): Promise<void> => {
            const entry = model.entries.find((candidate) => entryId(candidate) === stopId) ?? null;
            const wasViewed = stopProgress.isViewed(stopId);
            if (entry === null || wasViewed === viewed) {
                return;
            }
            // A mark writes seen ranges, which can only be counted from parsed models:
            // before parsing, the mark would reach the server with an empty set and would not be rewritten later.
            // An unfilled stop has no ranges at all, and a file whose parsing failed
            // will have none until a retry. Clearing a mark does not require ranges.
            if (
                viewed &&
                (entryPending(entry, model.totals) ||
                    entryParseFailed(entry, model.totals) ||
                    unfilledEntry(entry))
            ) {
                return;
            }
            if (!viewed) {
                // Block before the optimistic update: its synchronous render will already see the cleared mark.
                manuallyUnmarked.current.add(stopId);
                // A viewed card's temporary expansion lasts only while the mark is set.
                session.forgetViewedExpansion(stopId);
            }
            setStopFailures((previous) => {
                if (!previous.has(stopId)) {
                    return previous;
                }
                const next = new Map(previous);
                next.delete(stopId);
                return next;
            });

            // The UI calculates ranges: the server has no diff model (decision log, 2026-08-26).
            const written = writer.writeStop(stopId, viewed, viewed ? stopSeenRanges(entry) : []);
            if (viewed && withFeedback) {
                const next = nextVisibleEntry(stopId);
                if (next !== null) {
                    // This continues collapsing, not stepping: keep the lens and the state of the next entry.
                    requestJump(next, null);
                }
            }
            if (withFeedback) {
                // The mark has already been applied optimistically, so announce what the reviewer sees on screen.
                const snapshot = stopProgress.getSnapshot();
                const count = model.entries.filter((candidate) => snapshot.get(entryId(candidate)) === true).length;
                setAnnouncement(
                    t(
                        viewed ? 'route.stop.announce.viewed' : 'route.stop.announce.unviewed',
                        entry.view.planLabel,
                        count,
                        model.stopCount,
                    ),
                );
            }
            if (!(await written)) {
                if (!viewed) {
                    manuallyUnmarked.current.delete(stopId);
                }
                setStopFailures((previous) => new Map(previous).set(stopId, viewed));
            }
        },
        [
            model.entries,
            model.stopCount,
            model.totals,
            nextVisibleEntry,
            requestJump,
            session,
            stopProgress,
            t,
            unfilledEntry,
            writer,
        ],
    );

    useEffect(() => {
        // Before the endpoint's first response, the store contains only defaults. That snapshot is not a baseline:
        // otherwise incoming server progress would look like new reading and trigger scrolling.
        if (!progressLoaded) {
            return;
        }

        const candidates: RouteEntry[] = [];
        const currentIds = new Set<string>();
        let feedbackStopId: string | null = null;

        for (const entry of model.entries) {
            const stopId = entryId(entry);
            currentIds.add(stopId);
            // While ranges cannot be counted correctly, this is not `false`: the first ready result
            // must become the baseline without turning data loading into a reviewer action.
            if (
                entryPending(entry, model.totals) ||
                entryParseFailed(entry, model.totals) ||
                unfilledEntry(entry)
            ) {
                continue;
            }

            const covered = stopCoveredByProgress(entry, stopCoverageSnapshot);
            const previous = autoCoverage.current.get(stopId);
            autoCoverage.current.set(stopId, covered);
            if (!covered) {
                manuallyUnmarked.current.delete(stopId);
                continue;
            }
            if (
                previous !== false ||
                stopViewed.get(stopId) === true ||
                manuallyUnmarked.current.has(stopId) ||
                autoMarking.current.has(stopId)
            ) {
                continue;
            }

            candidates.push(entry);
            if (matches(entry, fileIds)) {
                // Several marks in one snapshot produce one jump and one final aria announcement.
                feedbackStopId = stopId;
            }
        }

        for (const stopId of autoCoverage.current.keys()) {
            if (!currentIds.has(stopId)) {
                autoCoverage.current.delete(stopId);
                manuallyUnmarked.current.delete(stopId);
            }
        }

        const start = (entry: RouteEntry): void => {
            const stopId = entryId(entry);
            autoMarking.current.add(stopId);
            void markStop(stopId, true, stopId === feedbackStopId).finally(() => {
                autoMarking.current.delete(stopId);
            });
        };
        for (const entry of candidates) {
            if (entryId(entry) !== feedbackStopId) {
                start(entry);
            }
        }
        const feedbackEntry = candidates.find((entry) => entryId(entry) === feedbackStopId);
        if (feedbackEntry !== undefined) {
            start(feedbackEntry);
        }
    }, [
        fileIds,
        markStop,
        matches,
        model.entries,
        model.totals,
        progressLoaded,
        stopCoverageSnapshot,
        stopViewed,
        unfilledEntry,
    ]);

    return { markStop, stopFailures, announcement, unfilledEntry, viewedStops };
}

const EMPTY_FAILURES: ReadonlyMap<string, boolean> = new Map();
