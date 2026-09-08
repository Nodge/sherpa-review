import type {
    Lease,
    PriorityClass,
    Task,
    TaskAckResponse,
    TaskCompleteResponse,
    TaskId,
    TaskStatus,
    TaskType,
} from '@sherpa/protocol';
import { LEASE_TTL_SECONDS, MAX_TASK_ATTEMPTS, RESULT_MAX_BYTES, taskSchema } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';
import { RpcFailure } from './errors.js';

const CLOSED_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'cancelled'];

export interface EnqueueInput {
    readonly type: TaskType;
    readonly priority: PriorityClass;
    readonly instructions: string;
    readonly contextFiles: readonly string[];
    readonly resultSchemaFile?: string;
}

/** Enqueues inside an external transaction. Call the effect only after it commits. */
export interface TransactionalEnqueue {
    readonly record: TaskRecord;
    readonly onCommitted: () => void;
}

/** A task issued to a worker, the contract pair from the `next` response. */
export interface LeasedTask {
    readonly task: Task;
    readonly lease: Lease;
}

/** A stored task, the contract fields plus server lifecycle fields. */
export type LeaseReturnReason = 'expired' | 'displaced';

export interface TaskRecord extends Task {
    readonly status: TaskStatus;
    readonly workerId: string | null;
    readonly leaseExpiresAt: string | null;
    readonly lastLeaseReturnReason: LeaseReturnReason | null;
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
 * Outcome of fail-closed result acceptance (docs/protocol.md §3). The queue calls `onCommitted` after
 * committing its transaction. Applying an accepted result writes to its own tables,
 * and `node:sqlite` has no nested transactions.
 *
 * `deferred` means validation is unavailable (the server has not loaded the task context yet). The model gets
 * the same rejection, but it is not at fault, so the rejection budget stays intact.
 */
export type TaskResultAcceptance =
    | { readonly kind: 'accepted'; readonly onCommitted?: () => void }
    | { readonly kind: 'rejected'; readonly errors: readonly string[] }
    | { readonly kind: 'deferred'; readonly errors: readonly string[] };

/**
 * Result acceptor for a typed task. Called synchronously inside the `complete` transaction,
 * so it must only validate. It can read storage but cannot write to it.
 * `null` means the task has another type. The queue closes it by its existing rules.
 */
export type TaskResultAcceptor = (task: TaskRecord, result: string) => TaskResultAcceptance | null;

/**
 * How many consecutive results the acceptor can reject on one lease. A rejection
 * keeps the lease and attempt ("fix it and call complete again"), but the loop must
 * stop. Once rejections run out, the task fails with the last raw output.
 */
export const MAX_RESULT_REJECTIONS = 3;

/** The only result requirement for tasks without an acceptor (`echo`). */
const EMPTY_RESULT_ERROR = 'The result is empty. Return a non-empty text and call `complete` again.';

/**
 * Transactions roll back everything an operation has done, so domain errors return as
 * values and become exceptions outside the transaction. Otherwise `result_too_large`
 * would lose the transition to `failed`.
 */
type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: RpcFailure };

interface TaskRow extends SqlRow {
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
    last_lease_return_reason: string | null;
    progress_text: string | null;
    result: string | null;
    fail_reason: string | null;
    rejections: number;
    created_at: string;
    updated_at: string;
}

/**
 * Task queue with leases (docs/protocol.md §5). `next` leases a task with a TTL instead of removing it.
 * A worker that dies silently does not lose its task. The lease expires and the task returns to the queue.
 * Leases expire lazily on entry to operations. The module has no timers.
 */
export class TaskQueue {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly changeListeners = new Set<() => void>();

    /**
     * Storage write count and the last count broadcast. Notifications go out after
     * the transaction commits and only if something changed. Pure reads stay silent.
     */
    private mutations = 0;
    private announcedMutations = 0;

    /** Result acceptor. Without one, the only requirement is a nonempty result. */
    private acceptor: TaskResultAcceptor | null = null;

    /** What to do with an accepted result after the `complete` transaction commits. */
    private commitEffects: (() => void)[] = [];

    private readonly txEnqueue: (input: EnqueueInput) => TransactionalEnqueue;
    private readonly txNext: (workerId: string) => Outcome<LeasedTask | null>;
    private readonly txComplete: (workerId: string, taskId: TaskId, result: string) => Outcome<TaskCompleteResponse>;
    private readonly txFail: (workerId: string, taskId: TaskId, reason: string) => Outcome<TaskAckResponse>;
    private readonly txProgress: (workerId: string, taskId: TaskId, text: string) => Outcome<TaskAckResponse>;
    private readonly txCancel: (taskId: TaskId) => Outcome<CancelOutcome>;
    private readonly txReleaseLeasesOf: (workerId: string) => void;
    private readonly txReleaseCancelledHoldsOf: (workerId: string) => void;
    private readonly txListTasks: () => TaskRecord[];
    private readonly txGetTask: (taskId: TaskId) => TaskRecord | null;

    constructor(options: TaskQueueOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());

        this.txEnqueue = transaction(this.db, (input: EnqueueInput) => this.enqueueInTransaction(input));
        this.txNext = transaction(this.db, (workerId: string) => this.nextInTransaction(workerId));
        this.txComplete = transaction(this.db, (workerId: string, taskId: TaskId, result: string) =>
            this.completeInTransaction(workerId, taskId, result),
        );
        this.txFail = transaction(this.db, (workerId: string, taskId: TaskId, reason: string) =>
            this.failInTransaction(workerId, taskId, reason),
        );
        this.txProgress = transaction(this.db, (workerId: string, taskId: TaskId, text: string) =>
            this.progressInTransaction(workerId, taskId, text),
        );
        this.txCancel = transaction(this.db, (taskId: TaskId) => this.cancelInTransaction(taskId));
        this.txReleaseLeasesOf = transaction(this.db, (workerId: string) => {
            this.releaseLeasesInTransaction(workerId);
        });
        this.txReleaseCancelledHoldsOf = transaction(this.db, (workerId: string) => {
            this.releaseCancelledHoldsInTransaction(workerId);
        });
        this.txListTasks = transaction(this.db, () => {
            this.expireLeases();
            const rows = this.db.prepare('SELECT * FROM tasks ORDER BY id').all() as TaskRow[];
            return rows.map(toRecord);
        });
        this.txGetTask = transaction(this.db, (taskId: TaskId) => {
            this.expireLeases();
            const row = this.findRow(taskId);
            return row === null ? null : toRecord(row);
        });
    }

    /**
     * Subscribes to any queue change for the UI SSE channel and long-poll `next` endpoint:
     * enqueuing, leasing, `complete`/`fail`/`progress`/`cancel` and requeuing tasks on
     * lease expiry, including lazy expiry inside another operation.
     * Returns an unsubscribe function.
     */
    subscribeChanges(listener: () => void): () => void {
        this.changeListeners.add(listener);
        return () => {
            this.changeListeners.delete(listener);
        };
    }

    enqueue(input: EnqueueInput): TaskRecord {
        const enqueued = this.txEnqueue(input);
        enqueued.onCommitted();
        return enqueued.record;
    }

    /**
     * Inserts a task inside an open transaction. Chat needs the exchange and its task to appear
     * atomically. `onCommitted` wakes subscribers only after the outer transaction commits successfully.
     */
    enqueueInTransaction(input: EnqueueInput): TransactionalEnqueue {
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
        let announced = false;
        return {
            record,
            onCommitted: () => {
                if (announced) {
                    return;
                }
                announced = true;
                this.markChanged();
                this.flushChanges();
            },
        };
    }

    /** Leases the next task. `null` means an empty queue (the endpoint turns this into long-poll). */
    next(workerId: string): LeasedTask | null {
        return this.settle(this.txNext(workerId));
    }

    /**
     * Enables fail-closed result acceptance, installed by the route orchestrator.
     * One per queue. The acceptor decides how to handle each task type.
     */
    setResultAcceptor(acceptor: TaskResultAcceptor | null): void {
        this.acceptor = acceptor;
    }

    complete(workerId: string, taskId: TaskId, result: string): TaskCompleteResponse {
        try {
            return this.settle(this.txComplete(workerId, taskId, result));
        } catch (error) {
            // The entire transaction rolled back, so there is no accepted result to apply.
            this.commitEffects = [];
            throw error;
        }
    }

    fail(workerId: string, taskId: TaskId, reason: string): TaskAckResponse {
        return this.settle(this.txFail(workerId, taskId, reason));
    }

    progress(workerId: string, taskId: TaskId, text: string): TaskAckResponse {
        return this.settle(this.txProgress(workerId, taskId, text));
    }

    /**
     * Cancellation from the UI. A leased task is marked cancelled. The session cannot be interrupted,
     * so the worker learns on its next call for this task (it gets `noop`). Until then,
     * the hold remains, with `worker_id`/`lease_expires_at` on the cancelled task.
     */
    cancel(taskId: TaskId): CancelOutcome {
        return this.settle(this.txCancel(taskId));
    }

    /**
     * Immediately releases leases of a displaced worker when a new session takes its slot
     * (docs/protocol.md §7). The slot is no longer its own, so there is no reason to wait for TTL expiry. Otherwise,
     * after reconnecting the task would sit until the TTL ends, half an hour for a background task. The semantics match
     * expiry. The attempt increments, and exhausted attempts fail the task. Holds on
     * cancelled tasks are simply cleared. There is nothing to requeue.
     */
    releaseLeasesOf(workerId: string): void {
        this.txReleaseLeasesOf(workerId);
        this.flushChanges();
    }

    /**
     * The worker leaves without asking for new work (a `done` response to `next`). It is no longer
     * running cancelled tasks, so clear the hold here. Otherwise it stays until TTL expiry, and the UI
     * shows "agent working" for a session that no longer exists.
     */
    releaseCancelledHoldsOf(workerId: string): void {
        this.txReleaseCancelledHoldsOf(workerId);
        this.flushChanges();
    }

    /**
     * How long the worker has a lease, the latest expiry among its leases. `null` means no leases.
     * Returns the time unchanged, even if it is in the past. The worker lifecycle uses it to determine
     * both whether it is working now and when work ends. Otherwise there is no time to use
     * for the worker death timer. Pure read with no side effects. Frequent calls must not move the queue,
     * so expired leases are not requeued here.
     *
     * Does not filter by status. A hold on a cancelled task also keeps the worker busy,
     * so it must not appear disconnected.
     */
    leaseExpiryOf(workerId: string): string | null {
        const row = this.db
            .prepare(
                `SELECT MAX(lease_expires_at) AS expires_at FROM tasks
                 WHERE worker_id = ? AND lease_expires_at IS NOT NULL`,
            )
            .get(workerId) as { expires_at: string | null } | undefined;
        return row?.expires_at ?? null;
    }

    /**
     * Reads also expire leases. Otherwise a worker that dies silently, with nobody else calling
     * operations on its tasks, would leave a seemingly live lease in the UI forever.
     */
    listTasks(): TaskRecord[] {
        const records = this.txListTasks();
        this.flushChanges();
        return records;
    }

    getTask(taskId: TaskId): TaskRecord | null {
        const record = this.txGetTask(taskId);
        this.flushChanges();
        return record;
    }

    private nextInTransaction(workerId: string): Outcome<LeasedTask | null> {
        this.expireLeases();
        // The worker has come for new work, so it is no longer running cancelled tasks.
        this.releaseCancelledHoldsInTransaction(workerId);

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
        // The acceptance rejection count belongs to the lease. A new lease gives the model all attempts again.
        // Also clear the previous lease release reason. The task is live again, so the old `expired`/
        // `displaced` must not survive re-leasing and confuse state reconciliation after restart.
        this.db
            .prepare(
                `UPDATE tasks SET status = 'leased', worker_id = ?, lease_expires_at = ?, rejections = 0,
                 last_lease_return_reason = NULL, updated_at = ? WHERE id = ?`,
            )
            .run(workerId, expiresAt, nowIso, candidate.id);
        this.markChanged();

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
            // docs/architecture.md §7.5: exceeding the limit fails the task instead of asking for a retry.
            // The card reason is for the reviewer (Russian), the error text is for the model (English).
            this.closeTask(taskId, 'failed', {
                failReason:
                    `Result exceeds the limit: ${String(bytes)} bytes with a maximum of ` +
                    `${String(RESULT_MAX_BYTES)}. The task has failed.`,
            });
            return fail(
                new RpcFailure(
                    'result_too_large',
                    `The result exceeds the limit: ${String(bytes)} bytes against the allowed ` +
                        `${String(RESULT_MAX_BYTES)}. The task is closed with an error.`,
                ),
            );
        }

        // Fail-closed acceptance against the result schema. The route orchestrator validates typed tasks
        // (`route.*`). `echo` has no acceptor, so its single existing requirement still applies.
        const acceptance = this.acceptor?.(toRecord(owned.value), result) ?? null;
        if (acceptance === null && result.trim() === '') {
            // This rejection is not from the acceptor. It leaves the rejection budget and lease intact.
            return ok({ kind: 'rejected', errors: [EMPTY_RESULT_ERROR] });
        }
        if (acceptance?.kind === 'deferred') {
            return ok(deferResult(taskId, acceptance.errors));
        }
        if (acceptance?.kind === 'rejected') {
            return ok(this.rejectResult(owned.value, result, acceptance.errors));
        }

        this.closeTask(taskId, 'done', { result });
        if (acceptance?.onCommitted !== undefined) {
            this.commitEffects.push(acceptance.onCommitted);
        }
        return ok({ kind: 'accepted', message: acceptedMessage(taskId) });
    }

    /**
     * The result was not accepted. The model keeps the lease and attempt, fixes the output
     * and calls `complete` again (docs/protocol.md §3). The loop stops after `MAX_RESULT_REJECTIONS` rejections
     * per lease. The task then fails, and the last raw output remains in `result`
     * (shown by "Open raw output", docs/design/README.md §12).
     */
    private rejectResult(row: TaskRow, result: string, errors: readonly string[]): TaskCompleteResponse {
        const rejections = row.rejections + 1;
        this.db
            .prepare('UPDATE tasks SET rejections = ?, updated_at = ? WHERE id = ?')
            .run(rejections, this.nowIso(), row.id);
        this.markChanged();

        const id = `sherpa/${String(row.id)}`;
        if (rejections >= MAX_RESULT_REJECTIONS) {
            this.closeTask(row.id, 'failed', {
                result,
                failReason:
                    `The agent submitted a result that failed validation ${String(MAX_RESULT_REJECTIONS)} times ` +
                    'in a row. The task has failed.',
            });
            return {
                kind: 'rejected',
                errors: [
                    ...errors,
                    `This was rejection ${String(rejections)} of ${String(MAX_RESULT_REJECTIONS)}: task ${id} is ` +
                        'now closed with an error. Do not call `complete` for it again — call `worker next`.',
                ],
            };
        }

        return {
            kind: 'rejected',
            errors: [
                ...errors,
                `Rejection ${String(rejections)} of ${String(MAX_RESULT_REJECTIONS)} for task ${id}: fix the ` +
                    'result and call `complete` again — the task is still leased to you.',
            ],
        };
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
        this.markChanged();
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

        if (row.status === 'leased') {
            // The session cannot be interrupted. The task is closed, but its holder does not know yet
            // (docs/protocol.md §5). `worker_id`/`lease_expires_at` remain so the UI shows
            // that the agent is still busy with the cancelled task.
            this.db
                .prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?")
                .run(this.nowIso(), taskId);
            this.markChanged();
            return ok('cancelled');
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
            // The holder of the cancelled task called back and learned of cancellation from `noop`.
            if (row.worker_id === workerId) {
                this.releaseHold(taskId);
            }
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
     * Exhausted attempts fail the task visibly in the UI. Cancelled tasks have nothing to requeue.
     * An expired hold only means the holder no longer counts as busy.
     */
    private expireLeases(): void {
        const nowIso = this.nowIso();
        const expired = this.db
            .prepare(
                `SELECT id, attempt, status FROM tasks
                 WHERE status IN ('leased', 'cancelled')
                   AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
            )
            .all(nowIso) as { id: number; attempt: number; status: string }[];

        for (const row of expired) {
            if (row.status === 'cancelled') {
                this.releaseHold(row.id);
                continue;
            }
            this.requeueLease(row, 'expired');
        }
    }

    /** Leases of a displaced worker take the expiry path without waiting for the expiry time. */
    private releaseLeasesInTransaction(workerId: string): void {
        const held = this.db
            .prepare("SELECT id, attempt FROM tasks WHERE status = 'leased' AND worker_id = ?")
            .all(workerId) as { id: number; attempt: number }[];

        for (const row of held) {
            this.requeueLease(row, 'displaced');
        }
        this.releaseCancelledHoldsInTransaction(workerId);
    }

    /** Clears all holds on this worker's cancelled tasks. It no longer runs them. */
    private releaseCancelledHoldsInTransaction(workerId: string): void {
        const held = this.db
            .prepare("SELECT id FROM tasks WHERE status = 'cancelled' AND worker_id = ?")
            .all(workerId) as { id: number }[];

        for (const row of held) {
            this.releaseHold(row.id);
        }
    }

    /** Clears a hold on a closed task without changing its status or attempt. */
    private releaseHold(taskId: TaskId): void {
        this.db
            .prepare('UPDATE tasks SET worker_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?')
            .run(this.nowIso(), taskId);
        this.markChanged();
    }

    /** Requeues one leased task and increments the attempt. Exhausted attempts fail it. */
    private requeueLease(row: { id: number; attempt: number }, reason: LeaseReturnReason): void {
        const nowIso = this.nowIso();
        this.markChanged();

        const attempt = row.attempt + 1;
        if (attempt > MAX_TASK_ATTEMPTS) {
            this.db
                .prepare(
                    `UPDATE tasks SET status = 'failed', worker_id = NULL, lease_expires_at = NULL,
                     last_lease_return_reason = ?, fail_reason = ?, updated_at = ? WHERE id = ?`,
                )
                .run(
                    reason,
                    // Only the reviewer sees the failure reason in the UI, so the text is Russian.
                    `The worker took the task ${String(MAX_TASK_ATTEMPTS)} times without completing it. ` +
                        'attempts exhausted.',
                    nowIso,
                    row.id,
                );
            return;
        }

        this.db
            .prepare(
                `UPDATE tasks SET status = 'queued', attempt = ?, worker_id = NULL, lease_expires_at = NULL,
                 last_lease_return_reason = ?, updated_at = ? WHERE id = ?`,
            )
            .run(attempt, reason, nowIso, row.id);
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
        this.markChanged();
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

    /**
     * Finishes a transactional operation. First applies the accepted result and broadcasts
     * changes (the transaction has committed), then throws the domain error. Otherwise subscribers
     * would miss what was written (for example, the transition to `failed`
     * on `result_too_large`).
     */
    private settle<T>(outcome: Outcome<T>): T {
        this.runCommitEffects();
        this.flushChanges();
        return unwrap(outcome);
    }

    /**
     * Accepted results apply outside the queue transaction. The acceptor writes to its own tables
     * in its own transactions, and `node:sqlite` cannot nest `BEGIN`. A failed application
     * must not fail `complete`. The result is already accepted and stored.
     */
    private runCommitEffects(): void {
        const effects = this.commitEffects;
        this.commitEffects = [];
        for (const effect of effects) {
            try {
                effect();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                process.stderr.write(`sherpa-server: failed to apply accepted result: ${message}\n`);
            }
        }
    }

    /** Records a storage write inside transactions. `flushChanges` broadcasts it. */
    private markChanged(): void {
        this.mutations += 1;
    }

    private flushChanges(): void {
        if (this.mutations === this.announcedMutations) {
            return;
        }

        this.announcedMutations = this.mutations;
        for (const listener of [...this.changeListeners]) {
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

function acceptedMessage(taskId: TaskId): string {
    return `The result of task sherpa/${String(taskId)} is accepted.`;
}

/**
 * The acceptor declined validation because the server cannot validate right now. Storage
 * stays unchanged, including the attempt, rejection count and lease. The model simply retries
 * later. Otherwise a temporary server failure would consume the rejection budget and fail the task.
 */
function deferResult(taskId: TaskId, errors: readonly string[]): TaskCompleteResponse {
    return {
        kind: 'rejected',
        errors: [
            ...errors,
            `This is not a rejection of your work: task sherpa/${String(taskId)} is still leased to you and ` +
                'nothing has been spent on this attempt.',
        ],
    };
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
            return `Task ${id} has been cancelled — there is nothing to do.`;
        case 'done':
            return `Task ${id} is already finished, calling again changes nothing.`;
        default:
            return `Task ${id} is already closed with an error, calling again changes nothing.`;
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
        lastLeaseReturnReason: row.last_lease_return_reason as LeaseReturnReason | null,
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
