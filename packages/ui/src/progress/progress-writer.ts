import type { UiFileProgress, UiReviewProgressResponse, UiStopProgress, UiStopSeenRange } from '@sherpa/protocol';

/**
 * Coordinating "viewed" marks (T8, M2-T7): optimistic writes, a write queue per key,
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

export interface ProgressWriterOptions {
    readonly initialRevision: number;
    /** Current file record in the store. Rollback of the first write starts from here. */
    readonly read: (fileId: string) => UiFileProgress | null;
    /** Optimistic store mark, so the control responds without waiting for the network (SPEC §1.2). */
    readonly apply: (fileId: string, viewed: boolean) => void;
    readonly restore: (fileId: string, record: UiFileProgress | null) => void;
    /** Writes to the endpoint. Returns the progress revision after the write. */
    readonly send: (fileId: string, viewed: boolean) => Promise<number>;
    readonly stops: StopWriterHooks;
    /** Write completed: the view reconsiders its deferred refetch decision. */
    readonly onSettled: () => void;
}

/** Merged progress snapshot: server state with writes it missed overlaid on top. */
export interface MergedProgress {
    readonly files: readonly UiFileProgress[];
    readonly stops: readonly UiStopProgress[];
}

export interface ProgressWriter {
    /** File mark: update the store immediately, queue the endpoint write per file. `false` means the write failed. */
    readonly write: (fileId: string, viewed: boolean) => Promise<boolean>;
    /** Stop mark with its seen ranges. `false` means the write failed. */
    readonly writeStop: (
        stopId: string,
        viewed: boolean,
        ranges: readonly UiStopSeenRange[],
    ) => Promise<boolean>;
    /**
     * Whether to refetch the endpoint after an event with this revision. `null` means no channel revision
     * has been seen yet. A refetch is still needed if our own write with seen ranges requests it.
     */
    readonly shouldReload: (revision: number | null) => boolean;
    /** Refetch start marker: the endpoint response may miss writes made after it. */
    readonly beginReload: () => number;
    /** Endpoint response with writes that it missed added back in. */
    readonly finishReload: (response: UiReviewProgressResponse, mark: number) => MergedProgress;
}

/** Last server-confirmed state for a key, restored on rollback. */
type Confirmed =
    | { readonly scope: 'file'; readonly record: UiFileProgress | null }
    | { readonly scope: 'stop'; readonly viewed: boolean | null };

/** Optimistic mark on its way to the server. */
interface PendingWrite {
    readonly scope: Confirmed['scope'];
    readonly id: string;
    readonly viewed: boolean;
    /** Write sequence number, used to tell which of two writes is newer. */
    readonly seq: number;
    inFlight: boolean;
    confirmed: Confirmed;
    /** Tail of this key's write queue. Each write waits for the previous one. */
    chain: Promise<void>;
}

const RESOLVED: Promise<void> = Promise.resolve();

export function createProgressWriter(options: ProgressWriterOptions): ProgressWriter {
    const writes = new Map<string, PendingWrite>();
    let applied = options.initialRevision;
    let inFlight = 0;
    let seq = 0;
    /**
     * A stop mark sent seen ranges to the server, but the store cannot calculate them locally:
     * until the snapshot is reread, file read indicators would show the state before the mark.
     */
    let rangesPending = false;

    const restore = (pending: PendingWrite): void => {
        if (pending.confirmed.scope === 'file') {
            options.restore(pending.id, pending.confirmed.record);
        } else {
            options.stops.restore(pending.id, pending.confirmed.viewed);
        }
    };

    const enqueue = async (
        scope: Confirmed['scope'],
        id: string,
        viewed: boolean,
        initial: () => Confirmed,
        apply: () => void,
        send: () => Promise<number>,
        confirm: (previous: Confirmed) => Confirmed,
    ): Promise<boolean> => {
        const key = `${scope}\u0000${id}`;
        const previous = writes.get(key);
        const pending: PendingWrite = {
            scope,
            id,
            viewed,
            seq: (seq += 1),
            inFlight: true,
            confirmed: previous?.confirmed ?? initial(),
            chain: RESOLVED,
        };
        writes.set(key, pending);
        apply();
        inFlight += 1;

        // Writes for one key go to the server in strict order. Otherwise two quick toggles
        // could arrive in reverse order, leaving the first value in the database.
        const request = (previous?.chain ?? RESOLVED).then(async () => {
            const revision = await send();
            if (revision === applied + 1) {
                applied = revision;
            }
            pending.confirmed = confirm(pending.confirmed);
        });
        pending.chain = request.then(
            () => undefined,
            () => undefined,
        );

        try {
            await request;
            return true;
        } catch {
            // The optimistic write failed. The control returns to the last confirmed
            // state, but only if the reviewer has not marked it again. Otherwise rollback would erase
            // a mark already saved on the server.
            if (writes.get(key) === pending) {
                writes.delete(key);
                restore(pending);
            }
            return false;
        } finally {
            pending.inFlight = false;
            inFlight -= 1;
            options.onSettled();
        }
    };

    return {
        write: (fileId, viewed) =>
            enqueue(
                'file',
                fileId,
                viewed,
                () => ({ scope: 'file', record: options.read(fileId) }),
                () => {
                    options.apply(fileId, viewed);
                },
                () => options.send(fileId, viewed),
                (previous) => ({
                    scope: 'file',
                    record: {
                        fileId,
                        viewed,
                        seenRanges: previous.scope === 'file' ? (previous.record?.seenRanges ?? []) : [],
                    },
                }),
            ),

        writeStop: async (stopId, viewed, ranges) => {
            const written = await enqueue(
                'stop',
                stopId,
                viewed,
                () => ({ scope: 'stop', viewed: options.stops.read(stopId) }),
                () => {
                    options.stops.apply(stopId, viewed);
                },
                () => options.stops.send(stopId, viewed, ranges),
                () => ({ scope: 'stop', viewed }),
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
            for (const [key, pending] of [...writes]) {
                if (!pending.inFlight && pending.seq < mark) {
                    // The response fully reflects the write. The snapshot itself now represents its state.
                    writes.delete(key);
                    continue;
                }
                if (pending.scope === 'file') {
                    const server = files.get(pending.id) ?? null;
                    if (pending.inFlight) {
                        // The write is not confirmed yet. If it fails, roll back to this snapshot.
                        pending.confirmed = { scope: 'file', record: server };
                    }
                    // Otherwise a fresh mark would appear to roll back even though the server has it.
                    files.set(pending.id, { ...(server ?? { fileId: pending.id, seenRanges: [] }), viewed: pending.viewed });
                    continue;
                }
                const server = stops.get(pending.id) ?? null;
                if (pending.inFlight) {
                    pending.confirmed = { scope: 'stop', viewed: server?.viewed ?? null };
                }
                stops.set(pending.id, { stopId: pending.id, viewed: pending.viewed });
            }
            return { files: [...files.values()], stops: [...stops.values()] };
        },
    };
}
