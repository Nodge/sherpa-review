import type { ComposerTransport } from './composer.js';
import { resolvedWriterFor } from './resolved-writer.js';
import type { ThreadStore } from './store.js';
import type { ThreadActions } from './thread-list.tsx';
import type { PublishedCommentTransport } from './transport.js';

/**
 * Thread actions over the store: drafts use the transport, resolve uses a writer with a queue
 * and rollback. Both full diff and route views build them the same way. Both views use
 * one store, and a second copy of this wiring would drift from the first.
 *
 * `published` handles writes to an already published comment (resolving its issue, editing,
 * deleting). Availability depends on `capabilities.commentResolve` and
 * `capabilities.editPublished`. Without them, the corresponding actions are absent from the UI.
 */
export interface PublishedCommentActions {
    readonly transport: PublishedCommentTransport;
    readonly commentResolve: boolean;
    readonly editPublished: boolean;
}

export function createThreadActions(
    store: ThreadStore,
    transport: ComposerTransport,
    resolve: (threadId: string, resolved: boolean) => Promise<void>,
    published?: PublishedCommentActions,
    commentIssues = false,
): ThreadActions {
    const writer = resolvedWriterFor(store, 'thread', {
        read: (threadId) => store.getSnapshot().threads.find((thread) => thread.id === threadId)?.resolved ?? false,
        readConfirmed: store.getServerResolved,
        apply: (threadId, resolved) => {
            store.setResolved(threadId, resolved);
        },
        rollback: store.restoreResolved,
        shouldRollback: (threadId) => store.hasResolvedOverride(threadId),
        send: resolve,
    });
    if (published === undefined) {
        return { transport, commentIssues, resolve: writer.write, resolveComment: null, published: null };
    }
    const commentWriter = resolvedWriterFor(store, 'comment', {
        read: store.getCommentResolved,
        readConfirmed: store.getServerCommentResolved,
        apply: store.setCommentResolved,
        rollback: store.restoreCommentResolved,
        shouldRollback: (commentId) => store.hasCommentResolvedOverride(commentId),
        send: (commentId, resolved) => published.transport.setResolved(commentId, resolved),
    });
    return {
        transport,
        commentIssues,
        resolve: writer.write,
        resolveComment: published.commentResolve ? commentWriter.write : null,
        published: published.editPublished ? published.transport : null,
    };
}
