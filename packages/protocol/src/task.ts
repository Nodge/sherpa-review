import { z } from 'zod';

/**
 * Task types. `echo` is an M0 dummy task for exercising the loop. `route.skeleton`
 * (summary + stop plan + tour order) and `route.section` (filling planned stops), M2.
 * `chat` (reviewer question with selection context, markdown answer without a result schema), M3.
 * The remaining v1 types (`regenerate.*`) arrive in M4 with a protocol minor bump.
 * Validation rejects unknown types, fail-closed.
 */
export const taskTypeSchema = z.enum(['echo', 'route.skeleton', 'route.section', 'chat']);
export type TaskType = z.infer<typeof taskTypeSchema>;

/** Two priority classes (rpc-design §5): interactive tasks always precede background tasks, FIFO within each class. */
export const priorityClassSchema = z.enum(['interactive', 'background']);
export type PriorityClass = z.infer<typeof priorityClassSchema>;

/** Task identifier, shown as `sherpa/<id>` in prompts and the UI. */
export const taskIdSchema = z.number().int().positive();
export type TaskId = z.infer<typeof taskIdSchema>;

/**
 * Task issued to a worker. Self-contained (rpc-design §4): the session may have died
 * and reconnected. The payload contains all required context. Session memory is a bonus, not a contract.
 */
export const taskSchema = z.object({
    id: taskIdSchema,
    type: taskTypeSchema,
    priority: priorityClassSchema,
    /** Attempt number, starting at 1. Increases when an expired lease returns the task to the queue. */
    attempt: z.number().int().min(1),
    /** Ready-to-use task prompt for the model to read. Heavy context goes elsewhere. */
    instructions: z.string().min(1),
    /** Absolute paths to context files (markdown) materialized by the server. */
    contextFiles: z.array(z.string().min(1)),
    /** Path to the result JSON schema, only for structured tasks. Results are validated fail-closed. */
    resultSchemaFile: z.string().min(1).optional(),
});
export type Task = z.infer<typeof taskSchema>;

/**
 * Task lease (rpc-design §5). Not a dequeue: if the lease expires silently, the task returns
 * to the queue with an incremented attempt number.
 */
export const leaseSchema = z.object({
    taskId: taskIdSchema,
    ttlSeconds: z.number().int().positive(),
    /** ISO-8601. The server is the source of truth for time, the worker receives the deadline for reference. */
    expiresAt: z.iso.datetime(),
});
export type Lease = z.infer<typeof leaseSchema>;
