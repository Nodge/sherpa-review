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
