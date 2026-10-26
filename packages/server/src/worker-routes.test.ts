import fs from 'node:fs/promises';

import type { WorkerRegisterResponse, WorkerStatus } from '@sherpa/protocol';
import {
    PROTOCOL_VERSION,
    RESULT_MAX_BYTES,
    VERDICTS_INSTRUCTION_MAX_CHARS,
    rpcErrorSchema,
    taskAckResponseSchema,
    taskCompleteResponseSchema,
    UI_ENDPOINTS,
    WORKER_DEAD_AFTER_SECONDS,
    WORKER_ENDPOINTS,
    workerNextResponseSchema,
    workerRegisterResponseSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { selectReviewHost } from './hosts/select.js';
import { REQUEST_BODY_MAX_BYTES } from './http.js';
import { workerIdPathFor } from './paths.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { makeTempSherpaDir, postJson, postRaw, removeTempSherpaDir } from './test-support.js';

const PR_KEY = 'github-quillmart--quillmart--777';
const WORKER = 'w-1';
const BASE = { protocolVersion: PROTOCOL_VERSION, cliVersion: '0.1.0', workerId: WORKER };

describe('worker endpoints', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];
    /** Shifts the server clock. Worker death takes 6 minutes, which the test need not wait through. */
    let clockOffsetMs: number;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
        clockOffsetMs = 0;
    });

    afterEach(async () => {
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    /** The test sets the long-poll window. There is no need to wait the contract's 4 minutes in tests. */
    async function start(longPollSeconds = 0.3): Promise<SherpaServer> {
        const server = await startServer({
            prKey: PR_KEY,
            sherpaDir,
            longPollSeconds,
            now: () => new Date(Date.now() + clockOffsetMs),
            // Tests must not call a live review host (docs/testing.md). Without a host, route warm-up makes no network requests.
            reviewHostFactory: () => null,
        });
        servers.push(server);
        return server;
    }

    async function startWithShortUiGrace(longPollSeconds = 30): Promise<SherpaServer> {
        const server = await startServer({
            prKey: PR_KEY,
            sherpaDir,
            longPollSeconds,
            uiGoneGraceSeconds: 0.1,
            now: () => new Date(Date.now() + clockOffsetMs),
            reviewHostFactory: () => null,
        });
        servers.push(server);
        return server;
    }

    function advanceServerClock(seconds: number): void {
        clockOffsetMs += seconds * 1000;
    }

    function enqueueEcho(server: SherpaServer, instructions = 'Return the file contents as is.'): number {
        return server.queue.enqueue({
            type: 'echo',
            priority: 'interactive',
            instructions,
            contextFiles: ['/tmp/sherpa/task-context.md'],
        }).id;
    }

    async function openUi(server: SherpaServer): Promise<() => Promise<void>> {
        const controller = new AbortController();
        const response = await fetch(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
            { signal: controller.signal },
        );
        expect(response.status).toBe(200);
        if (response.body === null) {
            throw new Error('UI SSE channel opened without a body');
        }

        const reader = response.body.getReader();
        await reader.read();
        return async () => {
            controller.abort();
            await reader.cancel().catch(() => undefined);
        };
    }

    describe('request boundary', () => {
        it('returns 401 without a token and does not execute the endpoint', async () => {
            const server = await start();

            const response = await postJson(server.port, WORKER_ENDPOINTS.next, BASE);

            expect(response.status).toBe(401);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('unauthorized');
        });

        it('returns version_incompatible with a readable message for an incompatible protocol version', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.next,
                { ...BASE, protocolVersion: '9.9.9' },
                server.token,
            );

            expect(response.status).toBe(409);
            const body = rpcErrorSchema.parse(await response.json());
            expect(body.error.code).toBe('version_incompatible');
            expect(body.error.message).toContain('Update the skill');
        });

        it('returns bad_request with details for malformed bodies and schema violations', async () => {
            const server = await start();

            const broken = await postRaw(server.port, WORKER_ENDPOINTS.next, '{not json', server.token);
            expect(broken.status).toBe(400);
            expect(rpcErrorSchema.parse(await broken.json()).error.code).toBe('bad_request');

            const invalid = await postJson(server.port, WORKER_ENDPOINTS.next, { workerId: '' }, server.token);
            expect(invalid.status).toBe(400);
            const body = rpcErrorSchema.parse(await invalid.json());
            expect(body.error.code).toBe('bad_request');
            expect(body.error.details?.length).toBeGreaterThan(0);
        });

        it('returns bad_request for an oversized body without dropping the connection', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...BASE, taskId: 1, result: 'x'.repeat(REQUEST_BODY_MAX_BYTES + 1024) },
                server.token,
            );

            expect(response.status).toBe(400);
            const body = rpcErrorSchema.parse(await response.json());
            expect(body.error.code).toBe('bad_request');
            expect(body.error.message).toContain(String(REQUEST_BODY_MAX_BYTES));
        });
    });

    describe('register', () => {
        it('acknowledges session registration and reports worker status with harness and model', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.register,
                { ...BASE, harness: 'claude-code', model: 'claude-opus-5' },
                server.token,
            );

            expect(response.status).toBe(200);
            const body = workerRegisterResponseSchema.parse(await response.json());
            expect(body.kind).toBe('registered');
            expect(body.message).toContain('Run `worker next`');
            expect(body.message).not.toContain('sherpa worker');
            expect(server.workerRegistry.status()).toMatchObject({
                kind: 'connected',
                workerId: WORKER,
                harness: 'claude-code',
                model: 'claude-opus-5',
            });
        });

        it('includes the session language label in worker status and omits the field without it', async () => {
            const server = await start();

            await postJson(server.port, WORKER_ENDPOINTS.register, { ...BASE, lang: 'ru' }, server.token);
            expect(server.workerRegistry.status()).toMatchObject({ lang: 'ru' });

            await postJson(
                server.port,
                WORKER_ENDPOINTS.register,
                { ...BASE, workerId: 'w-no-lang' },
                server.token,
            );
            expect(server.workerRegistry.status()).not.toHaveProperty('lang');
        });

        it('lets a second session take over the slot from a live first session', async () => {
            const server = await start();
            await postJson(server.port, WORKER_ENDPOINTS.register, { ...BASE, harness: 'claude-code' }, server.token);

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.register,
                { ...BASE, workerId: 'w-2', harness: 'codex' },
                server.token,
            );

            expect(response.status).toBe(200);
            expect(workerRegisterResponseSchema.parse(await response.json()).kind).toBe('registered');
            expect(server.workerRegistry.status()).toMatchObject({
                kind: 'connected',
                workerId: 'w-2',
                harness: 'codex',
            });

            // The displaced session learns about this only on its next call.
            const displaced = await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            expect(displaced.status).toBe(409);
            const body = rpcErrorSchema.parse(await displaced.json());
            expect(body.error.code).toBe('worker_conflict');
            expect(body.error.message).toContain('Another live session');
            expect(body.error.message).toContain('codex');
        });

        it('checks the version handshake here too', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.register,
                { ...BASE, protocolVersion: '9.9.9' },
                server.token,
            );

            expect(response.status).toBe(409);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('version_incompatible');
            expect(server.workerRegistry.status().kind).toBe('never');
        });

        // The running server cannot see launch arguments. Local review verdict mode arrives through `up` registration.
        it('passes the localVerdicts instruction to the host and leaves the mode unchanged without the field', async () => {
            const calls: (string | null)[] = [];
            const fixture = selectReviewHost('fixture-small');
            if (fixture === null) {
                throw new Error('fixture host was not selected');
            }
            const server = await startServer({
                prKey: PR_KEY,
                sherpaDir,
                longPollSeconds: 0.3,
                reviewHostFactory: () => ({
                    ...fixture,
                    setLocalVerdicts: (instruction) => {
                        calls.push(instruction);
                        return true;
                    },
                }),
            });
            servers.push(server);

            const register = async (body: object): Promise<WorkerRegisterResponse> =>
                workerRegisterResponseSchema.parse(
                    await (await postJson(server.port, WORKER_ENDPOINTS.register, body, server.token)).json(),
                );

            // The echo names the applied instruction so the CLI can tell the server understood the field.
            expect((await register({ ...BASE, localVerdicts: 'on ship, open a PR' })).localVerdicts).toBe(
                'on ship, open a PR',
            );
            expect((await register(BASE)).localVerdicts).toBeUndefined();
            expect((await register({ ...BASE, localVerdicts: 'on ship, merge' })).localVerdicts).toBe('on ship, merge');
            expect((await register({ ...BASE, localVerdicts: null })).localVerdicts).toBeNull();

            expect(calls).toEqual(['on ship, open a PR', 'on ship, merge', null]);
        });

        it('rejects empty and overly long instructions through the schema', async () => {
            const server = await start();

            for (const localVerdicts of ['  ', 'x'.repeat(VERDICTS_INSTRUCTION_MAX_CHARS + 1)]) {
                const response = await postJson(
                    server.port,
                    WORKER_ENDPOINTS.register,
                    { ...BASE, localVerdicts },
                    server.token,
                );
                expect(response.status).toBe(400);
            }
            expect(server.workerRegistry.status().kind).toBe('never');
        });

        it('ignores localVerdicts on a host without verdict mode and does not echo it', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.register,
                { ...BASE, localVerdicts: 'on ship, open a PR' },
                server.token,
            );

            expect(response.status).toBe(200);
            expect(workerRegisterResponseSchema.parse(await response.json()).localVerdicts).toBeUndefined();
        });

        it('allows registration after the previous session dies', async () => {
            const server = await start();
            await postJson(server.port, WORKER_ENDPOINTS.register, BASE, server.token);
            advanceServerClock(WORKER_DEAD_AFTER_SECONDS + 1);

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.register,
                { ...BASE, workerId: 'w-2' },
                server.token,
            );

            expect(response.status).toBe(200);
            expect(server.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId: 'w-2' });
        });
    });

    describe('heartbeat', () => {
        it('registers a session as the worker on next, even without register', async () => {
            const server = await start();

            await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);

            expect(server.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId: WORKER });
        });

        it('rejects another session before accessing the queue', async () => {
            const server = await start();
            const taskId = enqueueEcho(server);
            await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...BASE, workerId: 'w-2', taskId, result: 'result from another session' },
                server.token,
            );

            expect(response.status).toBe(409);
            // Specifically worker_conflict, not lease_not_held: the request never reached the queue.
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('worker_conflict');
            expect(server.queue.getTask(taskId)).toMatchObject({ status: 'leased', workerId: WORKER });
        });

        it('keeps the session alive during a pending long-poll and retains its slot without another registration', async () => {
            const server = await start(30);
            const pending = postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            await new Promise((resolve) => setTimeout(resolve, 50));

            // The clock is far past the death timeout, but the session has a pending call. The connection keeps it alive.
            advanceServerClock(WORKER_DEAD_AFTER_SECONDS + 1);
            expect(server.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId: WORKER });

            // Another session's heartbeat cannot take the slot. Only registration of a new session can.
            const foreign = await postJson(
                server.port,
                WORKER_ENDPOINTS.next,
                { ...BASE, workerId: 'w-2' },
                server.token,
            );
            expect(foreign.status).toBe(409);
            expect(rpcErrorSchema.parse(await foreign.json()).error.code).toBe('worker_conflict');

            const taskId = enqueueEcho(server, 'slot owner task');
            const response = await pending;
            expect(response.status).toBe(200);
            const body = workerNextResponseSchema.parse(await response.json());
            expect(body.kind === 'task' && body.task.id).toBe(taskId);
        });
    });

    describe('slot takeover', () => {
        it('wakes the pending long-poll of a displaced session immediately when a new session registers', async () => {
            const server = await start(30);
            const pending = postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            await new Promise((resolve) => setTimeout(resolve, 50));

            const started = Date.now();
            const registered = await postJson(
                server.port,
                WORKER_ENDPOINTS.register,
                { ...BASE, workerId: 'w-2', harness: 'codex' },
                server.token,
            );
            expect(registered.status).toBe(200);

            const response = await pending;
            // Faster than the queue's fallback polling tick and much faster than the long-poll window:
            // the displaced session receives "stop the loop" in the same second.
            expect(Date.now() - started).toBeLessThan(500);
            expect(response.status).toBe(409);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('worker_conflict');
            expect(server.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId: 'w-2' });
        });

        it('returns the lease of a displaced session to the queue for the new session to claim', async () => {
            const server = await start();
            const taskId = enqueueEcho(server);
            const issued = await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            expect(workerNextResponseSchema.parse(await issued.json()).kind).toBe('task');

            await postJson(server.port, WORKER_ENDPOINTS.register, { ...BASE, workerId: 'w-2' }, server.token);

            // No need to wait for lease TTL. Takeover returned the task to the queue immediately.
            expect(server.queue.getTask(taskId)).toMatchObject({ status: 'queued', workerId: null });
            const reissued = workerNextResponseSchema.parse(
                await (
                    await postJson(server.port, WORKER_ENDPOINTS.next, { ...BASE, workerId: 'w-2' }, server.token)
                ).json(),
            );
            expect(reissued).toMatchObject({ kind: 'task', task: { id: taskId, attempt: 2 } });

            // A late result from the previous session is not saved. Its call never reaches the queue.
            const late = await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...BASE, taskId, result: 'displaced session result' },
                server.token,
            );
            expect(late.status).toBe(409);
            expect(rpcErrorSchema.parse(await late.json()).error.code).toBe('worker_conflict');
            expect(server.queue.getTask(taskId)).toMatchObject({ status: 'leased', workerId: 'w-2' });
        });
    });

    describe('worker identity file', () => {
        async function readWorkerIdFile(): Promise<string> {
            return (await fs.readFile(workerIdPathFor(sherpaDir, PR_KEY), 'utf8')).trim();
        }

        it('writes the slot owner to the owner-only PR state file on register', async () => {
            const server = await start();

            await postJson(server.port, WORKER_ENDPOINTS.register, BASE, server.token);
            expect(await readWorkerIdFile()).toBe(WORKER);

            // Takeover rewrites the file. The session's next calls read its identity from there.
            await postJson(server.port, WORKER_ENDPOINTS.register, { ...BASE, workerId: 'w-2' }, server.token);
            expect(await readWorkerIdFile()).toBe('w-2');

            const stats = await fs.stat(workerIdPathFor(sherpaDir, PR_KEY));
            expect(stats.mode & 0o777).toBe(0o600);
        });

        it('keeps the slot owner in the file regardless of concurrent registration races', async () => {
            const server = await start();

            // Both registrations succeed (register no longer returns a conflict), and one claims the slot.
            // The file must describe that session, regardless of the order of network responses.
            const responses = await Promise.all([
                postJson(server.port, WORKER_ENDPOINTS.register, { ...BASE, workerId: 'w-a' }, server.token),
                postJson(server.port, WORKER_ENDPOINTS.register, { ...BASE, workerId: 'w-b' }, server.token),
            ]);

            expect(responses.map((response) => response.status)).toEqual([200, 200]);
            const status = server.workerRegistry.status();
            expect(await readWorkerIdFile()).toBe(status.kind === 'never' ? null : status.workerId);
        });

        it('returns internal with an instruction to stop the loop when the file is unwritable: slot claimed, identity not saved', async () => {
            const server = await start();
            // A directory at the file path: writing fails just as it would with permissions revoked.
            await fs.mkdir(workerIdPathFor(sherpaDir, PR_KEY), { recursive: true });

            const response = await postJson(server.port, WORKER_ENDPOINTS.register, BASE, server.token);

            expect(response.status).toBe(500);
            const body = rpcErrorSchema.parse(await response.json());
            expect(body.error.code).toBe('internal');
            expect(body.error.message).toContain('identity file');
        });
    });

    describe('death on disconnection', () => {
        /** Grace period between calls. The test need not wait a minute. */
        const GAP_GRACE_SECONDS = 0.3;

        async function startWithShortGrace(longPollSeconds: number): Promise<SherpaServer> {
            const server = await startServer({
                prKey: PR_KEY,
                sherpaDir,
                longPollSeconds,
                workerGapGraceSeconds: GAP_GRACE_SECONDS,
                now: () => new Date(Date.now() + clockOffsetMs),
                reviewHostFactory: () => null,
            });
            servers.push(server);
            return server;
        }

        /** Waits for the "Agent disconnected" event emitted by the server timer, without polling. */
        function disconnection(server: SherpaServer, timeoutMs: number): Promise<WorkerStatus> {
            return new Promise<WorkerStatus>((resolve, reject) => {
                const timer = setTimeout(() => {
                    unsubscribe();
                    reject(new Error(`no disconnection event within ${String(timeoutMs)} ms`));
                }, timeoutMs);
                const unsubscribe = server.workerRegistry.subscribe((status) => {
                    if (status.kind !== 'disconnected') {
                        return;
                    }
                    clearTimeout(timer);
                    unsubscribe();
                    resolve(status);
                });
            });
        }

        it('considers an idle session dead within the grace period after its long-poll disconnects', async () => {
            const server = await startWithShortGrace(30);
            const aborter = new AbortController();
            const pending = postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token, aborter.signal).catch(
                () => null,
            );
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(server.workerRegistry.status().kind).toBe('connected');

            // The session was killed. The OS closed the socket, and no more requests will arrive.
            const dead = disconnection(server, 2000);
            aborter.abort();
            await pending;

            expect(await dead).toMatchObject({ kind: 'disconnected', workerId: WORKER });
        });

        it('keeps a session with a claimed task alive after disconnection', async () => {
            const server = await startWithShortGrace(0.3);
            const taskId = enqueueEcho(server);
            const issued = await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            expect(workerNextResponseSchema.parse(await issued.json()).kind).toBe('task');

            // Silence with a lease is valid. The model reads files for minutes, so the gap grace period does not apply.
            advanceServerClock(WORKER_DEAD_AFTER_SECONDS - 1);
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(server.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId: WORKER });
            expect(server.queue.getTask(taskId)).toMatchObject({ status: 'leased', workerId: WORKER });

            advanceServerClock(2);
            expect(server.workerRegistry.status().kind).toBe('disconnected');
        });
    });

    describe('next', () => {
        it('returns idle for an empty queue when the long-poll window expires', async () => {
            const server = await start(0.3);

            const started = Date.now();
            const response = await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            const elapsed = Date.now() - started;

            expect(response.status).toBe(200);
            const body = workerNextResponseSchema.parse(await response.json());
            expect(body.kind).toBe('idle');
            expect(elapsed).toBeGreaterThanOrEqual(250);
        });

        it('preserves the previous idle response while the UI is alive', async () => {
            const server = await startWithShortUiGrace(0.3);
            const closeUi = await openUi(server);

            const response = await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);

            expect(workerNextResponseSchema.parse(await response.json()).kind).toBe('idle');
            await closeUi();
        });

        it('wakes a pending long-poll and returns done immediately when the UI leaves', async () => {
            const server = await startWithShortUiGrace();
            const closeUi = await openUi(server);
            const pending = postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            await new Promise((resolve) => setTimeout(resolve, 50));

            const started = Date.now();
            await closeUi();
            const body = workerNextResponseSchema.parse(await (await pending).json());

            expect(body.kind).toBe('done');
            expect(body.kind === 'done' && body.message).toContain('closed the tab');
            expect(Date.now() - started).toBeLessThan(1000);
        });

        it('keeps an open task when the UI leaves and returns done after it completes', async () => {
            const server = await startWithShortUiGrace();
            const closeUi = await openUi(server);
            const taskId = enqueueEcho(server);
            const issued = workerNextResponseSchema.parse(
                await (await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token)).json(),
            );
            expect(issued).toMatchObject({ kind: 'task', task: { id: taskId } });

            await closeUi();
            await new Promise((resolve) => setTimeout(resolve, 150));

            const stillWorking = workerNextResponseSchema.parse(
                await (await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token)).json(),
            );
            expect(stillWorking).toMatchObject({ kind: 'task', task: { id: taskId } });

            await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...BASE, taskId, result: 'done' },
                server.token,
            );
            const finished = workerNextResponseSchema.parse(
                await (await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token)).json(),
            );
            expect(finished.kind).toBe('done');
        });

        it('releases a cancelled task on done so a departed session does not appear busy', async () => {
            const server = await startWithShortUiGrace();
            const closeUi = await openUi(server);
            const taskId = enqueueEcho(server);
            const issued = workerNextResponseSchema.parse(
                await (await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token)).json(),
            );
            expect(issued).toMatchObject({ kind: 'task', task: { id: taskId } });

            expect(server.queue.cancel(taskId)).toBe('cancelled');
            expect(server.queue.getTask(taskId)).toMatchObject({ status: 'cancelled', workerId: BASE.workerId });

            await closeUi();
            await new Promise((resolve) => setTimeout(resolve, 150));
            const finished = workerNextResponseSchema.parse(
                await (await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token)).json(),
            );

            expect(finished.kind).toBe('done');
            expect(server.queue.getTask(taskId)).toMatchObject({
                status: 'cancelled',
                workerId: null,
                leaseExpiresAt: null,
            });
        });

        it('returns a task immediately when it is enqueued during the wait', async () => {
            const server = await start(30);

            const started = Date.now();
            const pending = postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            await new Promise((resolve) => setTimeout(resolve, 50));
            const taskId = enqueueEcho(server, 'wake up and return the task');

            const body = workerNextResponseSchema.parse(await (await pending).json());
            const elapsed = Date.now() - started;

            expect(body).toMatchObject({ kind: 'task', task: { id: taskId, type: 'echo', attempt: 1 } });
            expect(elapsed).toBeLessThan(5000);
        });

        it('uses the window from the server option', async () => {
            const server = await start(0.3);

            const started = Date.now();
            const response = await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            const elapsed = Date.now() - started;

            expect(workerNextResponseSchema.parse(await response.json()).kind).toBe('idle');
            expect(elapsed).toBeGreaterThanOrEqual(250);
            expect(elapsed).toBeLessThan(10_000);
        });

        /**
         * Regression #35: the death timeout measures silence, and a pending `next` is not silence.
         * Otherwise a worker waiting for an hour would appear dead, and the UI would show "Agent disconnected".
         */
        it('keeps the worker connected throughout a long wait', async () => {
            const server = await start(30);
            const pending = postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);
            await new Promise((resolve) => setTimeout(resolve, 50));

            // The clock is far past the death timeout. The call's connection keeps the session alive.
            advanceServerClock(WORKER_DEAD_AFTER_SECONDS + 1);
            expect(server.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId: WORKER });

            await new Promise((resolve) => setTimeout(resolve, 500));
            expect(server.workerRegistry.status()).toMatchObject({ kind: 'connected', workerId: WORKER });

            const taskId = enqueueEcho(server, 'task after a long wait');
            const body = workerNextResponseSchema.parse(await (await pending).json());
            expect(body).toMatchObject({ kind: 'task', task: { id: taskId } });
        });

        it('does not lease a task to a long-poll disconnected by the client', async () => {
            const server = await start(30);
            const controller = new AbortController();
            const pending = postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token, controller.signal).catch(
                () => null,
            );

            await new Promise((resolve) => setTimeout(resolve, 50));
            controller.abort();
            await pending;
            // The server sees disconnection asynchronously. Enqueue the task after it notices.
            await new Promise((resolve) => setTimeout(resolve, 100));

            const taskId = enqueueEcho(server);
            // Much longer than the fallback polling interval: a live wait would already have received a lease.
            await new Promise((resolve) => setTimeout(resolve, 1500));

            expect(server.queue.getTask(taskId)).toMatchObject({ status: 'queued', workerId: null });
        });
    });

    describe('task loop', () => {
        it('completes the full next → progress → complete sequence', async () => {
            const server = await start();
            const taskId = enqueueEcho(server);

            const next = workerNextResponseSchema.parse(
                await (await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token)).json(),
            );
            expect(next).toMatchObject({
                kind: 'task',
                task: { id: taskId, contextFiles: ['/tmp/sherpa/task-context.md'] },
                lease: { taskId, ttlSeconds: 600 },
            });

            const progress = await postJson(
                server.port,
                WORKER_ENDPOINTS.progress,
                { ...BASE, taskId, text: 'reading context' },
                server.token,
            );
            expect(taskAckResponseSchema.parse(await progress.json()).kind).toBe('accepted');

            const complete = await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...BASE, taskId, result: 'echo' },
                server.token,
            );
            expect(taskCompleteResponseSchema.parse(await complete.json()).kind).toBe('accepted');

            const record = server.queue.getTask(taskId);
            expect(record).toMatchObject({ status: 'done', result: 'echo', progressText: 'reading context' });

            const repeated = await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...BASE, taskId, result: 'echo' },
                server.token,
            );
            expect(taskCompleteResponseSchema.parse(await repeated.json()).kind).toBe('noop');
        });

        it('fails the task on explicit refusal', async () => {
            const server = await start();
            const taskId = enqueueEcho(server);
            await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.fail,
                { ...BASE, taskId, reason: 'no access to file' },
                server.token,
            );

            expect(taskAckResponseSchema.parse(await response.json()).kind).toBe('accepted');
            expect(server.queue.getTask(taskId)).toMatchObject({ status: 'failed', failReason: 'no access to file' });
        });

        it('returns unknown_task for a nonexistent task', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...BASE, taskId: 4040, result: 'nowhere' },
                server.token,
            );

            expect(response.status).toBe(404);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('unknown_task');
        });

        it('treats an oversized result as a task failure rather than a request validation failure', async () => {
            const server = await start();
            const taskId = enqueueEcho(server);
            await postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token);

            const response = await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...BASE, taskId, result: 'é'.repeat(RESULT_MAX_BYTES / 2 + 1) },
                server.token,
            );

            expect(response.status).toBe(413);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('result_too_large');
            expect(server.queue.getTask(taskId)?.status).toBe('failed');
        });
    });

    it('does not wait for a pending long-poll when stopping the server', async () => {
        const server = await start(60);
        const pending = postJson(server.port, WORKER_ENDPOINTS.next, BASE, server.token).catch(() => null);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const started = Date.now();
        await server.close();

        expect(Date.now() - started).toBeLessThan(5000);
        await pending;
    });
});
