import { z } from 'zod';

import { agentNoteIdSchema, agentNoteSchema, chatAnchorSchema, chatExchangeIdSchema, chatExchangeSchema } from './chat.js';
import { prKeySchema } from './manifest.js';
import { workerStatusSchema } from './messages.js';
import {
    commentDraftSchema,
    commentSchema,
    fileContentSchema,
    hostIdSchema,
    lensSchema,
    prDiffSchema,
    prMetaSchema,
    publishResultSchema,
    threadSchema,
    verdictSchema,
} from './review.js';
import { routeSnapshotSchema } from './route.js';
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
    /**
     * The worker holds the task: `leased`, or `cancelled` if the worker has not learned of the cancellation
     * (it learns this on the next CLI call, rpc-design §5). While true, the agent is busy with this task,
     * even if nobody needs its result anymore. The UI does not present the session as idle.
     */
    heldByWorker: z.boolean(),
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
 * Feedback channel availability (M2F-T19). Depends only on the issue channel credentials
 * in the reviewer's environment. Neither the review host nor a live worker is required. Travels
 * in the snapshot so the form explains reduced functionality before sending (SPEC §1.1).
 */
export const uiFeedbackAvailabilitySchema = z.object({
    available: z.boolean(),
    /** When `available: false`, explains why and where to write manually. Otherwise null. */
    reason: z.string().nullable(),
});
export type UiFeedbackAvailability = z.infer<typeof uiFeedbackAvailabilitySchema>;

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
    /**
     * PR metadata from `ReviewHost.getPr()` (M2F-T4). Unlike the diff and threads, it is small,
     * so it travels in every snapshot. The breadcrumb and view headers use the same source.
     * null if there is no host or metadata has not loaded yet (the server populates the cache outside snapshot
     * assembly and refreshes it after publishing a verdict, so the status arrives over SSE).
     */
    pr: prMetaSchema.nullable(),
    /** Feedback channel availability (M2F-T19): depends only on issue channel credentials in the environment. */
    feedback: uiFeedbackAvailabilitySchema,
});
export type UiState = z.infer<typeof uiStateSchema>;

/**
 * Enqueue a task from the UI. Only `echo` (dev demo of the loop). The server itself enqueues generative tasks
 * (`route.*`), since they need materialized context and a result
 * schema, neither of which an endpoint accepting plain text has.
 */
export const uiEnqueueRequestSchema = z.object({
    type: z.literal('echo'),
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
 * PR metadata is the exception. It is small and lives in `uiStateSchema.pr`.
 */
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
 * UI route state (M2). Phases: `none` means generation has not started and is not needed
 * (no snapshot, combined with `smallPr` to distinguish "invitation to start the skill" from "small PR,
 * no route needed"). `reading` means the skeleton is in progress (README §6, phase A). `filling` means
 * the plan is accepted and sections are being filled (§7–8). `ready`. `failed` means the skeleton failed
 * validation or attempts ran out (§12). A section failure is not a phase, it is
 * `status: 'failed'` on its stop. "Agent died mid-generation" is not a separate phase:
 * the UI combines `filling` with the worker status (SPEC §4.4).
 */
export const uiRoutePhaseSchema = z.enum(['none', 'reading', 'filling', 'ready', 'failed']);
export type UiRoutePhase = z.infer<typeof uiRoutePhaseSchema>;

export const uiRouteFailureSchema = z.object({
    /** One-sentence reason (reviewer-facing, Russian). */
    message: z.string(),
    /** Last raw model output for "Open raw output". null if the model returned nothing. */
    rawOutput: z.string().nullable(),
});
export type UiRouteFailure = z.infer<typeof uiRouteFailureSchema>;

export const uiRouteStateSchema = z.object({
    phase: uiRoutePhaseSchema,
    /** PR below the route threshold (requirements §3.6): no generation task, UI opens on Full diff with a note. */
    smallPr: z.boolean(),
    /**
     * Exists once the skeleton is accepted. Partial in `filling` (see `stops[].status`).
     * During regeneration from `ready` (M2F-T28), the old snapshot lives until the new skeleton is accepted:
     * `reading` with a non-null snapshot means "building a new one, the old one is readable", replaced atomically
     * at acceptance.
     */
    snapshot: routeSnapshotSchema.nullable(),
    /** Only in the `failed` phase. Regeneration failure can coexist with an old snapshot, which remains readable. */
    failure: uiRouteFailureSchema.nullable(),
});
export type UiRouteState = z.infer<typeof uiRouteStateSchema>;

export const uiReviewRouteResponseSchema = z.object({
    route: uiRouteStateSchema,
    routeRevision: z.number().int().min(0),
});
export type UiReviewRouteResponse = z.infer<typeof uiReviewRouteResponseSchema>;

/**
 * Start/restart route generation (Retry from Generation failed, "regenerate"
 * from the palette. Since M2F-T28, also regeneration from `ready`, with the old snapshot
 * remaining until the new skeleton is accepted). Enqueues `route.skeleton` even without a live
 * worker. The task waits in the queue, and the agent pill shows the reduced functionality.
 * `already_running` only applies to `reading`/`filling` (generation already in progress).
 * `small_pr` means refusal: this endpoint does not bypass the threshold (requirements §3.6).
 */
export const uiRouteGenerateResponseSchema = z.object({
    outcome: z.enum(['started', 'already_running', 'small_pr']),
});
export type UiRouteGenerateResponse = z.infer<typeof uiRouteGenerateResponseSchema>;

/**
 * Fills one unfilled stop (M2F-T41): the button on the slot marked
 * "not filled, the agent stopped early" (SPEC §4.3). The stop moves to `queued`,
 * the phase to `filling`, then normal reconciliation takes over. Full regeneration returns
 * `already_running` during this time. `snapshotId` prevents a race with snapshot replacement,
 * since stop ids are not stable across snapshots. `stale_snapshot` means the snapshot changed.
 * `not_unfilled` means the stop is not `failed` (already filled or already in progress).
 * `already_running` means the phase is not `ready`.
 */
export const uiRouteFillStopRequestSchema = z.object({
    snapshotId: z.string().min(1),
    planIndex: z.number().int().positive(),
});
export type UiRouteFillStopRequest = z.infer<typeof uiRouteFillStopRequestSchema>;

export const uiRouteFillStopResponseSchema = z.object({
    outcome: z.enum(['started', 'already_running', 'stale_snapshot', 'not_unfilled']),
});
export type UiRouteFillStopResponse = z.infer<typeof uiRouteFillStopResponseSchema>;

/**
 * Chat with the agent and notes (M3, domain schemas in `chat.ts`). History uses a separate
 * endpoint instead of `uiState` (it grows without bounds). SSE event
 * `UI_CHAT_EVENT` signals changes with a revision. `ask` returns the created exchange (as with `saveDraft`,
 * the UI needs the id immediately for cancel and the popover's in-flight indicator). Later status updates
 * arrive over SSE. Only the server enqueues the `chat` task, since it needs
 * materialized context (as when `enqueue` was narrowed to `echo`).
 */
export const uiChatResponseSchema = z.object({
    exchanges: z.array(chatExchangeSchema),
    notes: z.array(agentNoteSchema),
    chatRevision: z.number().int().min(0),
});
export type UiChatResponse = z.infer<typeof uiChatResponseSchema>;

export const uiChatAskRequestSchema = z.object({
    text: z.string().min(1).max(4000),
    /** If absent, the question concerns the entire PR (Ask AI). */
    anchor: chatAnchorSchema.optional(),
});
export type UiChatAskRequest = z.infer<typeof uiChatAskRequestSchema>;

export const uiChatAskResponseSchema = z.object({ exchange: chatExchangeSchema });
export type UiChatAskResponse = z.infer<typeof uiChatAskResponseSchema>;

/**
 * Stop an exchange ("Stop", SPEC §2.18). `cancelled` applies to both queued
 * and leased exchanges, a formal cancellation the worker learns of on its next CLI call
 * (rpc-design §5). `noop` means the exchange is already terminal.
 */
export const uiChatCancelRequestSchema = z.object({ exchangeId: chatExchangeIdSchema });
export type UiChatCancelRequest = z.infer<typeof uiChatCancelRequestSchema>;

export const uiChatCancelResponseSchema = z.object({ outcome: z.enum(['cancelled', 'noop']) });
export type UiChatCancelResponse = z.infer<typeof uiChatCancelResponseSchema>;

/**
 * Retry a question from `failed` or `cancelled` (SPEC §2.18: question preserved): the same
 * exchange returns to `queued`, and a new task is enqueued with the same text and anchor.
 * `noop` means the exchange is not in a terminal failure state (`done` cannot be retried).
 */
export const uiChatRetryRequestSchema = z.object({ exchangeId: chatExchangeIdSchema });
export type UiChatRetryRequest = z.infer<typeof uiChatRetryRequestSchema>;

export const uiChatRetryResponseSchema = z.object({ outcome: z.enum(['retried', 'noop']) });
export type UiChatRetryResponse = z.infer<typeof uiChatRetryResponseSchema>;

/** Delete a note (SPEC §2.16). Leaves chat history intact. Repeated deletion is a no-op, also ack. */
export const uiChatNoteDeleteRequestSchema = z.object({ noteId: agentNoteIdSchema });
export type UiChatNoteDeleteRequest = z.infer<typeof uiChatNoteDeleteRequestSchema>;

/**
 * Sending feedback (M2F-T19): Feedback button in the top bar → project issue.
 * The UI supplies the view and route phase as automatic context (unknown to the server). The server adds the rest
 * (versions, prKey, worker status, login) to the issue itself. Without channel credentials,
 * returns `outcome: 'unavailable'` with instructions for sending feedback manually. This is reduced functionality,
 * not an endpoint error. A failure in the issue service is a normal RPC error, and the entered text
 * stays in the form for a retry.
 */
export const uiFeedbackContextSchema = z.object({
    view: z.string().min(1),
    routePhase: uiRoutePhaseSchema,
    /** UI bundle version. It can differ from the server version. The issue includes both. */
    uiVersion: z.string().min(1),
});
export type UiFeedbackContext = z.infer<typeof uiFeedbackContextSchema>;

export const uiFeedbackRequestSchema = z.object({
    text: z.string().min(1).max(20000),
    /** "Include context" checkbox. When false, `context` is ignored. */
    includeContext: z.boolean(),
    context: uiFeedbackContextSchema.nullable(),
});
export type UiFeedbackRequest = z.infer<typeof uiFeedbackRequestSchema>;

export const uiFeedbackResponseSchema = z.object({
    outcome: z.enum(['created', 'unavailable']),
    /** Key and URL of the created issue when `created`, otherwise null. */
    issueKey: z.string().nullable(),
    issueUrl: z.string().nullable(),
    /** Where to write manually when `unavailable`. null when `created`. */
    message: z.string().nullable(),
});
export type UiFeedbackResponse = z.infer<typeof uiFeedbackResponseSchema>;

/**
 * Reading progress (M1-T8, requirements §3.1): manual marks only, no viewport
 * viewport. `viewed` has 3 values (M2F-T40): `true` is a manual mark that pins `read`
 * permanently. `false` explicitly clears the mark (unpins the generated default or undoes a manual
 * mark). `null` means the reviewer has made no choice, the record exists only for
 * seen ranges. The UI applies defaults as if there were no record
 * (generated → `read`). A file without a record has the default state.
 *
 * Seen ranges are line ranges covered by manually marked stops
 * (written by `reviewStopViewed`). The UI derives tri-state (`unread`/`partial`/`read`) and
 * "N of M lines seen" tooltips from these data and its own diff model.
 * The server does not interpret patches.
 */
export const uiSeenRangeSchema = z.object({
    /** Line numbering side: added lines use `new`, removed lines use `old`. */
    side: z.enum(['old', 'new']),
    start: z.number().int().positive(),
    /** Inclusive, `end >= start`. */
    end: z.number().int().positive(),
});
export type UiSeenRange = z.infer<typeof uiSeenRangeSchema>;

export const uiFileProgressSchema = z.object({
    fileId: hostIdSchema,
    viewed: z.boolean().nullable(),
    seenRanges: z.array(uiSeenRangeSchema),
});
export type UiFileProgress = z.infer<typeof uiFileProgressSchema>;

/** A route stop's "viewed" mark persists per PR (README State model). */
export const uiStopProgressSchema = z.object({
    stopId: z.string().min(1),
    viewed: z.boolean(),
});
export type UiStopProgress = z.infer<typeof uiStopProgressSchema>;

export const uiReviewProgressResponseSchema = z.object({
    files: z.array(uiFileProgressSchema),
    stops: z.array(uiStopProgressSchema),
    progressRevision: z.number().int().min(0),
});
export type UiReviewProgressResponse = z.infer<typeof uiReviewProgressResponseSchema>;

/**
 * A file's viewed mark. The server writes it to SQLite (the UI's source of truth) and, if the host
 * supports it (`capabilities.fileViewedSync`), mirrors the mark to the host on a best-effort basis:
 * a mirror failure does not roll back the local write or fail the endpoint.
 */
export const uiSetFileViewedRequestSchema = z.object({
    fileId: hostIdSchema,
    viewed: z.boolean(),
});
export type UiSetFileViewedRequest = z.infer<typeof uiSetFileViewedRequestSchema>;

export const uiSetFileViewedResponseSchema = z.object({
    progressRevision: z.number().int().min(0),
});
export type UiSetFileViewedResponse = z.infer<typeof uiSetFileViewedResponseSchema>;

/**
 * A route stop's "viewed" mark (M2-T7, requirements §3.1). Writes the stop mark
 * and its files' seen ranges in one transaction. The UI calculates ranges from its diff
 * model (anchors clipped to the actual diff, uncovered lines for "Other",
 * which the server cannot calculate without a diff model). The server stores them bound to the stop
 * without interpreting them. Clearing the mark removes only this stop's ranges and leaves
 * other stops' ranges and manual file marks untouched (SPEC §2.10).
 * The request carries `snapshotId`: a late write from a previous route must not reach
 * a new stop with the same deterministic id. The field is optional for older UI bundles.
 * The stop mark itself is not mirrored to the host. The UI reports files becoming "read" through range
 * ranges, the UI reports it through the separate `reviewViewedMirror` endpoint (M2F-T38).
 */
export const uiStopSeenRangeSchema = uiSeenRangeSchema.extend({ fileId: hostIdSchema });
export type UiStopSeenRange = z.infer<typeof uiStopSeenRangeSchema>;

export const uiSetStopViewedRequestSchema = z.object({
    stopId: z.string().min(1),
    viewed: z.boolean(),
    /** The snapshot the UI saw: the server silently discards requests from an older route. */
    snapshotId: z.string().min(1).optional(),
    /** Ignored when `viewed: false`: clearing the mark removes the stop's stored ranges. */
    ranges: z.array(uiStopSeenRangeSchema),
});
export type UiSetStopViewedRequest = z.infer<typeof uiSetStopViewedRequestSchema>;

export const uiSetStopViewedResponseSchema = z.object({
    progressRevision: z.number().int().min(0),
});
export type UiSetStopViewedResponse = z.infer<typeof uiSetStopViewedResponseSchema>;

/**
 * Mirrors "viewed" to the host without a local write (M2F-T38). The UI reports
 * files changing to `read` and back through range coverage
 * (marking or clearing a stop, server-side symmetry when clearing a file): no explicit file
 * mark was made, so the `reviewFileViewed` mirror endpoint does not know about the change.
 * Only the UI knows when this happens. The server has no diff model to determine
 * whether "all file lines are covered". The server sends the change to the host on a best-effort basis through the same
 * mirror queue. Without `capabilities.fileViewedSync`, it silently does nothing. A partially
 * read file never reaches this endpoint, since the host has a binary status.
 */
export const uiViewedMirrorRequestSchema = z.object({
    entries: z
        .array(z.object({ fileId: hostIdSchema, viewed: z.boolean() }))
        .min(1),
});
export type UiViewedMirrorRequest = z.infer<typeof uiViewedMirrorRequestSchema>;

/**
 * Comment writes (M1-T13, the brief two-stage model): a draft is saved
 * to the host immediately, a verdict publishes the batch (T14). A successful write increments
 * `threadsRevision`. The source of truth arrives when the threads endpoint is reread after the SSE event
 * `review`. Until then, the UI uses optimistic state. `saveDraft` returns
 * the created comment: the composer needs its id for `updateDraft`/`deleteDraft`.
 */
export const uiSaveDraftRequestSchema = z.object({ draft: commentDraftSchema });
export type UiSaveDraftRequest = z.infer<typeof uiSaveDraftRequestSchema>;

export const uiSaveDraftResponseSchema = z.object({ comment: commentSchema });
export type UiSaveDraftResponse = z.infer<typeof uiSaveDraftResponseSchema>;

export const uiUpdateDraftRequestSchema = z.object({
    commentId: hostIdSchema,
    body: z.string().min(1),
    /** Changes the draft issue status (M2F-T39). undefined leaves it unchanged. */
    issue: z.boolean().optional(),
});
export type UiUpdateDraftRequest = z.infer<typeof uiUpdateDraftRequestSchema>;

export const uiDeleteDraftRequestSchema = z.object({ commentId: hostIdSchema });
export type UiDeleteDraftRequest = z.infer<typeof uiDeleteDraftRequestSchema>;

export const uiSetThreadResolvedRequestSchema = z.object({
    threadId: hostIdSchema,
    resolved: z.boolean(),
});
export type UiSetThreadResolvedRequest = z.infer<typeof uiSetThreadResolvedRequestSchema>;

/**
 * Publishes the accumulated batch with a verdict (M1-T14) in one `publishBatch`
 * host call. The response is the result as returned: `verdictApplied: false` on any failure
 * (SPEC §4.5, the review is NOT complete, and the UI shows failed items
 * from `failed`). Retry calls the same endpoint again. The adapter preserves
 * already published items (`publishedSilently` T12). Success bumps `threadsRevision`
 * (drafts became published comments). The source of truth arrives via the threads endpoint.
 * The server rereads PR metadata after the verdict and broadcasts it in a snapshot.
 */
export const uiPublishRequestSchema = z.object({ verdict: verdictSchema });
export type UiPublishRequest = z.infer<typeof uiPublishRequestSchema>;

export const uiPublishResponseSchema = z.object({ result: publishResultSchema });
export type UiPublishResponse = z.infer<typeof uiPublishResponseSchema>;

/** Common response from thread write endpoints: acknowledgement without data. The source of truth arrives via the threads endpoint. */
export const uiReviewWriteAckSchema = z.object({ acknowledged: z.literal(true) });
export type UiReviewWriteAck = z.infer<typeof uiReviewWriteAckSchema>;

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
 * "Reading progress changed" event, to keep multiple tabs in sync.
 * Revision semantics match `uiReviewEventSchema`.
 */
export const uiProgressEventSchema = z.object({
    progressRevision: z.number().int().min(0),
});
export type UiProgressEvent = z.infer<typeof uiProgressEventSchema>;

/**
 * "Route changed" event (phase, stop readiness, failure). The UI rereads
 * the `reviewRoute` endpoint. Revision semantics match `uiReviewEventSchema`.
 */
export const uiRouteEventSchema = z.object({
    routeRevision: z.number().int().min(0),
});
export type UiRouteEvent = z.infer<typeof uiRouteEventSchema>;

/**
 * "Chat/notes changed" event (exchange status, answer, note). The UI rereads
 * the `reviewChat` endpoint. Revision semantics match `uiReviewEventSchema`.
 */
export const uiChatEventSchema = z.object({
    chatRevision: z.number().int().min(0),
});
export type UiChatEvent = z.infer<typeof uiChatEventSchema>;

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
    /** GET, SSE: `state` (`uiStateSchema`), `review`, `progress`, `route`, `chat` events (revisions). */
    events: '/api/ui/events',
    /** GET → `uiReviewDiffResponseSchema` (active host iteration). */
    reviewDiff: '/api/ui/review/diff',
    /** GET → `uiReviewThreadsResponseSchema`. */
    reviewThreads: '/api/ui/review/threads',
    /** GET → `uiReviewLensesResponseSchema`. */
    reviewLenses: '/api/ui/review/lenses',
    /** GET `?fileId=` (`uiReviewFileContentRequestSchema`) → `uiReviewFileContentResponseSchema`. */
    reviewFileContent: '/api/ui/review/file-content',
    /** GET → `uiReviewProgressResponseSchema`. Also available without a review host, since progress is local. */
    reviewProgress: '/api/ui/review/progress',
    /** POST `uiSetFileViewedRequestSchema` → `uiSetFileViewedResponseSchema`. */
    reviewFileViewed: '/api/ui/review/file-viewed',
    /** POST `uiSetStopViewedRequestSchema` → `uiSetStopViewedResponseSchema`. Available without a review host too. */
    reviewStopViewed: '/api/ui/review/stop-viewed',
    /** POST `uiViewedMirrorRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewViewedMirror: '/api/ui/review/viewed-mirror',
    /** POST `uiSaveDraftRequestSchema` → `uiSaveDraftResponseSchema`. */
    reviewSaveDraft: '/api/ui/review/draft',
    /** POST `uiUpdateDraftRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewUpdateDraft: '/api/ui/review/draft/update',
    /** POST `uiDeleteDraftRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewDeleteDraft: '/api/ui/review/draft/delete',
    /** POST `uiSetThreadResolvedRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewThreadResolved: '/api/ui/review/thread-resolved',
    /** POST `uiPublishRequestSchema` → `uiPublishResponseSchema`. */
    reviewPublish: '/api/ui/review/publish',
    /** GET → `uiReviewRouteResponseSchema`. */
    reviewRoute: '/api/ui/review/route',
    /** POST without a body → `uiRouteGenerateResponseSchema`. */
    reviewRouteGenerate: '/api/ui/review/route/generate',
    /** POST `uiRouteFillStopRequestSchema` → `uiRouteFillStopResponseSchema`. */
    reviewRouteFillStop: '/api/ui/review/route/fill-stop',
    /** GET → `uiChatResponseSchema`. */
    reviewChat: '/api/ui/review/chat',
    /** POST `uiChatAskRequestSchema` → `uiChatAskResponseSchema`. */
    reviewChatAsk: '/api/ui/review/chat/ask',
    /** POST `uiChatCancelRequestSchema` → `uiChatCancelResponseSchema`. */
    reviewChatCancel: '/api/ui/review/chat/cancel',
    /** POST `uiChatRetryRequestSchema` → `uiChatRetryResponseSchema`. */
    reviewChatRetry: '/api/ui/review/chat/retry',
    /** POST `uiChatNoteDeleteRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewChatNoteDelete: '/api/ui/review/chat/note-delete',
    /** POST `uiOpenInEditorRequestSchema` → `uiOpenInEditorResponseSchema`. */
    openInEditor: '/api/ui/open-in-editor',
    /** POST `uiFeedbackRequestSchema` → `uiFeedbackResponseSchema`. Available without a review host too. */
    feedback: '/api/ui/feedback',
} as const;

/** SSE event name for a state snapshot. */
export const UI_STATE_EVENT = 'state';

/** SSE event name for review data changes (`uiReviewEventSchema`). */
export const UI_REVIEW_EVENT = 'review';

/** SSE event name for reading progress changes (`uiProgressEventSchema`). */
export const UI_PROGRESS_EVENT = 'progress';

/** SSE event name for route changes (`uiRouteEventSchema`). */
export const UI_ROUTE_EVENT = 'route';

/** SSE event name for chat and note changes (`uiChatEventSchema`). */
export const UI_CHAT_EVENT = 'chat';
