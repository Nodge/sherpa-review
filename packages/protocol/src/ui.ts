import { z } from 'zod';

import { prKeySchema } from './manifest.js';
import { workerStatusSchema } from './messages.js';
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
 * UI channel endpoints. All require a bearer token except `events`: EventSource does not support
 * headers, so the SSE endpoint accepts the token in the `?token=` query parameter (localhost, own logs).
 */
export const UI_ENDPOINTS = {
    /** GET → `uiStateSchema`. */
    state: '/api/ui/state',
    /** POST `uiEnqueueRequestSchema` → `uiEnqueueResponseSchema`. */
    enqueue: '/api/ui/tasks',
    /** POST `uiCancelRequestSchema` → `uiCancelResponseSchema`. */
    cancel: '/api/ui/tasks/cancel',
    /** GET, SSE: `state` events with `uiStateSchema` JSON. */
    events: '/api/ui/events',
} as const;

/** SSE event name for a state snapshot. */
export const UI_STATE_EVENT = 'state';
