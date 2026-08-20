import type { WorkerStatus } from '@sherpa/protocol';
import { WORKER_DEAD_AFTER_SECONDS } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';
import { RpcFailure } from './errors.js';

export interface WorkerRegistryOptions {
    readonly db: SherpaDatabase;
    /** Injectable clock: tests exercise worker death without actually waiting. */
    readonly now?: () => Date;
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
 * PR worker lifecycle (rpc-design §7): session registration, heartbeat on every CLI call,
 * transition to "Agent disconnected" after silence longer than `WORKER_DEAD_AFTER_SECONDS`.
 * Liveness is evaluated lazily on reads, like lease expiry in the queue. The timer is only needed
 * to emit the "Agent disconnected" event without incoming requests. Nothing else would emit it.
 */
export class WorkerRegistry {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly listeners = new Set<WorkerStatusListener>();

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
     * Claims a free slot or one with a dead worker. The same workerId renews it idempotently.
     * A different session while the previous worker is alive gets `worker_conflict` (spec §3.7, SPEC §4.4).
     * Returns the displaced dead session's workerId so the caller can return its leases to the queue.
     */
    register(workerId: string, harness?: string, model?: string): string | null {
        const displaced = unwrap(this.txRegister(workerId, harness, model));
        this.refresh();
        return displaced;
    }

    /**
     * Heartbeat: called on every valid worker request (rpc-design §7).
     * A session without `register` (workerId read from the state file) claims a free slot itself.
     * Returns the displaced dead session's workerId, like `register`.
     */
    touch(workerId: string): string | null {
        const displaced = unwrap(this.txTouch(workerId));
        this.refresh();
        return displaced;
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
        throw conflict(row, this.now());
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

        if (this.isAlive(row)) {
            return fail(conflict(row, this.now()));
        }

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
            return fail(conflict(row, this.now()));
        }

        // The previous session's harness and model have nothing to do with the new one. It declares its own through `register`.
        this.takeOver(workerId, null, null, nowIso);
        return ok(row.worker_id);
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
     * Timer for `lastSeenAt + WORKER_DEAD_AFTER_SECONDS`. Its delay uses the same clock
     * as liveness, so it never gets a chance to fire in tests with a fake clock.
     * Tests trigger the transition through `checkNow()`.
     */
    private scheduleDeathCheck(): void {
        this.clearDeathCheck();

        const row = this.readRow();
        if (row === null || !this.isAlive(row)) {
            return;
        }

        const delay = deadlineOf(row) - this.now().getTime();
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
        return deadlineOf(row) > this.now().getTime();
    }

    private readRow(): WorkerRow | null {
        const row = this.db.prepare('SELECT * FROM worker WHERE id = ?').get(SLOT_ID) as WorkerRow | undefined;
        return row ?? null;
    }

    private nowIso(): string {
        return this.now().toISOString();
    }
}

function deadlineOf(row: WorkerRow): number {
    return new Date(row.last_seen_at).getTime() + DEAD_AFTER_MS;
}

/**
 * Two sessions per PR are not supported (SPEC §4.4). The model reads this text in CLI output,
 * so it offers both ways out: wait or stop the previous session.
 */
function conflict(row: WorkerRow, now: Date): RpcFailure {
    const minutes = String(Math.ceil((deadlineOf(row) - now.getTime()) / 60_000));
    const owner = row.harness === null ? row.worker_id : `${row.worker_id}, harness ${row.harness}`;

    return new RpcFailure(
        'worker_conflict',
        `Another live session (${owner}) is already the worker of this PR — ` +
            `two sessions per PR are not supported. If this is a reconnect, wait ${minutes} min until the ` +
            'previous session is considered disconnected, or stop it — and run the Sherpa skill again.',
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
