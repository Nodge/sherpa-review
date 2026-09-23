/**
 * Serializes resolve/unresolve for one entity: the latest action always reaches the host
 * last. `id` is a thread on a host without `commentResolve`, or an individual issue comment on a host
 * with it. Both share the queue and rollback mechanism.
 */
export interface ResolvedWriterOptions {
    readonly read: (id: string) => boolean;
    /** Latest server value from the SSE snapshot, if the entity still exists. */
    readonly readConfirmed?: (id: string) => boolean | null;
    readonly apply: (id: string, resolved: boolean) => void;
    readonly rollback?: (id: string, resolved: boolean) => void;
    /** false means SSE has already confirmed the value and removed the optimistic layer. */
    readonly shouldRollback?: (id: string) => boolean;
    readonly send: (id: string, resolved: boolean) => Promise<void>;
}

export interface ResolvedWriter {
    /** Applies the value optimistically. false means the latest write failed. */
    readonly write: (id: string, resolved: boolean) => Promise<boolean>;
}

interface PendingWrite {
    readonly seq: number;
    chain: Promise<void>;
    confirmed: boolean;
}

const RESOLVED = Promise.resolve();
const persistentWriters = new WeakMap<object, Map<string, ResolvedWriter>>();

/**
 * The queue belongs to the long-lived store and survives a Full diff remount.
 * `scope` separates thread and comment queues: their ids are in different namespaces.
 */
export function resolvedWriterFor(key: object, scope: string, options: ResolvedWriterOptions): ResolvedWriter {
    const byScope = persistentWriters.get(key) ?? new Map<string, ResolvedWriter>();
    persistentWriters.set(key, byScope);
    const existing = byScope.get(scope);
    if (existing !== undefined) {
        return existing;
    }
    const created = createResolvedWriter(options);
    byScope.set(scope, created);
    return created;
}

export function createResolvedWriter(options: ResolvedWriterOptions): ResolvedWriter {
    const writes = new Map<string, PendingWrite>();
    let seq = 0;

    return {
        write: async (id, resolved) => {
            const previous = writes.get(id);
            const pending: PendingWrite = {
                seq: (seq += 1),
                confirmed: previous?.confirmed ?? options.read(id),
                chain: RESOLVED,
            };
            options.apply(id, resolved);

            const request = (previous?.chain ?? RESOLVED).then(async () => {
                pending.confirmed = previous?.confirmed ?? pending.confirmed;
                await options.send(id, resolved);
                pending.confirmed = resolved;
            });
            pending.chain = request.then(
                () => undefined,
                () => {
                    pending.confirmed = options.readConfirmed?.(id) ?? pending.confirmed;
                },
            );
            writes.set(id, pending);

            try {
                await request;
                return true;
            } catch {
                pending.confirmed = options.readConfirmed?.(id) ?? pending.confirmed;
                // An old failure must not erase a newer optimistic action.
                const latest = writes.get(id)?.seq === pending.seq;
                if (latest && options.shouldRollback?.(id) === false) {
                    // The POST response was lost, but SSE already confirmed the same value.
                    return true;
                }
                if (latest) {
                    (options.rollback ?? options.apply)(id, pending.confirmed);
                }
                return false;
            } finally {
                if (writes.get(id)?.seq === pending.seq) {
                    writes.delete(id);
                }
            }
        },
    };
}
