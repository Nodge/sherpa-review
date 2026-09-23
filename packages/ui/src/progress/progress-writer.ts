import type {
    UiFileProgress,
    UiReviewProgressResponse,
    UiSeenRange,
    UiStopProgress,
    UiStopSeenRange,
} from '@sherpa/protocol';

import { changeSeenRanges } from './read-state.js';

/**
 * Viewed-mark coordination: optimistic writes, one write queue,
 * rollback on failure, and merging refetched snapshots with writes the endpoint may have missed.
 * Pure module: store and network operations come through callbacks, with no React dependency.
 *
 * One writer handles file and stop marks: they share a progress revision, so separate
 * "applied" counters would diverge on the first write from another tab.
 *
 * The progress revision is shared across tabs, so the applied revision comes from the progress
 * endpoint response. Our own write advances it only when it follows the applied revision without a gap.
 * Otherwise another tab wrote between them, and the snapshot needs to be refetched. The revision is monotonic only within
 * one server lifetime: after a restart it begins at zero, and a lower number means a new server,
 * rather than an outdated response.
 */

/** Stop mark: the server remains the source of truth, and optimistic state is a single flag. */
export interface StopWriterHooks {
    /** Current stop mark in the store. `null` means no record (the stop is unviewed). */
    readonly read: (stopId: string) => boolean | null;
    readonly apply: (stopId: string, viewed: boolean) => void;
    readonly restore: (stopId: string, viewed: boolean | null) => void;
    /** Writes to the endpoint with UI-calculated ranges. Returns the progress revision. */
    readonly send: (stopId: string, viewed: boolean, ranges: readonly UiStopSeenRange[]) => Promise<number>;
}

/**
 * File mark within a stop: card ranges instead of a file pin. Rollback uses
 * `ProgressWriterOptions.restore` and `StopWriterHooks.restore`.
 */
export interface StopFileWriterHooks {
    readonly apply: (fileId: string, change: 'add' | 'remove', ranges: readonly UiSeenRange[]) => void;
    readonly send: (stopId: string, fileId: string, viewed: boolean, ranges: readonly UiSeenRange[]) => Promise<number>;
}

export interface ProgressWriterOptions {
    readonly initialRevision: number;
    /** Current file record in the store: writes replay on top of it during rollback. */
    readonly read: (fileId: string) => UiFileProgress | null;
    /** Optimistic mark in the store: the control responds without waiting for the network (docs/design/SPEC-elements.md §1.2). */
    readonly apply: (fileId: string, viewed: boolean) => void;
    readonly restore: (fileId: string, record: UiFileProgress | null) => void;
    /** Writes to the endpoint. Returns the progress revision after the write. */
    readonly send: (fileId: string, viewed: boolean) => Promise<number>;
    readonly stops: StopWriterHooks;
    readonly stopFiles: StopFileWriterHooks;
    /** Write completed: the view reconsiders its deferred refetch decision. */
    readonly onSettled: () => void;
}

/** Merged progress snapshot: server state with writes it missed overlaid on top. */
export interface MergedProgress {
    readonly files: readonly UiFileProgress[];
    readonly stops: readonly UiStopProgress[];
}

export interface ProgressWriter {
    /** File mark: immediate in the store, queued for the endpoint by the writer. `false` means the write failed. */
    readonly write: (fileId: string, viewed: boolean) => Promise<boolean>;
    /** Stop mark with its seen ranges. `false` means the write failed. */
    readonly writeStop: (
        stopId: string,
        viewed: boolean,
        ranges: readonly UiStopSeenRange[],
    ) => Promise<boolean>;
    /**
     * File mark within a stop: card lines in `ranges` are immediately added to the file record
     * or subtracted from it. Unmarking also clears the stop mark in the store. `false` means the write failed.
     */
    readonly writeStopFile: (
        stopId: string,
        fileId: string,
        viewed: boolean,
        ranges: readonly UiSeenRange[],
    ) => Promise<boolean>;
    /**
     * Whether to refetch the endpoint after an event with this revision. `null` means no channel revision
     * has been seen yet. A refetch is still needed if our own write with seen ranges requests it.
     */
    readonly shouldReload: (revision: number | null) => boolean;
    /** Refetch start marker: the endpoint response may miss writes made after it. */
    readonly beginReload: () => number;
    /**
     * Endpoint response with missed writes added. The writer knows nothing about the response iteration:
     * the caller checks it against the displayed diff before this call.
     */
    readonly finishReload: (
        response: Pick<UiReviewProgressResponse, 'files' | 'stops' | 'progressRevision'>,
        mark: number,
    ) => MergedProgress;
}

/**
 * A mark the server snapshot may have missed: in flight or already accepted by the endpoint.
 * One write can affect both a file and a stop: unmarking a card clears the stop mark.
 */
interface Write {
    readonly seq: number;
    /** The endpoint reported success. */
    done: boolean;
    readonly file: { readonly id: string; readonly change: (record: UiFileProgress | null) => UiFileProgress } | null;
    readonly stop: { readonly id: string; readonly viewed: boolean } | null;
}

const noop = (): void => undefined;

export function createProgressWriter(options: ProgressWriterOptions): ProgressWriter {
    /**
     * Writes overlaid on the last known server state in queue order. On screen,
     * a file or stop shows the base with its relevant writes replayed. A failed
     * write drops out, and the screen replays without it. Rolling back to the snapshot taken when the write was queued
     * does not work here: if another write for the same file failed later, it would restore another write's
     * unacknowledged ranges.
     */
    let writes: Write[] = [];
    /** Server state beneath the writes, captured when the first write touches the id. */
    const fileBases = new Map<string, UiFileProgress | null>();
    const stopBases = new Map<string, boolean | null>();
    /**
     * Queue tail: a write reaches the server only after the previous response, whatever its outcome. The file,
     * stop, and card endpoints overlap in their server-side ranges, and manual clicks are rare. A shared
     * order costs less than resolving overlaps.
     */
    let queue: Promise<void> = Promise.resolve();
    let applied = options.initialRevision;
    let inFlight = 0;
    let seq = 0;
    /**
     * The server changed seen ranges (marking a stop or card, unmarking a file) in a way the store
     * cannot calculate itself, so the snapshot needs to be refetched.
     */
    let rangesPending = false;

    const replayFile = (fileId: string): UiFileProgress | null =>
        writes.reduce(
            (record, write) => (write.file?.id === fileId ? write.file.change(record) : record),
            fileBases.get(fileId) ?? null,
        );
    const replayStop = (stopId: string): boolean | null =>
        writes.reduce(
            (viewed, write) => (write.stop?.id === stopId ? write.stop.viewed : viewed),
            stopBases.get(stopId) ?? null,
        );

    /** Remove the base when no writes overlay it: the store for this id is server state again. */
    const prune = (): void => {
        for (const fileId of fileBases.keys()) {
            if (!writes.some((write) => write.file?.id === fileId)) {
                fileBases.delete(fileId);
            }
        }
        for (const stopId of stopBases.keys()) {
            if (!writes.some((write) => write.stop?.id === stopId)) {
                stopBases.delete(stopId);
            }
        }
    };

    const enqueue = async (
        target: Pick<Write, 'file' | 'stop'>,
        apply: () => void,
        send: () => Promise<number>,
    ): Promise<boolean> => {
        const write: Write = { seq: (seq += 1), done: false, ...target };
        if (write.file !== null && !fileBases.has(write.file.id)) {
            fileBases.set(write.file.id, options.read(write.file.id));
        }
        if (write.stop !== null && !stopBases.has(write.stop.id)) {
            stopBases.set(write.stop.id, options.stops.read(write.stop.id));
        }
        writes.push(write);
        apply();
        inFlight += 1;

        const request = queue.then(async () => {
            const revision = await send();
            if (revision === applied + 1) {
                applied = revision;
            }
            write.done = true;
        });
        queue = request.then(noop, noop);

        try {
            await request;
            return true;
        } catch {
            writes = writes.filter((candidate) => candidate !== write);
            if (write.file !== null) {
                options.restore(write.file.id, replayFile(write.file.id));
            }
            if (write.stop !== null) {
                options.stops.restore(write.stop.id, replayStop(write.stop.id));
            }
            prune();
            return false;
        } finally {
            inFlight -= 1;
            options.onSettled();
        }
    };

    return {
        write: async (fileId, viewed) => {
            const written = await enqueue(
                {
                    file: { id: fileId, change: (record) => ({ ...(record ?? { fileId, seenRanges: [] }), viewed }) },
                    stop: null,
                },
                () => {
                    options.apply(fileId, viewed);
                },
                () => options.send(fileId, viewed),
            );
            if (written && !viewed) {
                rangesPending = true;
            }
            return written;
        },

        writeStop: async (stopId, viewed, ranges) => {
            const written = await enqueue(
                { file: null, stop: { id: stopId, viewed } },
                () => {
                    options.stops.apply(stopId, viewed);
                },
                () => options.stops.send(stopId, viewed, ranges),
            );
            if (written) {
                rangesPending = true;
            }
            return written;
        },

        writeStopFile: async (stopId, fileId, viewed, ranges) => {
            const unmarksStop = !viewed && options.stops.read(stopId) === true;
            const change = viewed ? 'add' : 'remove';
            const written = await enqueue(
                {
                    file: {
                        id: fileId,
                        change: (record) => {
                            const base = record ?? { fileId, viewed: null, seenRanges: [] };
                            return { ...base, seenRanges: changeSeenRanges(base.seenRanges, change, ranges) };
                        },
                    },
                    stop: unmarksStop ? { id: stopId, viewed: false } : null,
                },
                () => {
                    options.stopFiles.apply(fileId, change, ranges);
                    if (unmarksStop) {
                        options.stops.apply(stopId, false);
                    }
                },
                () => options.stopFiles.send(stopId, fileId, viewed, viewed ? ranges : []),
            );
            if (written) {
                rangesPending = true;
            }
            return written;
        },

        // While our write is in flight, its own event tells us nothing: the refetch decision
        // waits for the response, which tells us whether another tab wrote between the seen revision and ours.
        // Our own write with ranges requests a refetch itself, without waiting for a channel event. Without
        // a refetch, the read-state boxes would keep their state from before the mark.
        // Compare revisions for inequality, rather than "greater than": a server restart resets the counter,
        // so a lower number means a new server, rather than an outdated event. A "greater than"
        // check would ignore other tabs' marks until the new counter caught up with the old one.
        shouldReload: (revision) =>
            inFlight === 0 && (rangesPending || (revision !== null && revision !== applied)),

        beginReload: () => seq + 1,

        finishReload: (response, mark) => {
            // Accept the endpoint response with any revision, including one below the last seen: the revision
            // is monotonic only within one server lifetime and starts over
            // after a restart. Checking "response newer than last seen" would discard every snapshot from the new server,
            // freezing the screen until the tab reloads. Writes the response missed
            // go on top below. They ensure freshness, rather than the revision number.
            applied = response.progressRevision;
            rangesPending = false;

            const files = new Map(response.files.map((record) => [record.fileId, record]));
            const stops = new Map(response.stops.map((record) => [record.stopId, record]));
            // A write accepted before refetching began is fully reflected in the response, so the snapshot
            // now represents its state. Other writes go on top: otherwise a fresh mark would visually
            // roll back even though it exists on the server, while a failed write rolls back to this snapshot.
            writes = writes.filter((write) => !(write.done && write.seq < mark));
            prune();
            for (const fileId of fileBases.keys()) {
                fileBases.set(fileId, files.get(fileId) ?? null);
                const record = replayFile(fileId);
                if (record !== null) {
                    files.set(fileId, record);
                }
            }
            for (const stopId of stopBases.keys()) {
                stopBases.set(stopId, stops.get(stopId)?.viewed ?? null);
                const viewed = replayStop(stopId);
                if (viewed !== null) {
                    stops.set(stopId, { stopId, viewed });
                }
            }
            return { files: [...files.values()], stops: [...stops.values()] };
        },
    };
}
