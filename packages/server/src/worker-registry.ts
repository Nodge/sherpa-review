import type { WorkerStatus } from '@sherpa/protocol';
import { WORKER_DEAD_AFTER_SECONDS } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';
import { RpcFailure } from './errors.js';

export interface WorkerRegistryOptions {
    readonly db: SherpaDatabase;
    /** Injectable clock: tests exercise worker death without actually waiting. */
    readonly now?: () => Date;
    /**
     * Worker task lease expiry (ISO), read-only access to the queue
     * (`TaskQueue.leaseExpiryOf`). Defaults to assuming there are no leases.
     */
    readonly leaseExpiryOf?: (workerId: string) => string | null;
    /** Grace period between calls (`WORKER_GAP_GRACE_SECONDS`), shortened in tests. */
    readonly gapGraceSeconds?: number;
}

/** Listener for worker status changes, to be used by the UI channel (M0-T7). */
export type WorkerStatusListener = (status: WorkerStatus) => void;

/**
 * Transactions roll back everything an operation has done, so domain errors return as
 * as values and become exceptions outside the transaction (the same approach as in `queue.ts`).
 */
type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: RpcFailure };

interface WorkerRow extends SqlRow {
    worker_id: string;
    harness: string | null;
    model: string | null;
    registered_at: string;
    last_seen_at: string;
}

/** The only table row: each PR has one worker. */
const SLOT_ID = 1;

const DEAD_AFTER_MS = WORKER_DEAD_AFTER_SECONDS * 1000;

/**
 * Pause without an open connection or lease after which the session is considered dead
 * (decision 2026-08-20). An idle worker hangs in long-poll `next`, so it has no connection
 * only between one call returning and the next call, a few seconds of model work.
 * Internal server policy, outside the contract.
 */
export const WORKER_GAP_GRACE_SECONDS = 60;

/**
 * PR worker lifecycle (rpc-design §7): session registration, heartbeat on every CLI call,
 * transition to "Agent disconnected" on either a broken connection or silence.
 *
 * A worker is alive if at least one condition holds:
 * 1. its worker connection is open (a pending long-poll `next` or any request in flight).
 *    The OS closes the socket as soon as a session is killed, which is a strong signal.
 * 2. it holds a task lease and less than `WORKER_DEAD_AFTER_SECONDS` has passed since its last call.
 *    The model can stay silent for minutes while working on a task. An expired lease no longer
 *    counts as work.
 * 3. with no connection or lease, the time since the last call or connection closure is less than
 *    `WORKER_GAP_GRACE_SECONDS`.
 *
 * Liveness is evaluated lazily on reads, like lease expiry in the queue. The timer is only needed
 * to emit the "Agent disconnected" event without incoming requests. Nothing else would emit it.
 */
export class WorkerRegistry {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly leaseExpiryOf: (workerId: string) => string | null;
    private readonly gapGraceMs: number;
    private readonly listeners = new Set<WorkerStatusListener>();

    /** Open worker connections by workerId and the time the last one closed. */
    private readonly openConnections = new Map<string, number>();
    private readonly lastCloseMs = new Map<string, number>();

    private readonly txRegister: (
        workerId: string,
        harness: string | undefined,
        model: string | undefined,
    ) => Outcome<string | null>;
    private readonly txTouch: (workerId: string) => Outcome<string | null>;

    private deathTimer: NodeJS.Timeout | null = null;
    /** Signature of the last broadcast status. Heartbeats must not produce a stream of events. */
    private announced: string | null = null;
    private closed = false;

    constructor(options: WorkerRegistryOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
        this.leaseExpiryOf = options.leaseExpiryOf ?? ((): string | null => null);
        this.gapGraceMs = (options.gapGraceSeconds ?? WORKER_GAP_GRACE_SECONDS) * 1000;

        this.txRegister = transaction(
            this.db,
            (workerId: string, harness: string | undefined, model: string | undefined) =>
                this.registerInTransaction(workerId, harness, model),
        );
        this.txTouch = transaction(this.db, (workerId: string) => this.touchInTransaction(workerId));

        this.announced = signatureOf(this.status());
        this.scheduleDeathCheck();
    }

    /**
     * PR worker session registration: `sherpa worker register` when the skill starts.
     * Fresh registration always wins (decision 2026-08-20, superseding spec §3.7): takes a free slot,
     * takes over from another session (even a live one), or renews the same workerId.
     * This never returns `worker_conflict`. The displaced session learns it has lost the slot on
     * its next call (`touch`/`assertOwner`).
     * Returns the displaced session's workerId so the caller can return its leases to the queue.
     */
    register(workerId: string, harness?: string, model?: string): string | null {
        return this.claim(this.txRegister(workerId, harness, model));
    }

    /**
     * Heartbeat: called on every valid worker request (rpc-design §7).
     * A session without `register` (its workerId came from the state file) claims a free slot itself,
     * but does not displace a live owner. That requires `register`.
     * Returns the displaced dead session's workerId, like `register`.
     */
    touch(workerId: string): string | null {
        return this.claim(this.txTouch(workerId));
    }

    /**
     * Checks that we still own the slot without writing. Long-poll `next` can wait for minutes, during
     * which a new session can claim the slot. The old worker must not take its task.
     */
    assertOwner(workerId: string): void {
        const row = this.readRow();
        if (row === null || row.worker_id === workerId || !this.isAlive(row)) {
            return;
        }
        throw conflict(row);
    }

    /**
     * Tracks an open worker connection. While it is open, the session is alive without a heartbeat,
     * closing it signals session death (rpc-design §7, decision 2026-08-20). Returns a function
     * for the HTTP layer to call when the connection closes. Repeated calls are a no-op.
     */
    holdConnection(workerId: string): () => void {
        this.openConnections.set(workerId, (this.openConnections.get(workerId) ?? 0) + 1);
        this.lastCloseMs.delete(workerId);
        this.refresh();

        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.releaseConnection(workerId);
            this.refresh();
        };
    }

    status(): WorkerStatus {
        const row = this.readRow();
        if (row === null) {
            return { kind: 'never' };
        }

        return {
            kind: this.isAlive(row) ? 'connected' : 'disconnected',
            workerId: row.worker_id,
            ...(row.harness === null ? {} : { harness: row.harness }),
            ...(row.model === null ? {} : { model: row.model }),
            registeredAt: row.registered_at,
            lastSeenAt: row.last_seen_at,
        };
    }

    /** Subscribes to worker status changes. Returns an unsubscribe function. */
    subscribe(listener: WorkerStatusListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Rechecks liveness immediately. In production the death timer calls this. Tests with shifted
     * clocks don't wait in real time, so they trigger the transition to `disconnected` here.
     */
    checkNow(): void {
        this.refresh();
    }

    /** Stops the death timer. There is nothing to wake after the server closes. */
    close(): void {
        this.closed = true;
        this.clearDeathCheck();
        this.listeners.clear();
    }

    private registerInTransaction(
        workerId: string,
        harness: string | undefined,
        model: string | undefined,
    ): Outcome<string | null> {
        const row = this.readRow();
        const nowIso = this.nowIso();

        if (row === null) {
            this.db
                .prepare(
                    `INSERT INTO worker (id, worker_id, harness, model, registered_at, last_seen_at)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                )
                .run(SLOT_ID, workerId, harness ?? null, model ?? null, nowIso, nowIso);
            return ok(null);
        }

        if (row.worker_id === workerId) {
            // Repeated register for the same session renews it without registering a new one.
            // `registered_at` holds the session start time, which the UI uses to calculate uptime (SPEC §2.2).
            this.db
                .prepare('UPDATE worker SET harness = ?, model = ?, last_seen_at = ? WHERE id = ?')
                .run(harness ?? row.harness, model ?? row.model, nowIso, SLOT_ID);
            return ok(null);
        }

        // A live previous worker is displaced too. Starting a new session is a deliberate action
        // by the reviewer, and it takes priority (decision 2026-08-20). Otherwise two parallel sessions on one PR
        // compete for the slot, and whoever goes silent first determines the winner.
        this.takeOver(workerId, harness ?? null, model ?? null, nowIso);
        return ok(row.worker_id);
    }

    private touchInTransaction(workerId: string): Outcome<string | null> {
        const row = this.readRow();
        const nowIso = this.nowIso();

        if (row === null) {
            this.db
                .prepare(
                    `INSERT INTO worker (id, worker_id, harness, model, registered_at, last_seen_at)
                     VALUES (?, ?, NULL, NULL, ?, ?)`,
                )
                .run(SLOT_ID, workerId, nowIso, nowIso);
            return ok(null);
        }

        if (row.worker_id === workerId) {
            this.db.prepare('UPDATE worker SET last_seen_at = ? WHERE id = ?').run(nowIso, SLOT_ID);
            return ok(null);
        }

        if (this.isAlive(row)) {
            return fail(conflict(row));
        }

        // The previous session's harness and model have nothing to do with the new one. It declares its own through `register`.
        this.takeOver(workerId, null, null, nowIso);
        return ok(row.worker_id);
    }

    /**
     * Shared slot-claim logic: forget the displaced session's connections. Its pending long-poll and
     * the time it closes have no bearing on the new owner's liveness.
     */
    private claim(outcome: Outcome<string | null>): string | null {
        const displaced = unwrap(outcome);
        if (displaced !== null) {
            this.openConnections.delete(displaced);
            this.lastCloseMs.delete(displaced);
        }
        this.refresh();
        return displaced;
    }

    private takeOver(workerId: string, harness: string | null, model: string | null, nowIso: string): void {
        this.db
            .prepare(
                `UPDATE worker SET worker_id = ?, harness = ?, model = ?, registered_at = ?, last_seen_at = ?
                 WHERE id = ?`,
            )
            .run(workerId, harness, model, nowIso, nowIso, SLOT_ID);
    }

    /** Recalculates status, resets the death timer and broadcasts an event if the status changed. */
    private refresh(): void {
        if (this.closed) {
            return;
        }

        this.scheduleDeathCheck();
        const status = this.status();
        const signature = signatureOf(status);
        if (signature === this.announced) {
            return;
        }

        this.announced = signature;
        for (const listener of [...this.listeners]) {
            listener(status);
        }
    }

    /**
     * Timer for when the worker dies. The delay uses the same clock as liveness, so
     * in tests with fake clocks it never gets a chance to fire. Tests trigger the transition through
     * `checkNow()`. While a worker connection is open, there is nothing to wake: time does not run.
     */
    private scheduleDeathCheck(): void {
        this.clearDeathCheck();

        const row = this.readRow();
        if (row === null) {
            return;
        }

        const deadline = this.deadlineOf(row);
        if (deadline === null || deadline <= this.now().getTime()) {
            return;
        }

        const delay = deadline - this.now().getTime();
        const timer = setTimeout(() => {
            this.deathTimer = null;
            this.checkNow();
        }, Math.max(delay, 0));
        timer.unref();
        this.deathTimer = timer;
    }

    private clearDeathCheck(): void {
        if (this.deathTimer !== null) {
            clearTimeout(this.deathTimer);
            this.deathTimer = null;
        }
    }

    private isAlive(row: WorkerRow): boolean {
        const deadline = this.deadlineOf(row);
        return deadline === null || deadline > this.now().getTime();
    }

    /**
     * Time when the worker is considered dead. `null` means its connection is open and time does not run.
     * The countdown starts from the later of the last call and the last connection closing, because
     * a long-poll can take minutes between those events.
     *
     * The longer silence timeout applies only while the worker is working on a task, and work ends
     * no later than lease expiry. The lease expires relative to claim time, which `progress` does not change,
     * so it can end before `last_seen_at + WORKER_DEAD_AFTER_SECONDS`. After that,
     * the grace period between calls applies, as it does to a worker without a lease.
     */
    private deadlineOf(row: WorkerRow): number | null {
        if ((this.openConnections.get(row.worker_id) ?? 0) > 0) {
            return null;
        }

        const silentSince = Math.max(
            new Date(row.last_seen_at).getTime(),
            this.lastCloseMs.get(row.worker_id) ?? 0,
        );
        const gapDeadline = silentSince + this.gapGraceMs;

        const leaseExpiry = this.leaseExpiryOf(row.worker_id);
        if (leaseExpiry === null) {
            return gapDeadline;
        }

        const workingUntil = Math.min(new Date(leaseExpiry).getTime(), silentSince + DEAD_AFTER_MS);
        return Math.max(workingUntil, gapDeadline);
    }

    /** Connection closure: the grace period starts now, not at the last call. */
    private releaseConnection(workerId: string): void {
        const rest = (this.openConnections.get(workerId) ?? 1) - 1;
        if (rest > 0) {
            this.openConnections.set(workerId, rest);
            return;
        }

        this.openConnections.delete(workerId);
        const nowMs = this.now().getTime();
        // Identities of past sessions no longer affect liveness, so don't let the map grow.
        for (const [id, closedAt] of this.lastCloseMs) {
            if (nowMs - closedAt > DEAD_AFTER_MS) {
                this.lastCloseMs.delete(id);
            }
        }
        this.lastCloseMs.set(workerId, nowMs);
    }

    private readRow(): WorkerRow | null {
        const row = this.db.prepare('SELECT * FROM worker WHERE id = ?').get(SLOT_ID) as WorkerRow | undefined;
        return row ?? null;
    }

    private nowIso(): string {
        return this.now().toISOString();
    }
}

/**
 * Another live session owns the slot: a non-owner called `touch`/`assertOwner`. Registration no longer
 * reaches this path because a new session takes over the slot. There is no reason to suggest waiting N minutes:
 * the recipient must stop its loop (the CLI adds the terminal instruction).
 * Two sessions per PR are not supported (SPEC §4.4).
 */
function conflict(row: WorkerRow): RpcFailure {
    const owner = row.harness === null ? row.worker_id : `${row.worker_id}, harness ${row.harness}`;

    return new RpcFailure(
        'worker_conflict',
        `Another live session (${owner}) is the worker of this PR — two sessions per PR are not ` +
            'supported, and the slot belongs to the session that started last. This one is not it.',
    );
}

/** Status signature for comparison: excludes the last call time, which is the heartbeat itself. */
function signatureOf(status: WorkerStatus): string {
    if (status.kind === 'never') {
        return status.kind;
    }
    return [status.kind, status.workerId, status.harness ?? '', status.model ?? '', status.registeredAt].join('|');
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
