import { z } from 'zod';

import { commentDraftSchema, hostIdSchema } from './review.js';

/**
 * Draft buffer (`docs/architecture.md §6`, "drafts are never lost"): a composer record
 * accepted by the server but not yet delivered to the host. Lives in per-PR SQLite
 * (`draft_buffer`) and does not enter the UI thread store: it is field text, not a comment,
 * that survives tab reloads and host failures.
 *
 * Lifecycle: the UI sends `clientKey` with each save/update → the server writes the record
 * (`pending`) → tries the host → success: removes the record and sends `saved` to the UI. Failure:
 * the record stays `failed` with the error text, retried by the server timer or the button.
 */
export const draftBufferStateSchema = z.enum(['pending', 'failed']);
export type DraftBufferState = z.infer<typeof draftBufferStateSchema>;

export const draftBufferEntrySchema = z.object({
    /** Composer `clientKey`: a UUID the UI generates on the first save and keeps until success. */
    id: z.string().min(1),
    /**
     * What to write to the host. When editing an existing draft (`commentId !== null`),
     * only `body` and `issue` matter. `parentId`/`anchor` are null: the edit composer
     * appears beside its comment in the thread list and needs no anchor.
     */
    draft: commentDraftSchema,
    /** null means creation (`saveDraft`), otherwise editing an owned draft (`updateDraft`). */
    commentId: hostIdSchema.nullable(),
    state: draftBufferStateSchema,
    /** Latest host error text. null if no attempts have been made or the last one succeeded. */
    error: z.string().nullable(),
    attempts: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
});
export type DraftBufferEntry = z.infer<typeof draftBufferEntrySchema>;
