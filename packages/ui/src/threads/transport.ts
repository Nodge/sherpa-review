import {
    deleteReviewComment,
    deleteReviewDraft,
    discardDraftBufferEntry,
    retryDraftBufferEntry,
    saveReviewDraft,
    setReviewCommentResolved,
    updateReviewComment,
    updateReviewDraft,
} from '../api.js';
import type { ComposerTransport } from './composer.js';

/** One composer transport for all views. The endpoints are the same, only the token differs. */
export function createComposerTransport(token: string): ComposerTransport {
    return {
        save: (draft, clientKey) => saveReviewDraft(token, draft, clientKey),
        update: (commentId, body, issue, clientKey) => updateReviewDraft(token, commentId, body, issue, clientKey),
        delete: (commentId) => deleteReviewDraft(token, commentId),
        discardBuffered: async (id) => {
            await discardDraftBufferEntry(token, id);
        },
        retryBuffered: async (id) => {
            await retryDraftBufferEntry(token, id);
        },
    };
}

/**
 * Writes to an already published comment: resolving its issue, editing and deleting it. They have no
 * draft buffer. Failure returns to the caller as an error.
 */
export interface PublishedCommentTransport {
    setResolved(commentId: string, resolved: boolean): Promise<void>;
    update(commentId: string, body: string, issue?: boolean): Promise<void>;
    delete(commentId: string): Promise<void>;
}

export function createPublishedCommentTransport(token: string): PublishedCommentTransport {
    return {
        setResolved: (commentId, resolved) => setReviewCommentResolved(token, commentId, resolved),
        update: (commentId, body, issue) => updateReviewComment(token, commentId, body, issue),
        delete: (commentId) => deleteReviewComment(token, commentId),
    };
}

const composerTransports = new WeakMap<PublishedCommentTransport, ComposerTransport>();

/**
 * Published comments use the same editor as drafts. The composer works through a transport,
 * so replacing it is enough. There is no creation here. The editor always
 * opens on an existing `commentId`. Published comments have no draft buffer, and the response is
 * always `saved`. Failure throws an error, which is shown below the message.
 */
export function publishedCommentComposerTransport(published: PublishedCommentTransport): ComposerTransport {
    const existing = composerTransports.get(published);
    if (existing !== undefined) {
        return existing;
    }
    const created: ComposerTransport = {
        save: () => Promise.reject(new Error('published comments are edited, not created')),
        update: async (commentId, body, issue) => {
            await published.update(commentId, body, issue);
            return { outcome: 'saved' };
        },
        delete: (commentId) => published.delete(commentId),
    };
    composerTransports.set(published, created);
    return created;
}
