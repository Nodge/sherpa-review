import { z } from 'zod';

import { localeSchema } from './locale.js';
import { hostIdSchema } from './review.js';
import { taskIdSchema } from './task.js';

/**
 * Chat with the agent and agent notes (`docs/product.md §7`, scenario F2). Domain schemas. Endpoints and SSE are in `ui.ts`.
 *
 * The data model is an exchange (question + answer in one record), not a message feed: status
 * lives in one place, an "answer without a question" is unrepresentable, and cancel/retry address one
 * entity. The UI expands an exchange into a two-message feed
 * (you/agent, `docs/design/README.md §4`).
 */

/**
 * Question and note anchor: a line range on one side of a diff file (shaped like a
 * route stop anchor) in a specific iteration. `path` duplicates `fileId` for the chip
 * label ("order_service.py:148–151") and for when the file leaves the diff:
 * the label survives failed resolution. `diffId` is the iteration where the selection was made:
 * the server builds question context from its saved diff, even if it is no longer active.
 */
export const chatAnchorSchema = z.object({
    diffId: hostIdSchema,
    fileId: hostIdSchema,
    path: z.string().min(1),
    side: z.enum(['old', 'new']),
    /** Inclusive, with `end >= start`. Uses file line numbers on the corresponding side. */
    start: z.number().int().positive(),
    end: z.number().int().positive(),
});
export type ChatAnchor = z.infer<typeof chatAnchorSchema>;

/**
 * Exchange lifecycle. `queued` means the task is waiting for a worker (including while
 * the route is being generated, since the queue is fair, `docs/design/SPEC-elements.md §2.18`). `running` means the worker claimed
 * the task. Terminal states: `done` means the answer was accepted. `failed` means an error or exhausted
 * attempts, with the question preserved (`docs/design/SPEC-elements.md §3`), and `retry` queues a new task. `cancelled` means
 * the reviewer stopped it (a worker busy with a cancelled task learns about cancellation on
 * its next CLI call, `docs/protocol.md §5`, while the UI shows "agent is still busy").
 */
export const chatExchangeStatusSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled']);
export type ChatExchangeStatus = z.infer<typeof chatExchangeStatusSchema>;

export const chatExchangeIdSchema = z.number().int().positive();
export type ChatExchangeId = z.infer<typeof chatExchangeIdSchema>;

export const chatExchangeSchema = z.object({
    id: chatExchangeIdSchema,
    /** Reviewer question as entered (plain text). */
    question: z.string().min(1),
    /** null means a question about the whole PR (Ask AI), not a selection. */
    anchor: chatAnchorSchema.nullable(),
    status: chatExchangeStatusSchema,
    /**
     * Queue task answering the question (`retry` queues a new one, changing the id). The UI uses it
     * to find the record in the snapshot's `tasks`: while it has `heldByWorker`, the agent is busy with this
     * question, even if cancelled. null means an exchange without a task (the exchange outlived its loss).
     */
    taskId: taskIdSchema.nullable(),
    /** Markdown, only for `done`, otherwise null. No token streaming: arrives in full (`docs/protocol.md §6`). */
    answer: z.string().nullable(),
    /** Latest `task progress` line, only for `running`, otherwise null. */
    progressText: z.string().nullable(),
    /** Reason readable by the reviewer, only for `failed`, otherwise null. */
    error: z.string().nullable(),
    /** Requested answer language. null means an old-format exchange, read as English. */
    locale: localeSchema.nullable().default(null),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
});
export type ChatExchange = z.infer<typeof chatExchangeSchema>;

/**
 * Agent note beside code (`docs/design/SPEC-elements.md §2.16`): the server pins an accepted answer to an anchored question
 * as a note in the same transaction. It is local and never reaches the review backend.
 * `text` copies the answer: the note is self-contained, and lives and is deleted
 * independently of chat history. The UI derives the exchange's "pinned as a note" mark
 * by looking up `exchangeId`, so deleting the note clears the mark automatically.
 */
export const agentNoteIdSchema = z.number().int().positive();
export type AgentNoteId = z.infer<typeof agentNoteIdSchema>;

/**
 * Original note anchor, where it was pinned on creation. Does not change:
 * when migrating to a new iteration, `AgentNote.anchor` moves and `origin` stays.
 * `commit` is that iteration's reviewed commit. null means the server could not determine it.
 */
export const agentNoteOriginSchema = z.object({
    commit: z.string().nullable(),
    anchor: chatAnchorSchema,
});
export type AgentNoteOrigin = z.infer<typeof agentNoteOriginSchema>;

export const agentNoteSchema = z.object({
    id: agentNoteIdSchema,
    exchangeId: chatExchangeIdSchema,
    /** Current anchor: after a push, the server carries it to the active iteration using the interdiff. */
    anchor: chatAnchorSchema,
    /** Markdown copy of the accepted answer. */
    text: z.string().min(1),
    /**
     * A push touched the note range and the anchor could not be carried over (`docs/design/SPEC-elements.md §2.16`): the note
     * leaves the code and stays marked in chat. `anchor` keeps the last successful value.
     */
    lostAnchor: z.boolean(),
    origin: agentNoteOriginSchema,
    createdAt: z.iso.datetime(),
});
export type AgentNote = z.infer<typeof agentNoteSchema>;
