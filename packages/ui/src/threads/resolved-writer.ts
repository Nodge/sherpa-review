/** Serializes resolve/unresolve for a thread. The last action always reaches the host last. */
export interface ThreadResolvedWriterOptions {
    readonly read: (threadId: string) => boolean;
    /** Latest server value from the SSE snapshot, if the thread still exists. */
    readonly readConfirmed?: (threadId: string) => boolean | null;
    readonly apply: (threadId: string, resolved: boolean) => void;
    readonly rollback?: (threadId: string, resolved: boolean) => void;
    /** false means SSE has already confirmed the value and removed the optimistic layer. */
    readonly shouldRollback?: (threadId: string) => boolean;
    readonly send: (threadId: string, resolved: boolean) => Promise<void>;
}

export interface ThreadResolvedWriter {
    /** Applies the value optimistically. false means the latest write failed. */
    readonly write: (threadId: string, resolved: boolean) => Promise<boolean>;
}

interface PendingWrite {
    readonly seq: number;
    chain: Promise<void>;
    confirmed: boolean;
}

const RESOLVED = Promise.resolve();
const persistentWriters = new WeakMap<object, ThreadResolvedWriter>();

/** The queue belongs to the long-lived store and survives Full diff remounts. */
export function threadResolvedWriterFor(key: object, options: ThreadResolvedWriterOptions): ThreadResolvedWriter {
    const existing = persistentWriters.get(key);
    if (existing !== undefined) {
        return existing;
    }
    const created = createThreadResolvedWriter(options);
    persistentWriters.set(key, created);
    return created;
}

export function createThreadResolvedWriter(options: ThreadResolvedWriterOptions): ThreadResolvedWriter {
    const writes = new Map<string, PendingWrite>();
    let seq = 0;

    return {
        write: async (threadId, resolved) => {
            const previous = writes.get(threadId);
            const pending: PendingWrite = {
                seq: (seq += 1),
                confirmed: previous?.confirmed ?? options.read(threadId),
                chain: RESOLVED,
            };
            options.apply(threadId, resolved);

            const request = (previous?.chain ?? RESOLVED).then(async () => {
                pending.confirmed = previous?.confirmed ?? pending.confirmed;
                await options.send(threadId, resolved);
                pending.confirmed = resolved;
            });
            pending.chain = request.then(
                () => undefined,
                () => {
                    pending.confirmed = options.readConfirmed?.(threadId) ?? pending.confirmed;
                },
            );
            writes.set(threadId, pending);

            try {
                await request;
                return true;
            } catch {
                pending.confirmed = options.readConfirmed?.(threadId) ?? pending.confirmed;
                // An old failure must not erase a newer optimistic action.
                const latest = writes.get(threadId)?.seq === pending.seq;
                if (latest && options.shouldRollback?.(threadId) === false) {
                    // The POST response was lost, but SSE already confirmed the same value.
                    return true;
                }
                if (latest) {
                    (options.rollback ?? options.apply)(threadId, pending.confirmed);
                }
                return false;
            } finally {
                if (writes.get(threadId)?.seq === pending.seq) {
                    writes.delete(threadId);
                }
            }
        },
    };
}
