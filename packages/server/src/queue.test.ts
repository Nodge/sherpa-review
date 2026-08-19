import { LEASE_TTL_SECONDS, MAX_TASK_ATTEMPTS, RESULT_MAX_BYTES } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { RpcFailure } from './errors.js';
import type { EnqueueInput, LeasedTask, TaskRecord } from './queue.js';
import { TaskQueue } from './queue.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

const START = new Date('2026-08-19T12:00:00.000Z');

describe('queue with leases', () => {
    let sherpaDir: string;
    let dbFile: string;
    let db: SherpaDatabase;
    let now: Date;
    let queue: TaskQueue;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        dbFile = `${sherpaDir}/queue.db`;
        db = openDatabase(dbFile);
        now = START;
        queue = new TaskQueue({ db, now: () => now });
    });

    afterEach(async () => {
        db.close();
        await removeTempSherpaDir(sherpaDir);
    });

    function advanceSeconds(seconds: number): void {
        now = new Date(now.getTime() + seconds * 1000);
    }

    function enqueue(overrides: Partial<EnqueueInput> = {}): TaskRecord {
        return queue.enqueue({
            type: 'echo',
            priority: 'background',
            instructions: 'Return the file contents as is.',
            contextFiles: [],
            ...overrides,
        });
    }

    function takeNext(workerId: string): LeasedTask {
        const leased = queue.next(workerId);
        if (leased === null) {
            throw new Error(`worker ${workerId} expected a task, but the queue was empty`);
        }
        return leased;
    }

    function failureOf(run: () => unknown): RpcFailure {
        try {
            run();
        } catch (error) {
            if (error instanceof RpcFailure) {
                return error;
            }
            throw error;
        }
        throw new Error('expected RpcFailure, but the call succeeded');
    }

    describe('dispatch order', () => {
        it('puts interactive tasks before background tasks, FIFO by id within each class', () => {
            const firstBackground = enqueue({ instructions: 'background 1' });
            const secondBackground = enqueue({ instructions: 'background 2' });
            const interactive = enqueue({ priority: 'interactive', instructions: 'interactive' });

            expect(takeNext('w-1').task.id).toBe(interactive.id);
            expect(takeNext('w-2').task.id).toBe(firstBackground.id);
            expect(takeNext('w-3').task.id).toBe(secondBackground.id);
            expect(queue.next('w-4')).toBeNull();
        });

        it('returns null for an empty queue and never dispatches cancelled tasks', () => {
            const task = enqueue();
            queue.cancel(task.id);

            expect(queue.next('w-1')).toBeNull();
        });

        it('issues a lease with the TTL of its priority class', () => {
            enqueue({ priority: 'interactive' });

            const leased = takeNext('w-1');

            expect(leased.lease.ttlSeconds).toBe(LEASE_TTL_SECONDS.interactive);
            expect(leased.lease.expiresAt).toBe(
                new Date(START.getTime() + LEASE_TTL_SECONDS.interactive * 1000).toISOString(),
            );
            expect(leased.task.attempt).toBe(1);
        });

        it('returns the same task on repeated next calls by the same worker with a live lease', () => {
            enqueue();
            enqueue();
            const first = takeNext('w-1');

            advanceSeconds(10);
            const again = takeNext('w-1');

            expect(again.task.id).toBe(first.task.id);
            expect(again.lease.expiresAt).toBe(first.lease.expiresAt);
        });
    });

    describe('lease expiry', () => {
        it('an expired lease requeues the task and increments the attempt', () => {
            const task = enqueue();
            takeNext('w-1');

            advanceSeconds(LEASE_TTL_SECONDS.background + 1);
            const retaken = takeNext('w-2');

            expect(retaken.task.id).toBe(task.id);
            expect(retaken.task.attempt).toBe(2);
            expect(queue.getTask(task.id)?.workerId).toBe('w-2');
        });

        it('exhausted attempts fail the task instead of issuing it again', () => {
            const task = enqueue();

            for (let attempt = 1; attempt <= MAX_TASK_ATTEMPTS; attempt += 1) {
                expect(takeNext(`w-${String(attempt)}`).task.attempt).toBe(attempt);
                advanceSeconds(LEASE_TTL_SECONDS.background + 1);
            }

            expect(queue.next('w-last')).toBeNull();
            const record = queue.getTask(task.id);
            expect(record?.status).toBe('failed');
            expect(record?.failReason).toContain(String(MAX_TASK_ATTEMPTS));
        });

        it('reading the queue also expires leases even if nothing else touches it', () => {
            const task = enqueue();
            takeNext('w-1');

            advanceSeconds(LEASE_TTL_SECONDS.background + 1);

            expect(queue.getTask(task.id)).toMatchObject({ status: 'queued', attempt: 2, workerId: null });
            expect(queue.listTasks()[0]).toMatchObject({ status: 'queued', attempt: 2 });
        });

        it('a worker with an expired lease cannot submit a result', () => {
            const task = enqueue();
            takeNext('w-1');

            advanceSeconds(LEASE_TTL_SECONDS.background + 1);

            expect(failureOf(() => queue.complete('w-1', task.id, 'too late')).code).toBe('lease_not_held');
            expect(queue.getTask(task.id)?.status).toBe('queued');
        });
    });

    describe('releasing leases of a displaced worker', () => {
        it('the lease is requeued immediately without waiting for TTL and the attempt increments', () => {
            const task = enqueue();
            takeNext('w-dead');

            queue.releaseLeasesOf('w-dead');

            expect(queue.getTask(task.id)).toMatchObject({ status: 'queued', attempt: 2, workerId: null });
            expect(takeNext('w-new').task.id).toBe(task.id);
        });

        it('leaves leases of other workers and closed tasks unchanged', () => {
            const held = enqueue();
            takeNext('w-live');
            const done = enqueue();
            takeNext('w-dead');
            queue.complete('w-dead', done.id, 'done');

            queue.releaseLeasesOf('w-dead');

            expect(queue.getTask(held.id)).toMatchObject({ status: 'leased', workerId: 'w-live' });
            expect(queue.getTask(done.id)).toMatchObject({ status: 'done', result: 'done' });
        });

        it('releasing after exhausted attempts fails the task just like expiry', () => {
            const task = enqueue();
            for (let attempt = 1; attempt < MAX_TASK_ATTEMPTS; attempt += 1) {
                takeNext(`w-${String(attempt)}`);
                advanceSeconds(LEASE_TTL_SECONDS.background + 1);
            }
            takeNext('w-last');

            queue.releaseLeasesOf('w-last');

            expect(queue.getTask(task.id)?.status).toBe('failed');
            expect(queue.getTask(task.id)?.failReason).toContain('attempts exhausted');
        });
    });

    describe('result submission', () => {
        it('accepts the result and returns noop for a repeated complete', () => {
            const task = enqueue();
            takeNext('w-1');

            expect(queue.complete('w-1', task.id, 'done')).toEqual({
                kind: 'accepted',
                message: expect.stringContaining(`sherpa/${String(task.id)}`) as unknown,
            });
            expect(queue.getTask(task.id)).toMatchObject({ status: 'done', result: 'done', workerId: null });

            const repeated = queue.complete('w-1', task.id, 'done');
            expect(repeated.kind).toBe('noop');
            expect(queue.fail('w-1', task.id, 'changed my mind').kind).toBe('noop');
        });

        it('rejects an empty result with a prompt error and keeps the lease', () => {
            const task = enqueue();
            takeNext('w-1');

            const response = queue.complete('w-1', task.id, '   ');

            expect(response.kind).toBe('rejected');
            expect(queue.getTask(task.id)?.status).toBe('leased');
        });

        it('another worker gets lease_not_held', () => {
            const task = enqueue();
            takeNext('w-1');

            expect(failureOf(() => queue.complete('w-2', task.id, 'mine')).code).toBe('lease_not_held');
            expect(queue.getTask(task.id)?.status).toBe('leased');
        });

        it('a nonexistent task returns unknown_task', () => {
            expect(failureOf(() => queue.complete('w-1', 404, 'no such task')).code).toBe('unknown_task');
        });

        it('a result over the limit fails the task', () => {
            const task = enqueue();
            takeNext('w-1');

            // 'é' uses 2 bytes in UTF-8. The limit counts bytes, not characters.
            const oversized = 'é'.repeat(RESULT_MAX_BYTES / 2 + 1);
            expect(failureOf(() => queue.complete('w-1', task.id, oversized)).code).toBe('result_too_large');

            const record = queue.getTask(task.id);
            expect(record?.status).toBe('failed');
            expect(record?.result).toBeNull();
            expect(record?.failReason).toContain(String(RESULT_MAX_BYTES));
        });

        it('an explicit failure closes the task with a reason', () => {
            const task = enqueue();
            takeNext('w-1');

            expect(queue.fail('w-1', task.id, 'no access to file')).toEqual({ kind: 'accepted' });
            expect(queue.getTask(task.id)).toMatchObject({ status: 'failed', failReason: 'no access to file' });
        });
    });

    describe('status updates', () => {
        it('progress writes the latest update from the lease holder', () => {
            const task = enqueue();
            takeNext('w-1');

            expect(queue.progress('w-1', task.id, 'reading the diff')).toEqual({ kind: 'accepted' });
            expect(queue.progress('w-1', task.id, 'writing the answer')).toEqual({ kind: 'accepted' });
            expect(queue.getTask(task.id)?.progressText).toBe('writing the answer');
        });

        it('progress returns noop for a closed task and lease_not_held for another worker', () => {
            const task = enqueue();
            takeNext('w-1');
            queue.complete('w-1', task.id, 'done');

            expect(queue.progress('w-1', task.id, 'still working').kind).toBe('noop');

            const another = enqueue();
            takeNext('w-1');
            expect(failureOf(() => queue.progress('w-2', another.id, 'not mine')).code).toBe('lease_not_held');
        });
    });

    describe('cancellation', () => {
        it('a queued task is cancelled immediately and never issued again', () => {
            const task = enqueue();

            expect(queue.cancel(task.id)).toBe('cancelled');
            expect(queue.getTask(task.id)?.status).toBe('cancelled');
            expect(queue.next('w-1')).toBeNull();
        });

        it('a leased task is marked cancelled and the worker learns on its next call', () => {
            const task = enqueue();
            takeNext('w-1');

            expect(queue.cancel(task.id)).toBe('cancelled');

            const response = queue.complete('w-1', task.id, 'did it anyway');
            expect(response).toEqual({ kind: 'noop', message: expect.stringContaining('cancelled') as unknown });
            expect(queue.getTask(task.id)).toMatchObject({ status: 'cancelled', result: null });
        });

        it('repeated cancellation and closed tasks return noop, unknown tasks return unknown_task', () => {
            const task = enqueue();
            queue.cancel(task.id);

            expect(queue.cancel(task.id)).toBe('noop');
            expect(failureOf(() => queue.cancel(404)).code).toBe('unknown_task');
        });
    });

    describe('persistence', () => {
        it('the queue and leases survive reopening storage', () => {
            const done = enqueue({ instructions: 'first' });
            const leased = enqueue({ instructions: 'second' });
            const queued = enqueue({ instructions: 'third' });
            takeNext('w-1');
            queue.complete('w-1', done.id, 'done');
            takeNext('w-1');

            db.close();
            db = openDatabase(dbFile);
            queue = new TaskQueue({ db, now: () => now });

            expect(queue.listTasks().map((task) => [task.id, task.status])).toEqual([
                [done.id, 'done'],
                [leased.id, 'leased'],
                [queued.id, 'queued'],
            ]);
            // The lease survived restart. The same worker gets the same task, others wait for the next one.
            expect(takeNext('w-1').task.id).toBe(leased.id);
            expect(takeNext('w-2').task.id).toBe(queued.id);
        });
    });

    describe('subscription', () => {
        it('enqueuing wakes subscribers and unsubscribing silences them', () => {
            let calls = 0;
            const unsubscribe = queue.subscribe(() => {
                calls += 1;
            });

            enqueue();
            expect(calls).toBe(1);

            unsubscribe();
            enqueue();
            expect(calls).toBe(1);
        });
    });
});
