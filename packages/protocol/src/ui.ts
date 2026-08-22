import { z } from 'zod';

import { prKeySchema } from './manifest.js';
import { workerStatusSchema } from './messages.js';
import { fileContentSchema, hostIdSchema, lensSchema, prDiffSchema, prMetaSchema, threadSchema } from './review.js';
import { priorityClassSchema, taskIdSchema, taskTypeSchema } from './task.js';

/**
 * UI↔server contract (rpc-design §2): REST for actions, SSE for reactivity.
 * The UI consumes nothing that has not passed these schemas, fail-closed on both sides.
 */

/** Task lifecycle (rpc-design §5). Terminal statuses (`done`/`failed`/`cancelled`) are irreversible. */
export const taskStatusSchema = z.enum(['queued', 'leased', 'done', 'failed', 'cancelled']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * Task as seen by the UI, contract fields plus lifecycle.
 * Server internals (context file paths, lease workerId) stay private.
 */
export const uiTaskSchema = z.object({
    id: taskIdSchema,
    type: taskTypeSchema,
    priority: priorityClassSchema,
    status: taskStatusSchema,
    attempt: z.number().int().min(1),
    /** Task prompt, shown by the UI as "what was requested". */
    instructions: z.string(),
    progressText: z.string().nullable(),
    result: z.string().nullable(),
    failReason: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
});
export type UiTask = z.infer<typeof uiTaskSchema>;

/**
 * PR state snapshot for the UI. Returned by `GET state` and sent in full by the SSE channel
 * on every change. The queue is small in M0, so granular events are not worth the cost.
 */
export const uiStateSchema = z.object({
    prKey: prKeySchema,
    worker: workerStatusSchema,
    tasks: z.array(uiTaskSchema),
    /**
     * Name of this PR's host adapter (`fixture`). null means prKey maps to no host,
     * so review endpoints are unavailable (an M0-style server only has the queue).
     */
    reviewHost: z.string().nullable(),
});
export type UiState = z.infer<typeof uiStateSchema>;

/** Enqueues a task from the UI. M0 has only `echo`: the worker returns the text as the result. */
export const uiEnqueueRequestSchema = z.object({
    type: taskTypeSchema,
    text: z.string().min(1).max(4000),
    /** Defaults to `interactive`, since the reviewer is waiting at the screen. */
    priority: priorityClassSchema.optional(),
});
export type UiEnqueueRequest = z.infer<typeof uiEnqueueRequestSchema>;

export const uiEnqueueResponseSchema = z.object({ task: uiTaskSchema });
export type UiEnqueueResponse = z.infer<typeof uiEnqueueResponseSchema>;

/** Cancels a task from the UI (rpc-design §5). A leased task is marked cancelled. The worker learns on its next call. */
export const uiCancelRequestSchema = z.object({ taskId: taskIdSchema });
export type UiCancelRequest = z.infer<typeof uiCancelRequestSchema>;

export const uiCancelResponseSchema = z.object({ outcome: z.enum(['cancelled', 'noop']) });
export type UiCancelResponse = z.infer<typeof uiCancelResponseSchema>;

/**
 * PR review data (M1-T10). Separate endpoints keep diffs and threads out of `uiState`.
 * They weigh megabytes (host comments have no pagination), too much for every SSE snapshot.
 * The `UI_REVIEW_EVENT` event signals changes, and the UI refetches the relevant endpoint.
 */
export const uiReviewPrResponseSchema = z.object({ pr: prMetaSchema });
export type UiReviewPrResponse = z.infer<typeof uiReviewPrResponseSchema>;

export const uiReviewDiffResponseSchema = z.object({ diff: prDiffSchema });
export type UiReviewDiffResponse = z.infer<typeof uiReviewDiffResponseSchema>;

export const uiReviewThreadsResponseSchema = z.object({ threads: z.array(threadSchema) });
export type UiReviewThreadsResponse = z.infer<typeof uiReviewThreadsResponseSchema>;

/**
 * File contents for "Expand context". The UI calls this endpoint only with
 * `capabilities.fileContent`. `content: null` means contents are unavailable for this file.
 */
export const uiReviewFileContentRequestSchema = z.object({ fileId: hostIdSchema });
export type UiReviewFileContentRequest = z.infer<typeof uiReviewFileContentRequestSchema>;

export const uiReviewFileContentResponseSchema = z.object({ content: fileContentSchema.nullable() });
export type UiReviewFileContentResponse = z.infer<typeof uiReviewFileContentResponseSchema>;

/**
 * "Open in external editor" (MUST in the brief). The path matches the diff. The server resolves
 * it relative to its cwd (inherited from `sherpa up` in the checkout). The editor command is
 * `SHERPA_EDITOR` (a template with `{file}` and `{line}`), defaulting to `code -g {file}:{line}`.
 * Failure (file missing on disk, editor failed to start) returns `unavailable` with a reason:
 * reduced functionality with an inline hint, not a UI error state.
 */
export const uiOpenInEditorRequestSchema = z.object({
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
});
export type UiOpenInEditorRequest = z.infer<typeof uiOpenInEditorRequestSchema>;

export const uiOpenInEditorResponseSchema = z.object({
    outcome: z.enum(['opened', 'unavailable']),
    message: z.string().nullable(),
});
export type UiOpenInEditorResponse = z.infer<typeof uiOpenInEditorResponseSchema>;

/** File filter lenses: ownership ("mine") is separate from additional lenses (PCI DSS). */
export const uiReviewLensesResponseSchema = z.object({
    ownership: lensSchema.nullable(),
    extra: z.array(lensSchema),
});
export type UiReviewLensesResponse = z.infer<typeof uiReviewLensesResponseSchema>;

/**
 * "Threads changed" event. The revision is a monotonic counter since server startup:
 * if it exceeds the last seen value, reread `reviewThreads`. A thread snapshot
 * is not sent in the event. See the comment on review endpoints.
 */
export const uiReviewEventSchema = z.object({
    threadsRevision: z.number().int().min(0),
});
export type UiReviewEvent = z.infer<typeof uiReviewEventSchema>;

/**
 * UI channel endpoints. All require a bearer token except `events`: EventSource does not support
 * headers, so the SSE endpoint accepts the token in the `?token=` query parameter (localhost, own logs).
 * Review endpoints return the `no_review_host` error when `reviewHost: null`.
 */
export const UI_ENDPOINTS = {
    /** GET → `uiStateSchema`. */
    state: '/api/ui/state',
    /** POST `uiEnqueueRequestSchema` → `uiEnqueueResponseSchema`. */
    enqueue: '/api/ui/tasks',
    /** POST `uiCancelRequestSchema` → `uiCancelResponseSchema`. */
    cancel: '/api/ui/tasks/cancel',
    /** GET, SSE: `state` (`uiStateSchema`) and `review` (`uiReviewEventSchema`) events. */
    events: '/api/ui/events',
    /** GET → `uiReviewPrResponseSchema`. */
    reviewPr: '/api/ui/review/pr',
    /** GET → `uiReviewDiffResponseSchema` (active host iteration). */
    reviewDiff: '/api/ui/review/diff',
    /** GET → `uiReviewThreadsResponseSchema`. */
    reviewThreads: '/api/ui/review/threads',
    /** GET → `uiReviewLensesResponseSchema`. */
    reviewLenses: '/api/ui/review/lenses',
    /** GET `?fileId=` (`uiReviewFileContentRequestSchema`) → `uiReviewFileContentResponseSchema`. */
    reviewFileContent: '/api/ui/review/file-content',
    /** POST `uiOpenInEditorRequestSchema` → `uiOpenInEditorResponseSchema`. */
    openInEditor: '/api/ui/open-in-editor',
} as const;

/** SSE event name for a state snapshot. */
export const UI_STATE_EVENT = 'state';

/** SSE event name for review data changes (`uiReviewEventSchema`). */
export const UI_REVIEW_EVENT = 'review';
