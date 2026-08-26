import type { ComposerTransport } from './composer.js';
import { threadResolvedWriterFor } from './resolved-writer.js';
import type { ThreadStore } from './store.js';
import type { ThreadActions } from './thread-list.tsx';

/**
 * Thread actions over the store: drafts use the transport, resolve uses a writer with a queue
 * and rollback. Both full diff and route views build them the same way. Both views use
 * one store, and a second copy of this wiring would drift from the first.
 */
export function createThreadActions(
    store: ThreadStore,
    transport: ComposerTransport,
    resolve: (threadId: string, resolved: boolean) => Promise<void>,
): ThreadActions {
    const writer = threadResolvedWriterFor(store, {
        read: (threadId) => store.getSnapshot().threads.find((thread) => thread.id === threadId)?.resolved ?? false,
        readConfirmed: store.getServerResolved,
        apply: (threadId, resolved) => {
            store.setResolved(threadId, resolved);
        },
        rollback: store.restoreResolved,
        shouldRollback: (threadId) => store.hasResolvedOverride(threadId),
        send: resolve,
    });
    return { transport, resolve: writer.write };
}
