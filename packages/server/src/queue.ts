import type {
    Lease,
    PriorityClass,
    Task,
    TaskAckResponse,
    TaskCompleteResponse,
    TaskId,
    TaskType,
} from '@sherpa/protocol';
import { LEASE_TTL_SECONDS, MAX_TASK_ATTEMPTS, RESULT_MAX_BYTES, taskSchema } from '@sherpa/protocol';

import type { SherpaDatabase } from './db.js';
import { RpcFailure } from './errors.js';

/** Task lifecycle (rpc-design §5). Closed statuses are irreversible. */
export type TaskStatus = 'queued' | 'leased' | 'done' | 'failed' | 'cancelled';

const CLOSED_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'cancelled'];

export interface EnqueueInput {
    readonly type: TaskType;
    readonly priority: PriorityClass;
    readonly instructions: string;
    readonly contextFiles: readonly string[];
    readonly resultSchemaFile?: string;
}

/** A task issued to a worker, the contract pair from the `next` response. */
export interface LeasedTask {
    readonly task: Task;
    readonly lease: Lease;
}

/** A stored task, the contract fields plus server lifecycle fields. */
export interface TaskRecord extends Task {
    readonly status: TaskStatus;
    readonly workerId: string | null;
    readonly leaseExpiresAt: string | null;
    readonly progressText: string | null;
    readonly result: string | null;
    readonly failReason: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
}

export interface TaskQueueOptions {
    readonly db: SherpaDatabase;
    /** Injectable clock lets tests expire leases without waiting in real time. */
    readonly now?: () => Date;
}

/** The result of cancellation from the UI. */
export type CancelOutcome = 'cancelled' | 'noop';

/**
 * Transactions roll back everything an operation has done, so domain errors return as
 * values and become exceptions outside the transaction. Otherwise `result_too_large`
 * would lose the transition to `failed`.
 */
type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: RpcFailure };

interface TaskRow {
    id: number;
    type: string;
    priority: string;
    instructions: string;
    context_files: string;
    result_schema_file: string | null;
    status: string;
    attempt: number;
    worker_id: string | null;
    lease_expires_at: string | null;
    progress_text: string | null;
    result: string | null;
    fail_reason: string | null;
    created_at: string;
    updated_at: string;
}

/**
 * Task queue with leases (rpc-design §5): `next` leases a task with a TTL instead of removing it.
 * A worker that dies silently does not lose its task. The lease expires and the task returns to the queue.
 * Leases expire lazily on entry to operations. The module has no timers.
 */
export class TaskQueue {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly listeners = new Set<() => void>();

    private readonly txNext: (workerId: string) => Outcome<LeasedTask | null>;
    private readonly txComplete: (workerId: string, taskId: TaskId, result: string) => Outcome<TaskCompleteResponse>;
    private readonly txFail: (workerId: string, taskId: TaskId, reason: string) => Outcome<TaskAckResponse>;
    private readonly txProgress: (workerId: string, taskId: TaskId, text: string) => Outcome<TaskAckResponse>;
    private readonly txCancel: (taskId: TaskId) => Outcome<CancelOutcome>;
    private readonly txListTasks: () => TaskRecord[];
    private readonly txGetTask: (taskId: TaskId) => TaskRecord | null;

    constructor(options: TaskQueueOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());

        this.txNext = this.db.transaction((workerId: string) => this.nextInTransaction(workerId));
        this.txComplete = this.db.transaction((workerId: string, taskId: TaskId, result: string) =>
            this.completeInTransaction(workerId, taskId, result),
        );
        this.txFail = this.db.transaction((workerId: string, taskId: TaskId, reason: string) =>
            this.failInTransaction(workerId, taskId, reason),
        );
        this.txProgress = this.db.transaction((workerId: string, taskId: TaskId, text: string) =>
            this.progressInTransaction(workerId, taskId, text),
        );
        this.txCancel = this.db.transaction((taskId: TaskId) => this.cancelInTransaction(taskId));
        this.txListTasks = this.db.transaction(() => {
            this.expireLeases();
            const rows = this.db.prepare('SELECT * FROM tasks ORDER BY id').all() as TaskRow[];
            return rows.map(toRecord);
        });
        this.txGetTask = this.db.transaction((taskId: TaskId) => {
            this.expireLeases();
            const row = this.findRow(taskId);
            return row === null ? null : toRecord(row);
        });
    }

    /**
     * Subscription to tasks becoming available in the queue, used by the `next` endpoint's long-poll.
     * Returns an unsubscribe function.
     */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    enqueue(input: EnqueueInput): TaskRecord {
        const nowIso = this.nowIso();
        const info = this.db
            .prepare(
                `INSERT INTO tasks (
                    type, priority, instructions, context_files, result_schema_file,
                    status, attempt, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'queued', 1, ?, ?)`,
            )
            .run(
                input.type,
                input.priority,
                input.instructions,
                JSON.stringify([...input.contextFiles]),
                input.resultSchemaFile ?? null,
                nowIso,
                nowIso,
            );

        const record = this.requireRecord(Number(info.lastInsertRowid));
        this.notify();
        return record;
    }

    /** Leases the next task. `null` means an empty queue (the endpoint turns this into long-poll). */
    next(workerId: string): LeasedTask | null {
        return unwrap(this.txNext(workerId));
    }

    complete(workerId: string, taskId: TaskId, result: string): TaskCompleteResponse {
        return unwrap(this.txComplete(workerId, taskId, result));
    }

    fail(workerId: string, taskId: TaskId, reason: string): TaskAckResponse {
        return unwrap(this.txFail(workerId, taskId, reason));
    }

    progress(workerId: string, taskId: TaskId, text: string): TaskAckResponse {
        return unwrap(this.txProgress(workerId, taskId, text));
    }

    /**
     * Cancellation from the UI. A leased task is marked cancelled. The session cannot be interrupted,
     * the worker learns on its next call for this task (receives `noop`).
     */
    cancel(taskId: TaskId): CancelOutcome {
        return unwrap(this.txCancel(taskId));
    }

    /**
     * Reads also expire leases. Otherwise a worker that dies silently, with nobody else calling
     * operations on its tasks, would leave a seemingly live lease in the UI forever.
     */
    listTasks(): TaskRecord[] {
        return this.txListTasks();
    }

    getTask(taskId: TaskId): TaskRecord | null {
        return this.txGetTask(taskId);
    }

    private nextInTransaction(workerId: string): Outcome<LeasedTask | null> {
        this.expireLeases();

        // Idempotency. Return this worker's live lease unchanged so it finishes what it started.
        const held = this.db
            .prepare("SELECT * FROM tasks WHERE status = 'leased' AND worker_id = ? ORDER BY id LIMIT 1")
            .get(workerId) as TaskRow | undefined;
        if (held !== undefined) {
            return ok(this.toLeasedTask(held));
        }

        const candidate = this.db
            .prepare(
                `SELECT * FROM tasks WHERE status = 'queued'
                 ORDER BY CASE priority WHEN 'interactive' THEN 0 ELSE 1 END, id
                 LIMIT 1`,
            )
            .get() as TaskRow | undefined;
        if (candidate === undefined) {
            return ok(null);
        }

        const ttlSeconds = LEASE_TTL_SECONDS[candidate.priority as PriorityClass];
        const nowIso = this.nowIso();
        const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000).toISOString();
        this.db
            .prepare(
                `UPDATE tasks SET status = 'leased', worker_id = ?, lease_expires_at = ?, updated_at = ?
                 WHERE id = ?`,
            )
            .run(workerId, expiresAt, nowIso, candidate.id);

        return ok(this.toLeasedTask(this.requireRow(candidate.id)));
    }

    private completeInTransaction(workerId: string, taskId: TaskId, result: string): Outcome<TaskCompleteResponse> {
        const owned = this.requireOwnedTask(workerId, taskId);
        if (!owned.ok) {
            return owned;
        }
        if (owned.value === null) {
            return ok(closedNoop(this.requireRow(taskId)));
        }

        const bytes = Buffer.byteLength(result, 'utf8');
        if (bytes > RESULT_MAX_BYTES) {
            // Spec §3.5: exceeding the limit fails the task, rather than asking to try again.
            const reason =
                `Result exceeds the limit: ${String(bytes)} bytes, maximum ${String(RESULT_MAX_BYTES)}. ` +
                'The task has failed.';
            this.closeTask(taskId, 'failed', { failReason: reason });
            return fail(new RpcFailure('result_too_large', reason));
        }

        // Fail-closed acceptance against a result schema arrives with typed tasks (M2).
        // For `echo`, the only requirement is a nonempty result.
        if (result.trim() === '') {
            return ok({
                kind: 'rejected',
                errors: ['The result is empty. Return nonempty text and call `complete` again.'],
            });
        }

        this.closeTask(taskId, 'done', { result });
        return ok({ kind: 'accepted', message: `The result of task sherpa/${String(taskId)} is accepted.` });
    }

    private failInTransaction(workerId: string, taskId: TaskId, reason: string): Outcome<TaskAckResponse> {
        const owned = this.requireOwnedTask(workerId, taskId);
        if (!owned.ok) {
            return owned;
        }
        if (owned.value === null) {
            return ok(closedAck(this.requireRow(taskId)));
        }

        this.closeTask(taskId, 'failed', { failReason: reason });
        return ok({ kind: 'accepted' });
    }

    private progressInTransaction(workerId: string, taskId: TaskId, text: string): Outcome<TaskAckResponse> {
        const owned = this.requireOwnedTask(workerId, taskId);
        if (!owned.ok) {
            return owned;
        }
        if (owned.value === null) {
            return ok(closedAck(this.requireRow(taskId)));
        }

        this.db
            .prepare('UPDATE tasks SET progress_text = ?, updated_at = ? WHERE id = ?')
            .run(text, this.nowIso(), taskId);
        return ok({ kind: 'accepted' });
    }

    private cancelInTransaction(taskId: TaskId): Outcome<CancelOutcome> {
        this.expireLeases();

        const row = this.findRow(taskId);
        if (row === null) {
            return fail(unknownTask(taskId));
        }
        if (isClosed(row)) {
            return ok('noop');
        }

        this.closeTask(taskId, 'cancelled', {});
        return ok('cancelled');
    }

    /**
     * Shared check for worker endpoints. The task exists, is not closed and is leased by this worker.
     * `value === null` means the task is already closed, so the caller should return `noop`.
     */
    private requireOwnedTask(workerId: string, taskId: TaskId): Outcome<TaskRow | null> {
        this.expireLeases();

        const row = this.findRow(taskId);
        if (row === null) {
            return fail(unknownTask(taskId));
        }
        if (isClosed(row)) {
            return ok(null);
        }
        if (row.status !== 'leased' || row.worker_id !== workerId) {
            return fail(
                new RpcFailure(
                    'lease_not_held',
                    `Task sherpa/${String(taskId)} is not leased to worker ${workerId}: the lease expired ` +
                        'or another session holds the task. Call `worker next` and work on the task it gives you.',
                ),
            );
        }
        return ok(row);
    }

    /**
     * Requeues tasks with expired leases (a worker died silently) and increments the attempt.
     * exhausted attempts mean a task failure visible in the UI.
     */
    private expireLeases(): void {
        const nowIso = this.nowIso();
        const expired = this.db
            .prepare(
                `SELECT id, attempt FROM tasks
                 WHERE status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
            )
            .all(nowIso) as { id: number; attempt: number }[];

        for (const row of expired) {
            const attempt = row.attempt + 1;
            if (attempt > MAX_TASK_ATTEMPTS) {
                this.db
                    .prepare(
                        `UPDATE tasks SET status = 'failed', worker_id = NULL, lease_expires_at = NULL,
                         fail_reason = ?, updated_at = ? WHERE id = ?`,
                    )
                    .run(
                        `The worker took the task ${String(MAX_TASK_ATTEMPTS)} times and never completed it. ` +
                            'No attempts remain.',
                        nowIso,
                        row.id,
                    );
                continue;
            }

            this.db
                .prepare(
                    `UPDATE tasks SET status = 'queued', attempt = ?, worker_id = NULL, lease_expires_at = NULL,
                     updated_at = ? WHERE id = ?`,
                )
                .run(attempt, nowIso, row.id);
        }
    }

    private closeTask(
        taskId: TaskId,
        status: Extract<TaskStatus, 'done' | 'failed' | 'cancelled'>,
        fields: { result?: string; failReason?: string },
    ): void {
        this.db
            .prepare(
                `UPDATE tasks SET status = ?, worker_id = NULL, lease_expires_at = NULL,
                 result = COALESCE(?, result), fail_reason = COALESCE(?, fail_reason), updated_at = ?
                 WHERE id = ?`,
            )
            .run(status, fields.result ?? null, fields.failReason ?? null, this.nowIso(), taskId);
    }

    private toLeasedTask(row: TaskRow): LeasedTask {
        const record = toRecord(row);
        if (row.lease_expires_at === null) {
            throw new Error(`Task sherpa/${String(row.id)} has status leased without a lease expiry.`);
        }

        // Only the validated contract fields go out. zod strips the server fields.
        return {
            task: taskSchema.parse(record),
            lease: {
                taskId: record.id,
                ttlSeconds: LEASE_TTL_SECONDS[record.priority],
                expiresAt: row.lease_expires_at,
            },
        };
    }

    private findRow(taskId: TaskId): TaskRow | null {
        const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
        return row ?? null;
    }

    private requireRow(taskId: TaskId): TaskRow {
        const row = this.findRow(taskId);
        if (row === null) {
            throw new Error(`Task sherpa/${String(taskId)} is not in storage.`);
        }
        return row;
    }

    private requireRecord(taskId: TaskId): TaskRecord {
        return toRecord(this.requireRow(taskId));
    }

    private notify(): void {
        for (const listener of [...this.listeners]) {
            listener();
        }
    }

    private nowIso(): string {
        return this.now().toISOString();
    }
}

function ok<T>(value: T): Outcome<T> {
    return { ok: true, value };
}

function fail<T>(failure: RpcFailure): Outcome<T> {
    return { ok: false, failure };
}

function unwrap<T>(outcome: Outcome<T>): T {
    if (!outcome.ok) {
        throw outcome.failure;
    }
    return outcome.value;
}

function unknownTask(taskId: TaskId): RpcFailure {
    return new RpcFailure(
        'unknown_task',
        `Task sherpa/${String(taskId)} does not exist. Check the task number in the output of \`worker next\`.`,
    );
}

function isClosed(row: TaskRow): boolean {
    return CLOSED_STATUSES.includes(row.status as TaskStatus);
}

function closedNoop(row: TaskRow): TaskCompleteResponse {
    return { kind: 'noop', message: closedMessage(row) };
}

function closedAck(row: TaskRow): TaskAckResponse {
    return { kind: 'noop', message: closedMessage(row) };
}

function closedMessage(row: TaskRow): string {
    const id = `sherpa/${String(row.id)}`;
    switch (row.status as TaskStatus) {
        case 'cancelled':
            return `Task ${id} was cancelled, nothing needs to be done.`;
        case 'done':
            return `Task ${id} is already complete, a repeated call changes nothing.`;
        default:
            return `Task ${id} has already failed, a repeated call changes nothing.`;
    }
}

function toRecord(row: TaskRow): TaskRecord {
    return {
        id: row.id,
        type: row.type as TaskType,
        priority: row.priority as PriorityClass,
        attempt: row.attempt,
        instructions: row.instructions,
        contextFiles: parseContextFiles(row.context_files),
        ...(row.result_schema_file === null ? {} : { resultSchemaFile: row.result_schema_file }),
        status: row.status as TaskStatus,
        workerId: row.worker_id,
        leaseExpiresAt: row.lease_expires_at,
        progressText: row.progress_text,
        result: row.result,
        failReason: row.fail_reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function parseContextFiles(raw: string): string[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`Task context file list is corrupt: ${raw}`);
    }

    if (!Array.isArray(parsed)) {
        throw new Error(`Task context file list is corrupt: ${raw}`);
    }
    const items: unknown[] = parsed;
    const files = items.filter((item): item is string => typeof item === 'string');
    if (files.length !== items.length) {
        throw new Error(`Task context file list is corrupt: ${raw}`);
    }
    return files;
}
