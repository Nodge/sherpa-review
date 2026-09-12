import { z } from 'zod';

import { agentNoteIdSchema, agentNoteSchema, chatAnchorSchema, chatExchangeIdSchema, chatExchangeSchema } from './chat.js';
import { distributionVersionSchema } from './distribution.js';
import { draftBufferEntrySchema } from './draft-buffer.js';
import { localeSchema, localeSettingSchema } from './locale.js';
import { prKeySchema } from './manifest.js';
import { workerStatusSchema } from './messages.js';
import {
    commentDraftSchema,
    commentSchema,
    fileContentSchema,
    hostIdSchema,
    iterationSchema,
    lensSchema,
    prDiffSchema,
    prMetaSchema,
    publishResultSchema,
    threadSchema,
    verdictSchema,
} from './review.js';
import { routeProvenanceSchema, routeSnapshotSchema } from './route.js';
import { priorityClassSchema, taskIdSchema, taskTypeSchema } from './task.js';
import { semverSchema } from './version.js';

/**
 * UI↔server contract (`docs/protocol.md §2`): REST for actions, SSE for reactive updates.
 * The UI consumes nothing that has not passed these schemas, fail-closed on both sides.
 */

/** Task lifecycle (`docs/protocol.md §5`). Terminal statuses (`done`/`failed`/`cancelled`) are irreversible. */
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
     * yet (it will on the next CLI call, `docs/protocol.md §5`). While true, the agent is busy with this task,
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
 * Feedback channel availability. Depends only on the feedback channel token
 * in the reviewer's environment. Neither the review host nor a live worker is required. Travels
 * in the snapshot so the form explains reduced functionality before submission (`docs/design/SPEC-elements.md §1.1`).
 */
export const uiFeedbackAvailabilitySchema = z.object({
    available: z.boolean(),
    /** When `available: false`, explains why and where to write manually. Otherwise null. */
    reason: z.string().nullable(),
});
export type UiFeedbackAvailability = z.infer<typeof uiFeedbackAvailabilitySchema>;

/**
 * Where the distribution was installed determines which command
 * update instructions to show.
 * With `copy`, the distribution was copied elsewhere and has no update command.
 * The toast asks the reviewer to copy the directory again.
 */
export const uiUpdateInstallSchema = z.object({
    kind: z.enum(['copy']),
    /** Distribution directory realpath as passed by the CLI (`--install-dir`). */
    dir: z.string().min(1),
    command: z.string().nullable(),
});
export type UiUpdateInstall = z.infer<typeof uiUpdateInstallSchema>;

/**
 * "A new version is available": the result of comparing `version.json` in main with the embedded
 * server version. Appears in the snapshot only when `latest > current` and the version has not been dismissed
 * (`settings.updates.dismissedVersion`). "Later" stays in tab memory and does not change the snapshot.
 */
export const uiUpdateSchema = z.object({
    current: semverSchema,
    latest: semverSchema,
    releasedAt: distributionVersionSchema.shape.releasedAt,
    whatsNew: distributionVersionSchema.shape.whatsNew,
    install: uiUpdateInstallSchema,
});
export type UiUpdate = z.infer<typeof uiUpdateSchema>;

/**
 * Generation cap (`docs/design/SPEC-elements.md §4.1`): the payload budget truncated the skeleton context. The server computes it
 * when enqueueing `route.skeleton` (`payload-budget.ts`). The UI says "plan
 * covers N of M files, K generated files in one stop" in the route header and shows a banner if truncation
 * affected files that are not generated.
 */
export const uiGenerationCapSchema = z.object({
    /** Files whose entire diff the model saw. */
    filesCovered: z.number().int().min(0),
    filesTotal: z.number().int().min(0),
    /** Generated files given to the model as one list entry instead of a diff. */
    machineFiles: z.number().int().min(0),
    /** Truncation affected files that are not generated, so the plan was built from an incomplete diff. */
    truncated: z.boolean(),
});
export type UiGenerationCap = z.infer<typeof uiGenerationCapSchema>;

/**
 * PR state snapshot for the UI. Returned by `GET state` and sent in full by the SSE channel
 * on every change. The queue is small, so granular events are not worth it.
 */
export const uiStateSchema = z.object({
    prKey: prKeySchema,
    worker: workerStatusSchema,
    tasks: z.array(uiTaskSchema),
    /**
     * Name of this PR's host adapter (`fixture`). null means prKey maps to no host,
     * does not map to one, review endpoints are unavailable. This server has only a queue.
     */
    reviewHost: z.string().nullable(),
    /**
     * PR metadata from `ReviewHost.getPr()`. Unlike the diff and threads, it is small,
     * so it travels in every snapshot. The breadcrumb and view headers use the same source.
     * null if there is no host or metadata has not loaded yet (the server populates the cache outside snapshot
     * assembly and refreshes it after publishing a verdict, so the status arrives over SSE).
     */
    pr: prMetaSchema.nullable(),
    /** Feedback channel availability: depends only on its token in the environment. */
    feedback: uiFeedbackAvailabilitySchema,
    /**
     * PR iterations, the host's list supplemented with `gone` entries from local storage, in order
     * of appearance. Empty if there is no host or the list has not loaded yet. A new push arrives in this same
     * snapshot over SSE `state`, with no separate event.
     */
    iterations: z.array(iterationSchema),
    /**
     * A newer distribution version. null if the check was not run (dev build `0.0.0`,
     * fixture host), the check failed, the version is current or the reviewer dismissed it.
     */
    update: uiUpdateSchema.nullable(),
    /** Generation cap for the current route snapshot. null if there is no snapshot or nothing was truncated. */
    generationCap: uiGenerationCapSchema.nullable(),
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

/** Cancel a task from the UI (`docs/protocol.md §5`). A leased task is formally cancelled, the worker learns on its next call. */
export const uiCancelRequestSchema = z.object({ taskId: taskIdSchema });
export type UiCancelRequest = z.infer<typeof uiCancelRequestSchema>;

export const uiCancelResponseSchema = z.object({ outcome: z.enum(['cancelled', 'noop']) });
export type UiCancelResponse = z.infer<typeof uiCancelResponseSchema>;

/**
 * PR review data. Served through separate endpoints instead of `uiState`, since the diff and threads
 * They weigh megabytes (host comments have no pagination), too much for every SSE snapshot.
 * The `UI_REVIEW_EVENT` event signals changes, and the UI refetches the relevant endpoint.
 * PR metadata is the exception. It is small and lives in `uiStateSchema.pr`.
 */
/**
 * Diff selection. Without parameters, the active host iteration. `diffId` selects a saved
 * iteration (including `gone`, since the patch is stored locally, `docs/product.md §4a`). `base`+`head` selects a slice between
 * two iterations ("what is new" in the reader). Only the UI knows which iteration the tab is viewing
 * (selection in the URL fragment). The server is not queried about the "current view".
 */
export const uiReviewDiffRequestSchema = z
    .object({
        diffId: hostIdSchema.optional(),
        base: hostIdSchema.optional(),
        head: hostIdSchema.optional(),
    })
    .refine(
        (query) => (query.base === undefined) === (query.head === undefined),
        'base and head must be specified together',
    )
    .refine(
        (query) => query.diffId === undefined || query.base === undefined,
        'diffId and a base/head slice are mutually exclusive',
    );
export type UiReviewDiffRequest = z.infer<typeof uiReviewDiffRequestSchema>;

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
 * Image bytes by `ImageSide.blobId` (`FileDiff.image`). The UI calls this endpoint only with
 * `capabilities.blobs`. The response is not JSON. The body contains raw bytes, `Content-Type` follows the magic
 * bytes (`image/*`, otherwise `application/octet-stream`), `Cache-Control: private, immutable`
 * with a one-year `max-age`, since the id addresses content. 404 (`not_found`) if the host does not know the blob
 * or the side exceeds `IMAGE_BLOB_MAX_BYTES`.
 */
export const uiReviewBlobRequestSchema = z.object({ blobId: hostIdSchema });
export type UiReviewBlobRequest = z.infer<typeof uiReviewBlobRequestSchema>;

/** File filter lenses: ownership ("mine") is separate from additional lenses (PCI DSS). */
export const uiReviewLensesResponseSchema = z.object({
    ownership: lensSchema.nullable(),
    extra: z.array(lensSchema),
});
export type UiReviewLensesResponse = z.infer<typeof uiReviewLensesResponseSchema>;

/**
 * Route state for the UI. Phases: `none` means generation has not started and is not needed
 * (no snapshot, combined with `smallPr` to distinguish "invitation to start the skill" from "small PR,
 * no route needed"). `reading` means skeleton generation is in progress (`docs/design/README.md §6`, phase A). `filling` means
 * the plan is accepted and sections are being filled (§7–8). `ready`. `failed` means the skeleton failed
 * validation or attempts ran out (§12). A section failure is not a phase, it is
 * `status: 'failed'` on its stop. "The agent died during generation" has no separate phase.
 * The UI combines `filling` with worker status (`docs/design/SPEC-elements.md §4.4`).
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

/**
 * "Route is stale" (`docs/product.md §9`, `docs/design/README.md §9`): the active host iteration has advanced beyond the iteration
 * of the current snapshot. The UI stays on the snapshot's iteration (anchors do not drift). The stale banner
 * offers to rebuild the route or open the new diff without it. There is no automatic regeneration.
 */
export const uiRouteStaleSchema = z.object({
    /** Snapshot commit and iteration compared with the active host iteration. */
    routeCommit: z.string().min(1),
    prCommit: z.string().min(1),
    prDiffId: hostIdSchema,
    /** Number of iterations since the snapshot's iteration (a force-push counts as one). */
    newIterations: z.number().int().min(1),
    /** Current snapshot stops whose anchors the interdiff touches ("stops 02, 03 and 07 are affected"). */
    affectedStopIds: z.array(z.string().min(1)),
});
export type UiRouteStale = z.infer<typeof uiRouteStaleSchema>;

export const uiRouteStateSchema = z.object({
    phase: uiRoutePhaseSchema,
    /** PR below the route threshold (`docs/architecture.md §7.6`). Generation is not queued, the UI opens on the full diff with a notice. */
    smallPr: z.boolean(),
    /**
     * Current snapshot, present since skeleton acceptance, partial in `filling`
     * (see `stops[].status`). When regenerating from `ready`, the old snapshot remains
     * until the new skeleton is accepted. `reading` with a non-null snapshot means "building a new one,
     * the old one is readable". Replacement is atomic upon acceptance. Previous snapshots are served
     * by `reviewRoute?snapshot=`, the list by `reviewSnapshots`.
     */
    snapshot: routeSnapshotSchema.nullable(),
    /** Only in the `failed` phase. Regeneration failure can coexist with an old snapshot, which remains readable. */
    failure: uiRouteFailureSchema.nullable(),
    /** null if there is no snapshot or it was built on the active iteration. */
    stale: uiRouteStaleSchema.nullable(),
});
export type UiRouteState = z.infer<typeof uiRouteStateSchema>;

/** Without `snapshot`, current route state. With it, the previous snapshot in `snapshot`, with its phase at the time. */
export const uiReviewRouteRequestSchema = z.object({ snapshot: z.string().min(1).optional() });
export type UiReviewRouteRequest = z.infer<typeof uiReviewRouteRequestSchema>;

export const uiReviewRouteResponseSchema = z.object({
    route: uiRouteStateSchema,
    routeRevision: z.number().int().min(0),
});
export type UiReviewRouteResponse = z.infer<typeof uiReviewRouteResponseSchema>;

/**
 * PR snapshot list (snapshot picker in the indicator, "Snapshots" card in Overview, `docs/design/README.md §6`).
 * `current` is the current snapshot (exactly one if any exist). `stale` is a previous snapshot whose iteration
 * is still in the PR. `gone` means the snapshot's iteration left the PR (force-push), and the snapshot is readable from
 * the locally saved diff. Previous snapshots are read-only.
 */
export const uiSnapshotStatusSchema = z.enum(['current', 'stale', 'gone']);
export type UiSnapshotStatus = z.infer<typeof uiSnapshotStatusSchema>;

export const uiSnapshotSummarySchema = z.object({
    snapshotId: z.string().min(1),
    diffId: hostIdSchema,
    commit: z.string().min(1),
    baseCommit: z.string().min(1),
    createdAt: z.iso.datetime(),
    provenance: routeProvenanceSchema,
    previousSnapshotId: z.string().nullable(),
    status: uiSnapshotStatusSchema,
});
export type UiSnapshotSummary = z.infer<typeof uiSnapshotSummarySchema>;

/** In order of appearance, current last. */
export const uiReviewSnapshotsResponseSchema = z.object({ snapshots: z.array(uiSnapshotSummarySchema) });
export type UiReviewSnapshotsResponse = z.infer<typeof uiReviewSnapshotsResponseSchema>;

/**
 * Start/restart route generation (Retry from Generation failed, "regenerate"
 * from the palette, and regeneration from `ready`, with the old snapshot
 * remaining until the new skeleton is accepted). Enqueues `route.skeleton` even without a live
 * worker. The task waits in the queue, and the agent indicator shows reduced functionality.
 * `already_running` only applies to `reading`/`filling` (generation already in progress).
 * `small_pr` rejects the request. The endpoint does not bypass the threshold (`docs/architecture.md §7.6`).
 */
export const uiRouteGenerateRequestSchema = z.object({
    /**
     * Generation language, the effective UI locale resolved in order "setting → agent `--lang` → browser"
     * Without it (old client, server autostart), the server resolves the language
     * itself: `settings.locale` ≠ `auto` → `worker.lang` → `ru`.
     */
    locale: localeSchema.optional(),
});
export type UiRouteGenerateRequest = z.infer<typeof uiRouteGenerateRequestSchema>;

export const uiRouteGenerateResponseSchema = z.object({
    outcome: z.enum(['started', 'already_running', 'small_pr']),
});
export type UiRouteGenerateResponse = z.infer<typeof uiRouteGenerateResponseSchema>;

/**
 * Fill one unfilled stop, using the button in the slot
 * "not filled, the agent stopped early" (`docs/design/SPEC-elements.md §4.3`). The stop moves to `queued`,
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
 * Agent chat and notes (domain schemas in `chat.ts`). History uses a separate
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

/** UI question anchor. Without `diffId`, the server uses the active iteration. */
export const uiChatAskAnchorSchema = chatAnchorSchema.extend({ diffId: hostIdSchema.optional() });
export type UiChatAskAnchor = z.infer<typeof uiChatAskAnchorSchema>;

export const uiChatAskRequestSchema = z.object({
    text: z.string().min(1).max(4000),
    /** If absent, the question concerns the entire PR (Ask AI). */
    anchor: uiChatAskAnchorSchema.optional(),
    /** Answer language, same resolution order and fallback as `uiRouteGenerateRequestSchema.locale`. */
    locale: localeSchema.optional(),
});
export type UiChatAskRequest = z.infer<typeof uiChatAskRequestSchema>;

export const uiChatAskResponseSchema = z.object({ exchange: chatExchangeSchema });
export type UiChatAskResponse = z.infer<typeof uiChatAskResponseSchema>;

/**
 * Stop an exchange ("Stop", `docs/design/SPEC-elements.md §2.18`). `cancelled` applies both to queued
 * and leased exchanges, a formal cancellation the worker learns of on its next CLI call
 * (`docs/protocol.md §5`). `noop` means the exchange is already terminal.
 */
export const uiChatCancelRequestSchema = z.object({ exchangeId: chatExchangeIdSchema });
export type UiChatCancelRequest = z.infer<typeof uiChatCancelRequestSchema>;

export const uiChatCancelResponseSchema = z.object({ outcome: z.enum(['cancelled', 'noop']) });
export type UiChatCancelResponse = z.infer<typeof uiChatCancelResponseSchema>;

/**
 * Retry a question from `failed` or `cancelled` (`docs/design/SPEC-elements.md §2.18`, the question is preserved). The same
 * exchange returns to `queued`, and a new task is enqueued with the same text and anchor.
 * `noop` means the exchange is not in a terminal failure state (`done` cannot be retried).
 */
export const uiChatRetryRequestSchema = z.object({ exchangeId: chatExchangeIdSchema });
export type UiChatRetryRequest = z.infer<typeof uiChatRetryRequestSchema>;

export const uiChatRetryResponseSchema = z.object({ outcome: z.enum(['retried', 'noop']) });
export type UiChatRetryResponse = z.infer<typeof uiChatRetryResponseSchema>;

/** Delete a note (`docs/design/SPEC-elements.md §2.16`). Leaves chat history intact. Repeated deletion is a no-op, also acknowledged. */
export const uiChatNoteDeleteRequestSchema = z.object({ noteId: agentNoteIdSchema });
export type UiChatNoteDeleteRequest = z.infer<typeof uiChatNoteDeleteRequestSchema>;

/**
 * Sending feedback: Feedback button in the top bar → project issue.
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
 * Force an update check ("Check for updates" palette command), ignoring the cache
 * at `~/.sherpa/update-check.json`. The response is the same as what goes into `uiState.update`.
 * `update: null` means the version is current, was dismissed or the check failed. The UI has no reason
 * to distinguish them. The server writes the failure reason to stderr.
 */
export const uiUpdateCheckResponseSchema = z.object({ update: uiUpdateSchema.nullable() });
export type UiUpdateCheckResponse = z.infer<typeof uiUpdateCheckResponseSchema>;

/** Dev endpoint, the fixture server "learns" of a new version for gallery and toast e2e tests. */
export const uiDevUpdateAvailableRequestSchema = z.object({
    version: semverSchema,
    releasedAt: distributionVersionSchema.shape.releasedAt,
    whatsNew: distributionVersionSchema.shape.whatsNew,
});
export type UiDevUpdateAvailableRequest = z.infer<typeof uiDevUpdateAvailableRequestSchema>;

/**
 * Global UI settings, one user with one set of settings across all PRs
 * (`docs/design/SPEC-elements.md §2.8`, `docs/design/README.md` «Diff mode is global»).
 * Stored on the server in `~/.sherpa/settings.json`, not in the browser,
 * since each PR server listens on a random port, with a new origin and empty `localStorage`.
 * Every field has a default, so a missing or corrupt file falls back to defaults instead of an error.
 * Per-PR state (collapsed directories, recent palette commands) does not belong here.
 */
const uiSettingsFields = {
    diffMode: z.enum(['unified', 'split']),
    shipMode: z.enum(['ship', 'sticky_ship']),
    composerLayout: z.enum(['visual', 'markdown']),
    /** UI language. */
    locale: localeSettingSchema,
    /** UI theme, shared across all PRs. `auto` follows the system theme, an explicit choice does not. */
    theme: z.enum(['auto', 'dark', 'light']),
    /** Interface text size. `l` uses the same scale at a larger size (`docs/design/SPEC-theming-2026-09-12.md §5`). */
    textSize: z.enum(['m', 'l']),
    /**
     * Onboarding tour: `completedAt` means completed or skipped
     * (skipping is permanent). `step` is where an unfinished tour paused, and it resumes there
     * on any PR and after a server restart. Replay from the palette resets both.
     */
    onboarding: z.object({
        completedAt: z.iso.datetime().nullable(),
        step: z.number().int().min(0),
    }),
    /** "Don't remind me about X" in the update toast dismisses exactly this version. The next one will appear. */
    updates: z.object({
        dismissedVersion: semverSchema.nullable(),
    }),
};

export const uiSettingsSchema = z.object({
    diffMode: uiSettingsFields.diffMode.default('unified'),
    shipMode: uiSettingsFields.shipMode.default('ship'),
    composerLayout: uiSettingsFields.composerLayout.default('visual'),
    locale: uiSettingsFields.locale.default('auto'),
    theme: uiSettingsFields.theme.default('auto'),
    textSize: uiSettingsFields.textSize.default('m'),
    onboarding: uiSettingsFields.onboarding.default({ completedAt: null, step: 0 }),
    updates: uiSettingsFields.updates.default({ dismissedVersion: null }),
});
export type UiSettings = z.infer<typeof uiSettingsSchema>;

export const uiSettingsResponseSchema = z.object({ settings: uiSettingsSchema });
export type UiSettingsResponse = z.infer<typeof uiSettingsResponseSchema>;

/**
 * Partial update. The server rereads the file, merges the named fields and returns the result
 * in full. Built from fields without defaults, since `.partial()` over `.default()` would insert
 * a default for a missing key, making "leave the field alone" indistinguishable from "reset it".
 * Nested objects (`onboarding`, `updates`) are replaced in full, not merged by key.
 */
export const uiSettingsPatchSchema = z.object(uiSettingsFields).partial();
export type UiSettingsPatch = z.infer<typeof uiSettingsPatchSchema>;

/**
 * UI state for one PR: tree directories and diff cards collapsed by the reviewer, recent
 * command palette entries. Lives in the server's per-PR SQLite for the same reason as global settings:
 * the tab origin changes with the port, so `localStorage` does not survive a restart. Maps store only
 * explicit reviewer choices. A missing key means "default", not `false`. The order of
 * `paletteRecent` is newest first. The UI limits the display, the server only stores it.
 */
const uiPrStateFields = {
    treeCollapsed: z.record(z.string(), z.boolean()),
    diffCollapsed: z.record(z.string(), z.boolean()),
    paletteRecent: z.array(z.string()).max(64),
};

export const uiPrStateSchema = z.object({
    treeCollapsed: uiPrStateFields.treeCollapsed.default({}),
    diffCollapsed: uiPrStateFields.diffCollapsed.default({}),
    paletteRecent: uiPrStateFields.paletteRecent.default([]),
});
export type UiPrState = z.infer<typeof uiPrStateSchema>;

export const uiPrStateResponseSchema = z.object({ prState: uiPrStateSchema });
export type UiPrStateResponse = z.infer<typeof uiPrStateResponseSchema>;

/** Partial update: each named field is replaced in full (not merged by key), other fields stay unchanged. */
export const uiPrStatePatchSchema = z.object(uiPrStateFields).partial();
export type UiPrStatePatch = z.infer<typeof uiPrStatePatchSchema>;

/**
 * Reading progress (`docs/architecture.md §7.1`): manual marks only, no viewport
 * tracking. `viewed` has three values: `true` is a manual mark that pins `read`
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

/** Viewed mark for a route stop, persisted per PR (docs/design/README.md §State model). */
export const uiStopProgressSchema = z.object({
    stopId: z.string().min(1),
    viewed: z.boolean(),
});
export type UiStopProgress = z.infer<typeof uiStopProgressSchema>;

/**
 * Which iteration's progress to read: without `diffId`, the active one. With it, the saved
 * iteration as is (an old snapshot shows its own progress, which cannot be edited).
 * Progress write endpoints accept only the active iteration.
 */
export const uiReviewProgressRequestSchema = z.object({ diffId: hostIdSchema.optional() });
export type UiReviewProgressRequest = z.infer<typeof uiReviewProgressRequestSchema>;

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
 * Viewed mark for a route stop (`docs/architecture.md §7.1`). Writes the stop mark
 * and its files' seen ranges in one transaction. The UI calculates ranges from its diff
 * model (anchors clipped to the actual diff, uncovered lines for "Other",
 * which the server cannot calculate without a diff model). The server stores them bound to the stop
 * without interpreting them. Clearing the mark removes only this stop's ranges and leaves
 * other stops' ranges and manual file marks untouched (`docs/design/SPEC-elements.md §2.10`).
 * The request carries `snapshotId`: a late write from a previous route must not reach
 * a new stop with the same deterministic id. The field is optional for older UI bundles.
 * The stop mark itself is not mirrored to the host. The UI reports files becoming "read" through range
 * coverage via a separate endpoint, `reviewViewedMirror`.
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
 * Mirrors viewed marks to the host without a local write. The UI reports
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
 * Writing comments (two-stage model, `docs/product.md §3`, principle 6): a draft
 * is saved to the host immediately, the batch is published with a verdict. A successful write increments
 * `threadsRevision`. The source of truth arrives when the threads endpoint is reread after the SSE event
 * `review`. Until then, the UI uses optimistic state. `saveDraft` returns
 * the created comment: the composer needs its id for `updateDraft`/`deleteDraft`.
 */
export const uiSaveDraftRequestSchema = z.object({
    draft: commentDraftSchema,
    /**
     * Buffer entry key: the composer's UUID, one per logical write until it succeeds.
     * A retry with the same key upserts the same record and reaches the host with the same
     * idempotency key. No duplicate is created even if the previous attempt's response was lost.
     */
    clientKey: z.string().min(1),
});
export type UiSaveDraftRequest = z.infer<typeof uiSaveDraftRequestSchema>;

/**
 * Draft write result: `saved` means the host accepted it, `buffered` means the host did not respond or
 * refused. The text is in the server buffer and will be retried (`docs/design/SPEC-elements.md §4.5`
 * "we'll save it when
 * the connection returns"). Network and validation errors in the endpoint itself remain HTTP errors:
 * only failures in the "server → host" step are buffered.
 */
export const uiSaveDraftResponseSchema = z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('saved'), comment: commentSchema }),
    z.object({ outcome: z.literal('buffered'), entry: draftBufferEntrySchema }),
]);
export type UiSaveDraftResponse = z.infer<typeof uiSaveDraftResponseSchema>;

export const uiUpdateDraftRequestSchema = z.object({
    commentId: hostIdSchema,
    body: z.string().min(1),
    /** Change the draft's issue status. undefined leaves it unchanged. */
    issue: z.boolean().optional(),
    /** See `uiSaveDraftRequestSchema.clientKey`. */
    clientKey: z.string().min(1),
});
export type UiUpdateDraftRequest = z.infer<typeof uiUpdateDraftRequestSchema>;

export const uiUpdateDraftResponseSchema = z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('saved') }),
    z.object({ outcome: z.literal('buffered'), entry: draftBufferEntrySchema }),
]);
export type UiUpdateDraftResponse = z.infer<typeof uiUpdateDraftResponseSchema>;

/**
 * Draft buffer for this PR. Changes on save/update, server retries, `retry`
 * and `discard`. Each change increments `threadsRevision`. The UI rereads the buffer along
 * with threads on the SSE event `review`.
 */
export const uiDraftBufferResponseSchema = z.object({ entries: z.array(draftBufferEntrySchema) });
export type UiDraftBufferResponse = z.infer<typeof uiDraftBufferResponseSchema>;

/** Retry the host write now ("retry" button) or discard it ("delete"). */
export const uiDraftBufferEntryRequestSchema = z.object({ id: z.string().min(1) });
export type UiDraftBufferEntryRequest = z.infer<typeof uiDraftBufferEntryRequestSchema>;

export const uiDeleteDraftRequestSchema = z.object({ commentId: hostIdSchema });
export type UiDeleteDraftRequest = z.infer<typeof uiDeleteDraftRequestSchema>;

export const uiSetThreadResolvedRequestSchema = z.object({
    threadId: hostIdSchema,
    resolved: z.boolean(),
});
export type UiSetThreadResolvedRequest = z.infer<typeof uiSetThreadResolvedRequestSchema>;

/**
 * Publishing the accumulated batch with a verdict: one `publishBatch` call to the
 * host call. The response is the result as returned: `verdictApplied: false` on any failure
 * (`docs/design/SPEC-elements.md §4.5`, the review is NOT considered finished, the UI shows
 * the unsuccessful entries from `failed`). A retry calls the same endpoint again: the adapter does not discard
 * already published entries (`publishedSilently`). Success increments `threadsRevision`
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
    /** GET `?diffId=` | `?base=&head=` (`uiReviewDiffRequestSchema`) → `uiReviewDiffResponseSchema`. Without parameters, the active iteration. */
    reviewDiff: '/api/ui/review/diff',
    /** GET → `uiReviewThreadsResponseSchema`. */
    reviewThreads: '/api/ui/review/threads',
    /** GET → `uiReviewLensesResponseSchema`. */
    reviewLenses: '/api/ui/review/lenses',
    /** GET `?fileId=` (`uiReviewFileContentRequestSchema`) → `uiReviewFileContentResponseSchema`. */
    reviewFileContent: '/api/ui/review/file-content',
    /** GET `?blobId=` (`uiReviewBlobRequestSchema`) → raw bytes (see the request schema). */
    reviewBlob: '/api/ui/review/blob',
    /** GET `?diffId=` (`uiReviewProgressRequestSchema`) → `uiReviewProgressResponseSchema`. Available without a review host too, progress is local. */
    reviewProgress: '/api/ui/review/progress',
    /** POST `uiSetFileViewedRequestSchema` → `uiSetFileViewedResponseSchema`. */
    reviewFileViewed: '/api/ui/review/file-viewed',
    /** POST `uiSetStopViewedRequestSchema` → `uiSetStopViewedResponseSchema`. Available without a review host too. */
    reviewStopViewed: '/api/ui/review/stop-viewed',
    /** POST `uiViewedMirrorRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewViewedMirror: '/api/ui/review/viewed-mirror',
    /** POST `uiSaveDraftRequestSchema` → `uiSaveDraftResponseSchema`. */
    reviewSaveDraft: '/api/ui/review/draft',
    /** POST `uiUpdateDraftRequestSchema` → `uiUpdateDraftResponseSchema`. */
    reviewUpdateDraft: '/api/ui/review/draft/update',
    /** GET → `uiDraftBufferResponseSchema`. */
    reviewDraftBuffer: '/api/ui/review/draft-buffer',
    /** POST `uiDraftBufferEntryRequestSchema` → `uiDraftBufferResponseSchema` (buffer after the attempt). */
    reviewDraftBufferRetry: '/api/ui/review/draft-buffer/retry',
    /** POST `uiDraftBufferEntryRequestSchema` → `uiDraftBufferResponseSchema`. */
    reviewDraftBufferDiscard: '/api/ui/review/draft-buffer/discard',
    /** POST `uiDeleteDraftRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewDeleteDraft: '/api/ui/review/draft/delete',
    /** POST `uiSetThreadResolvedRequestSchema` → `uiReviewWriteAckSchema`. */
    reviewThreadResolved: '/api/ui/review/thread-resolved',
    /** POST `uiPublishRequestSchema` → `uiPublishResponseSchema`. */
    reviewPublish: '/api/ui/review/publish',
    /** GET `?snapshot=` (`uiReviewRouteRequestSchema`) → `uiReviewRouteResponseSchema`. */
    reviewRoute: '/api/ui/review/route',
    /** GET → `uiReviewSnapshotsResponseSchema`. */
    reviewSnapshots: '/api/ui/review/snapshots',
    /** POST `uiRouteGenerateRequestSchema` (body may be empty) → `uiRouteGenerateResponseSchema`. */
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
    /** POST `uiFeedbackRequestSchema` → `uiFeedbackResponseSchema`. Available without a review host too. */
    feedback: '/api/ui/feedback',
    /** POST without a body → `uiUpdateCheckResponseSchema`. Available without a review host too. */
    updateCheck: '/api/ui/update-check',
    /** GET → `uiSettingsResponseSchema`, PATCH `uiSettingsPatchSchema` → `uiSettingsResponseSchema`. Available without a review host too. */
    settings: '/api/ui/settings',
    /** GET → `uiPrStateResponseSchema`, PATCH `uiPrStatePatchSchema` → `uiPrStateResponseSchema`. Available without a review host too. */
    prState: '/api/ui/pr-state',
} as const;

/**
 * Server dev endpoints: exist only for PRs on the fixture host (prKey `fixture-*`),
 * no route is registered for other PRs. Same bearer token as UI endpoints.
 */
export const UI_DEV_ENDPOINTS = {
    /** POST without a body → `uiReviewWriteAckSchema`: the fixture "receives a push", the next declared iteration becomes active. */
    fixtureAdvanceIteration: '/api/dev/fixture/advance-iteration',
    /** POST `uiDevFixtureFailDraftWritesRequestSchema` → `uiReviewWriteAckSchema`: the fixture refuses draft writes (buffer). */
    fixtureFailDraftWrites: '/api/dev/fixture/fail-draft-writes',
    /** POST `uiDevUpdateAvailableRequestSchema` → `uiUpdateCheckResponseSchema`: inject a "new version" into `uiState.update`. */
    updateAvailable: '/api/dev/update-available',
} as const;

/** Body of the dev endpoint for draft write failures: `fail: false` restores the fixture to working order. */
export const uiDevFixtureFailDraftWritesRequestSchema = z.object({ fail: z.boolean() });
export type UiDevFixtureFailDraftWritesRequest = z.infer<typeof uiDevFixtureFailDraftWritesRequestSchema>;

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
