import type { UiFileProgress, UiReviewProgressResponse } from '@sherpa/protocol';

/**
 * Viewed mark coordination (T8): optimistic writes, a per-file write queue,
 * rollback on failure, and merging refetched snapshots with writes the endpoint may have missed.
 * Pure module: store and network operations come through callbacks, with no React dependency.
 *
 * The progress revision is shared across tabs, so the applied revision comes from the progress
 * endpoint response. Our own write advances it only when it follows the applied revision without a gap.
 * Otherwise another tab wrote a mark between them, and the snapshot must be reread.
 */

export interface ProgressWriterOptions {
    readonly initialRevision: number;
    /** Current file record in the store. Rollback of the first write starts from here. */
    readonly read: (fileId: string) => UiFileProgress | null;
    /** Optimistic store mark, so the control responds without waiting for the network (SPEC §1.2). */
    readonly apply: (fileId: string, viewed: boolean) => void;
    readonly restore: (fileId: string, record: UiFileProgress | null) => void;
    /** Writes to the endpoint. Returns the progress revision after the write. */
    readonly send: (fileId: string, viewed: boolean) => Promise<number>;
    /** Write completed: the view reconsiders its deferred refetch decision. */
    readonly onSettled: () => void;
}

export interface ProgressWriter {
    /** Mark: into the store immediately, into the endpoint through its file queue. `false` means the write failed. */
    readonly write: (fileId: string, viewed: boolean) => Promise<boolean>;
    /** Whether an event with this revision requires an endpoint reread. */
    readonly shouldReload: (revision: number) => boolean;
    /** Refetch start marker: the endpoint response may miss writes made after it. */
    readonly beginReload: () => number;
    /** Endpoint response with missed writes overlaid. `null` means the response is stale. */
    readonly finishReload: (response: UiReviewProgressResponse, mark: number) => UiFileProgress[] | null;
}

/** Optimistic mark on its way to the server. */
interface PendingWrite {
    readonly viewed: boolean;
    /** Write sequence number, used to tell which of two writes is newer. */
    readonly seq: number;
    inFlight: boolean;
    /** Last server-confirmed file state, restored on rollback. */
    confirmed: UiFileProgress | null;
    /** Tail of this file write queue. The next write goes out only after the previous one. */
    chain: Promise<void>;
}

const RESOLVED: Promise<void> = Promise.resolve();

export function createProgressWriter(options: ProgressWriterOptions): ProgressWriter {
    const writes = new Map<string, PendingWrite>();
    let applied = options.initialRevision;
    let inFlight = 0;
    let seq = 0;

    const write = async (fileId: string, viewed: boolean): Promise<boolean> => {
        const previous = writes.get(fileId);
        const pending: PendingWrite = {
            viewed,
            seq: (seq += 1),
            inFlight: true,
            confirmed: previous?.confirmed ?? options.read(fileId),
            chain: RESOLVED,
        };
        writes.set(fileId, pending);
        options.apply(fileId, viewed);
        inFlight += 1;

        // Writes for the same file reach the server strictly in order. Otherwise two quick toggles
        // could arrive in reverse order, leaving the first value in the database.
        const request = (previous?.chain ?? RESOLVED).then(async () => {
            const revision = await options.send(fileId, viewed);
            if (revision === applied + 1) {
                applied = revision;
            }
            pending.confirmed = { fileId, viewed, seenRanges: pending.confirmed?.seenRanges ?? [] };
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
            // state, but only if the reviewer has not marked the file again. Otherwise rollback would overwrite
            // a mark already saved on the server.
            if (writes.get(fileId) === pending) {
                writes.delete(fileId);
                options.restore(fileId, pending.confirmed);
            }
            return false;
        } finally {
            pending.inFlight = false;
            inFlight -= 1;
            options.onSettled();
        }
    };

    return {
        write,

        // While our write is in flight, its own event tells us nothing: the refetch decision
        // waits for the response, which tells us whether another tab wrote between the seen revision and ours.
        shouldReload: (revision) => inFlight === 0 && revision > applied,

        beginReload: () => seq + 1,

        finishReload: (response, mark) => {
            if (response.progressRevision < applied) {
                return null;
            }
            applied = response.progressRevision;

            const merged = new Map(response.files.map((record) => [record.fileId, record]));
            for (const [fileId, pending] of [...writes]) {
                if (!pending.inFlight && pending.seq < mark) {
                    // The response fully reflects the write. The snapshot itself now represents its state.
                    writes.delete(fileId);
                    continue;
                }
                const server = merged.get(fileId) ?? null;
                if (pending.inFlight) {
                    // The write is not confirmed yet. If it fails, roll back to this snapshot.
                    pending.confirmed = server;
                }
                // Otherwise a fresh mark would visually roll back even though it exists on the server.
                merged.set(fileId, { ...(server ?? { fileId, seenRanges: [] }), viewed: pending.viewed });
            }
            return [...merged.values()];
        },
    };
}
