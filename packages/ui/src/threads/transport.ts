import {
    deleteReviewDraft,
    discardDraftBufferEntry,
    retryDraftBufferEntry,
    saveReviewDraft,
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
