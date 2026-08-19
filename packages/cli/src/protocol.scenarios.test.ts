import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PriorityClass } from '@sherpa/protocol';
import { LEASE_TTL_SECONDS, MAX_TASK_ATTEMPTS } from '@sherpa/protocol';
import type { SherpaServer } from '@sherpa/server';
import { startServer } from '@sherpa/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeWorker } from './fake-worker.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Built once in globalSetup (`src/bundle.global-setup.ts`). Only runs here. */
const bundlePath = path.join(packageRoot, 'dist', 'sherpa.mjs');

const PR_KEY = 'github-quillmart--quillmart--909';
/** Long-poll window: scenarios need a fast `idle`, without waiting the contracted four minutes. */
const LONG_POLL_SECONDS = 0.2;
/** Time shift guaranteed to outlast an interactive task lease (and the worker death timeout too). */
const PAST_LEASE_SECONDS = LEASE_TTL_SECONDS.interactive + 1;

/**
 * C1↔C2 protocol tests (requirements §7): end-to-end session lifecycle scenarios against a real server,
 * with the worker running as the built bundle in separate processes. The server clock is injected,
 * so lease expiry and worker death happen instantly.
 */
describe('worker session scenarios', () => {
    let sherpaDir: string;
    let workDir: string;
    let server: SherpaServer;
    let worker: FakeWorker;
    let nowMs: number;

    beforeEach(async () => {
        sherpaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-scenario-state-'));
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-scenario-work-'));
        nowMs = Date.now();
        server = await startServer({
            prKey: PR_KEY,
            sherpaDir,
            longPollSeconds: LONG_POLL_SECONDS,
            now: () => new Date(nowMs),
        });
        worker = new FakeWorker({ bundlePath, sherpaDir, prKey: PR_KEY, workDir });
    });

    afterEach(async () => {
        await server.close();
        await fs.rm(sherpaDir, { recursive: true, force: true });
        await fs.rm(workDir, { recursive: true, force: true });
    });

    /** Advances the injected clock, the only way anything expires in these tests. */
    function advance(seconds: number): void {
        nowMs += seconds * 1000;
    }

    function enqueue(instructions: string, priority: PriorityClass = 'interactive'): number {
        return server.queue.enqueue({
            type: 'echo',
            priority,
            instructions,
            contextFiles: ['/tmp/sherpa/task-context.md'],
        }).id;
    }

    it('silent death: the lease expires and a new session finishes the task', async () => {
        await worker.register('claude-code');
        const taskId = enqueue('Summarize the diff.');

        const issued = await worker.next();
        expect(issued.taskId).toBe(taskId);
        expect(issued.stdout).toContain('attempt 1');

        // The session disappeared without another call. There is nothing to wait for, so advance the clock.
        advance(PAST_LEASE_SECONDS);

        const reconnect = await worker.register('claude-code');
        expect(reconnect.code).toBe(0);

        const reissued = await worker.next();
        expect(reissued.taskId).toBe(taskId);
        expect(reissued.stdout).toContain('attempt 2');

        const completed = await worker.complete(taskId, 'Answer from the second session.');
        expect(completed.code).toBe(0);
        expect(completed.stdout).toContain('accepted');
        expect(server.queue.getTask(taskId)).toMatchObject({
            status: 'done',
            result: 'Answer from the second session.',
            attempt: 2,
        });
    });

    it('invalid output: rejects an empty result, keeps the task leased to the worker and accepts the second attempt', async () => {
        await worker.register();
        const taskId = enqueue('Return text.');
        await worker.next();

        const rejected = await worker.complete(taskId, '   \n\t');
        // rejected gives the model feedback: exit code zero, a list of errors and the same completion command.
        expect(rejected.code).toBe(0);
        expect(rejected.stdout).toContain('rejected');
        expect(rejected.stdout).toContain('1. ');
        expect(rejected.stdout).toContain(`sherpa task complete ${String(taskId)} --file <path>`);
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'leased', result: null });

        const accepted = await worker.complete(taskId, 'Valid result.');
        expect(accepted.code).toBe(0);
        expect(accepted.stdout).toContain('accepted');
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'done', result: 'Valid result.' });
    });

    it('repeated complete is a no-op and does not overwrite the result', async () => {
        await worker.register();
        const taskId = enqueue('Return text.');
        await worker.next();
        await worker.complete(taskId, 'First result.');

        const repeated = await worker.complete(taskId, 'Second, accidental result.');

        expect(repeated.code).toBe(0);
        expect(repeated.stdout).toContain('already complete');
        expect(repeated.stdout).toContain('sherpa worker next');
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'done', result: 'First result.' });
    });

    it('completion after lease expiry is rejected without losing the work', async () => {
        await worker.register();
        const taskId = enqueue('Long-running task.');
        await worker.next();

        advance(PAST_LEASE_SECONDS);

        const late = await worker.complete(taskId, 'Late result.');
        expect(late.code).toBe(1);
        // Decision log: no grace period, but the text directs the worker back to the loop instead of a dead end.
        expect(late.stderr).toContain('worker next');
        expect(late.stderr).not.toContain('lease_not_held');
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'queued', attempt: 2, workerId: null });

        const reissued = await worker.next();
        expect(reissued.taskId).toBe(taskId);
        expect(reissued.stdout).toContain('attempt 2');

        const accepted = await worker.complete(taskId, 'Late result.');
        expect(accepted.code).toBe(0);
        expect(accepted.stdout).toContain('accepted');
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'done', result: 'Late result.' });
    });

    it('cancellation during a lease: the next call tells the worker and the task stays cancelled', async () => {
        await worker.register();
        const taskId = enqueue('Cancellable task.');
        await worker.next();

        expect(server.queue.cancel(taskId)).toBe('cancelled');

        // The session cannot be interrupted (rpc-design §5): both progress and complete return a no-op with cancellation text.
        const progress = await worker.progress(taskId, 'still working');
        expect(progress.code).toBe(0);
        expect(progress.stdout).toContain('has been cancelled');
        expect(progress.stdout).toContain('sherpa worker next');

        const completed = await worker.complete(taskId, 'Result for the cancelled task.');
        expect(completed.code).toBe(0);
        expect(completed.stdout).toContain('has been cancelled');
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'cancelled', result: null });

        const empty = await worker.next();
        expect(empty.taskId).toBe(null);
        expect(empty.stdout).toContain('No tasks yet');
    });

    it('reconnection: the new session gets the task, the old one is told to stop the loop', async () => {
        await worker.register('claude-code');
        const taskId = enqueue('Task for the first session.');
        await worker.next();
        const deadWorkerId = await worker.workerId();

        // Session A has been silent past the death threshold, but its task lease is still alive.
        advance(400);
        const reconnected = await worker.register('claude-code');
        expect(reconnected.code).toBe(0);
        expect(await worker.workerId()).not.toBe(deadWorkerId);

        const tooEarly = await worker.next();
        expect(tooEarly.taskId).toBe(null);

        advance(PAST_LEASE_SECONDS);
        const reissued = await worker.next();
        expect(reissued.taskId).toBe(taskId);
        await worker.complete(taskId, 'Answer from the second session.');
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'done' });

        // Session A returns and asks for a task. It no longer owns the slot, so it cannot continue the loop.
        const ghost = await worker.as(deadWorkerId).next();
        expect(ghost.code).toBe(1);
        expect(ghost.stderr).toContain('stop the loop');
        expect(ghost.stderr).not.toContain('worker_conflict');
    });

    it('attempts exhausted: after three claims and expirations, the task fails', async () => {
        await worker.register();
        const taskId = enqueue('Task nobody finished.');

        for (let attempt = 1; attempt <= MAX_TASK_ATTEMPTS; attempt += 1) {
            const issued = await worker.next();
            expect(issued.taskId).toBe(taskId);
            expect(issued.stdout).toContain(`attempt ${String(attempt)}`);
            advance(PAST_LEASE_SECONDS);
        }

        const empty = await worker.next();
        expect(empty.taskId).toBe(null);
        expect(server.queue.getTask(taskId)).toMatchObject({ status: 'failed', workerId: null });
        expect(server.queue.getTask(taskId)?.failReason).toContain('attempts exhausted');
    });

    it('priority under load: an interactive task overtakes an earlier background task', async () => {
        await worker.register();
        const background = enqueue('Background task.', 'background');
        const interactive = enqueue('Interactive task.', 'interactive');

        const first = await worker.next();
        expect(first.taskId).toBe(interactive);
        expect(first.stdout).toContain('Interactive task.');

        await worker.complete(interactive, 'Answer for the interactive task.');
        const second = await worker.next();
        expect(second.taskId).toBe(background);
    });
});
