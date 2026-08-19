import {
    PROTOCOL_VERSION,
    RESULT_MAX_BYTES,
    rpcErrorSchema,
    taskAckResponseSchema,
    taskCompleteResponseSchema,
    WORKER_ENDPOINTS,
    workerNextResponseSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REQUEST_BODY_MAX_BYTES } from './http.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { makeTempSherpaDir, postJson, postRaw, removeTempSherpaDir } from './test-support.js';

const PR_KEY = 'github-quillmart--quillmart--777';
const WORKER = 'w-1';
const BASE = { protocolVersion: PROTOCOL_VERSION, cliVersion: '0.1.0', workerId: WORKER };

describe('worker endpoints', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
    });

    afterEach(async () => {
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    /** The test sets the long-poll window. There is no need to wait the contract's 4 minutes in tests. */
    async function start(longPollSeconds = 0.3): Promise<SherpaServer> {
        const server = await startServer({ prKey: PR_KEY, sherpaDir, longPollSeconds });
        servers.push(server);
        return server;
    }

    function enqueueEcho(server: SherpaServer, instructions = 'Return the file contents as is.'): number {
        return server.queue.enqueue({
            type: 'echo',
            priority: 'interactive',
            instructions,
            contextFiles: ['/tmp/sherpa/task-context.md'],
        }).id;
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
