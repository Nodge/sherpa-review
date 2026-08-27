import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
    PROTOCOL_VERSION,
    rpcErrorSchema,
    UI_ENDPOINTS,
    UI_STATE_EVENT,
    uiCancelResponseSchema,
    uiEnqueueResponseSchema,
    uiStateSchema,
    WORKER_ENDPOINTS,
    workerNextResponseSchema,
} from '@sherpa/protocol';
import type { UiState } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { databasePathFor } from './paths.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { directoryAssets } from './static.js';
import { get, makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

const PR_KEY = 'github-quillmart--quillmart--4242';
const WORKER = 'w-ui';
const WORKER_BASE = { protocolVersion: PROTOCOL_VERSION, cliVersion: '0.1.0', workerId: WORKER };

describe('UI endpoints', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];
    let streams: SseStream[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
        streams = [];
    });

    afterEach(async () => {
        for (const stream of streams) {
            stream.close();
        }
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    async function start(uiDir?: string): Promise<SherpaServer> {
        // This suite uses a hosted review key, but tests must not call a live service (requirements §7):
        // no host means review endpoints return `no_review_host` and SSE only sends state.
        const base = { prKey: PR_KEY, sherpaDir, longPollSeconds: 0.3, reviewHostFactory: () => null };
        const server = await startServer(
            uiDir === undefined ? base : { ...base, assets: directoryAssets(uiDir) },
        );
        servers.push(server);
        return server;
    }

    async function readState(server: SherpaServer): Promise<UiState> {
        const response = await get(server.port, UI_ENDPOINTS.state, server.token);
        expect(response.status).toBe(200);
        return uiStateSchema.parse(await response.json());
    }

    async function openEvents(server: SherpaServer, token: string = server.token): Promise<SseStream> {
        const stream = await openSse(`http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${token}`);
        streams.push(stream);
        return stream;
    }

    describe('state snapshot', () => {
        it('returns 401 without a token', async () => {
            const server = await start();

            const response = await get(server.port, UI_ENDPOINTS.state);

            expect(response.status).toBe(401);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('unauthorized');
        });

        it('empty PR: key, worker `never`, empty queue', async () => {
            const server = await start();

            const state = await readState(server);

            expect(state.prKey).toBe(PR_KEY);
            expect(state.worker.kind).toBe('never');
            expect(state.tasks).toEqual([]);
            // This suite has no host, so there is no source for PR metadata, and the snapshot is empty.
            expect(state.pr).toBeNull();
        });

        it('does not expose server-internal task details', async () => {
            const server = await start();
            server.queue.enqueue({
                type: 'echo',
                priority: 'interactive',
                instructions: 'return text',
                contextFiles: ['/tmp/sherpa/context.md'],
            });

            const state = await readState(server);

            expect(state.tasks).toHaveLength(1);
            expect(Object.keys(state.tasks[0] ?? {})).not.toContain('contextFiles');
            expect(Object.keys(state.tasks[0] ?? {})).not.toContain('workerId');
        });
    });

    describe('enqueueing a task', () => {
        it('echo with text: defaults to interactive priority, puts text in instructions', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.enqueue,
                { type: 'echo', text: 'hello from UI' },
                server.token,
            );

            expect(response.status).toBe(200);
            const { task } = uiEnqueueResponseSchema.parse(await response.json());
            expect(task.status).toBe('queued');
            expect(task.priority).toBe('interactive');
            expect(task.attempt).toBe(1);
            expect(task.instructions).toContain('hello from UI');
            expect(task.instructions).toContain('echo task');
        });

        it('passes explicit background priority to the queue', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.enqueue,
                { type: 'echo', text: 'background', priority: 'background' },
                server.token,
            );

            expect(uiEnqueueResponseSchema.parse(await response.json()).task.priority).toBe('background');
        });

        it('empty text returns bad_request with a list of errors', async () => {
            const server = await start();

            const response = await postJson(server.port, UI_ENDPOINTS.enqueue, { type: 'echo', text: '' }, server.token);

            expect(response.status).toBe(400);
            const body = rpcErrorSchema.parse(await response.json());
            expect(body.error.code).toBe('bad_request');
            expect(body.error.details?.some((detail) => detail.startsWith('text:'))).toBe(true);
        });

        it('validation rejects an unknown task type', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.enqueue,
                { type: 'route.section', text: 'something' },
                server.token,
            );

            expect(response.status).toBe(400);
        });
    });

    describe('cancellation', () => {
        it('cancels a queued task, repeat is a noop', async () => {
            const server = await start();
            const task = server.queue.enqueue({
                type: 'echo',
                priority: 'interactive',
                instructions: 'return text',
                contextFiles: [],
            });

            const first = await postJson(server.port, UI_ENDPOINTS.cancel, { taskId: task.id }, server.token);
            const second = await postJson(server.port, UI_ENDPOINTS.cancel, { taskId: task.id }, server.token);

            expect(uiCancelResponseSchema.parse(await first.json()).outcome).toBe('cancelled');
            expect(uiCancelResponseSchema.parse(await second.json()).outcome).toBe('noop');
            expect((await readState(server)).tasks[0]?.status).toBe('cancelled');
        });

        it('returns unknown_task for a nonexistent task', async () => {
            const server = await start();

            const response = await postJson(server.port, UI_ENDPOINTS.cancel, { taskId: 999 }, server.token);

            expect(response.status).toBe(404);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('unknown_task');
        });
    });

    describe('SSE channel', () => {
        it('sends a snapshot immediately on connection', async () => {
            const server = await start();

            const stream = await openEvents(server);
            const event = await stream.next();

            expect(event.event).toBe(UI_STATE_EVENT);
            expect(uiStateSchema.parse(JSON.parse(event.data)).prKey).toBe(PR_KEY);
        });

        it('sends a fresh snapshot after enqueueing and after result submission', async () => {
            const server = await start();
            const stream = await openEvents(server);
            await nextState(stream);

            await postJson(server.port, UI_ENDPOINTS.enqueue, { type: 'echo', text: 'loop' }, server.token);
            const afterEnqueue = await nextState(stream);
            expect(afterEnqueue.tasks).toHaveLength(1);
            expect(afterEnqueue.tasks[0]?.status).toBe('queued');

            const taskId = afterEnqueue.tasks[0]?.id ?? 0;
            await postJson(server.port, WORKER_ENDPOINTS.next, WORKER_BASE, server.token);
            const afterLease = await nextState(stream);
            expect(afterLease.tasks[0]?.status).toBe('leased');

            await postJson(
                server.port,
                WORKER_ENDPOINTS.complete,
                { ...WORKER_BASE, taskId, result: 'loop' },
                server.token,
            );
            const afterComplete = await nextState(stream);
            expect(afterComplete.tasks[0]?.status).toBe('done');
            expect(afterComplete.tasks[0]?.result).toBe('loop');
        });

        it('accepts a query token only on the SSE endpoint', async () => {
            const server = await start();

            const events = await fetch(
                `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
            );
            const state = await fetch(
                `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.state}?token=${server.token}`,
            );

            expect(events.status).toBe(200);
            await events.body?.cancel();
            expect(state.status).toBe(401);
        });

        it('returns 401 for a wrong query token', async () => {
            const server = await start();

            const response = await fetch(
                `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=wrong-token`,
            );

            expect(response.status).toBe(401);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('unauthorized');
        });

        it('reports a broken worker connection to the UI without incoming requests', async () => {
            // Shorten the grace period between calls: no need to wait a minute in a test.
            const server = await startServer({
                prKey: PR_KEY,
                sherpaDir,
                longPollSeconds: 30,
                workerGapGraceSeconds: 0.3,
                reviewHostFactory: () => null,
            });
            servers.push(server);
            const stream = await openEvents(server);
            expect((await nextState(stream)).worker.kind).toBe('never');

            const aborter = new AbortController();
            const pending = postJson(
                server.port,
                WORKER_ENDPOINTS.next,
                WORKER_BASE,
                server.token,
                aborter.signal,
            ).catch(() => null);
            expect((await nextState(stream)).worker.kind).toBe('connected');

            // The session died during long-poll: nobody calls the server again, and the timer changes the status.
            aborter.abort();
            await pending;

            const state = await nextState(stream);
            expect(state.worker).toMatchObject({ kind: 'disconnected', workerId: WORKER });
        });

        it('closes the channel if snapshot assembly fails, while the server keeps responding', async () => {
            const server = await start();
            server.queue.enqueue({
                type: 'echo',
                priority: 'interactive',
                instructions: 'return text',
                contextFiles: [],
            });
            corruptTasks(sherpaDir);

            const stream = await openEvents(server);
            // Fail-closed: do not expose a corrupt row. There is nobody to catch an SSE exception, so
            // the channel closes without an event, and the browser enters "reconnecting".
            await expect(stream.next()).rejects.toThrow('closed before');

            expect((await get(server.port, UI_ENDPOINTS.state, server.token)).status).toBe(500);
            expect((await get(server.port, '/healthz', server.token)).status).toBe(200);
        });
    });

    describe('UI static assets', () => {
        let uiDir: string;

        beforeEach(async () => {
            uiDir = path.join(sherpaDir, 'ui-dist');
            await fs.mkdir(path.join(uiDir, 'assets'), { recursive: true });
            await fs.writeFile(path.join(uiDir, 'index.html'), '<!doctype html><title>Sherpa</title>');
            await fs.writeFile(path.join(uiDir, 'assets', 'app.js'), 'export const ok = 1;');
            await fs.writeFile(path.join(sherpaDir, 'secret.txt'), 'token and other secrets');
        });

        it('serves index.html at the root without a token', async () => {
            const server = await start(uiDir);

            const response = await get(server.port, '/');

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('text/html');
            expect(await response.text()).toContain('Sherpa');
        });

        it('serves assets with the correct content-type', async () => {
            const server = await start(uiDir);

            const response = await get(server.port, '/assets/app.js');

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('text/javascript');
        });

        it('rejects paths outside the build directory', async () => {
            const server = await start(uiDir);

            const response = await fetch(
                `http://127.0.0.1:${String(server.port)}/assets/%2e%2e%2f%2e%2e%2fsecret.txt`,
            );

            expect(response.status).toBe(404);
            expect(await response.text()).not.toContain('secrets');
        });

        it('without uiDir, the root keeps returning a restricted API response', async () => {
            const server = await start();

            const response = await get(server.port, '/');

            expect(response.status).toBe(401);
        });
    });

    it('full loop: enqueue from UI → worker next → complete → done in state', async () => {
        const server = await start();

        const enqueued = await postJson(
            server.port,
            UI_ENDPOINTS.enqueue,
            { type: 'echo', text: 'loop check' },
            server.token,
        );
        const { task } = uiEnqueueResponseSchema.parse(await enqueued.json());

        const next = await postJson(server.port, WORKER_ENDPOINTS.next, WORKER_BASE, server.token);
        const leased = workerNextResponseSchema.parse(await next.json());
        expect(leased.kind).toBe('task');
        if (leased.kind !== 'task') {
            throw new Error('worker did not receive a task');
        }
        expect(leased.task.id).toBe(task.id);
        expect(leased.task.instructions).toContain('loop check');

        await postJson(
            server.port,
            WORKER_ENDPOINTS.complete,
            { ...WORKER_BASE, taskId: task.id, result: 'loop check' },
            server.token,
        );

        const state = await readState(server);
        expect(state.worker.kind).toBe('connected');
        expect(state.tasks[0]?.status).toBe('done');
        expect(state.tasks[0]?.result).toBe('loop check');
    });
});

/** Corrupts a task row outside the server to test how it handles damaged storage. */
function corruptTasks(sherpaDir: string): void {
    const db = new DatabaseSync(databasePathFor(sherpaDir, PR_KEY));
    try {
        db.prepare("UPDATE tasks SET context_files = 'this is not json'").run();
    } finally {
        db.close();
    }
}

/**
 * The next state snapshot: the channel also carries other events (reading progress revisions),
 * but this suite only cares about state.
 */
async function nextState(stream: SseStream): Promise<UiState> {
    for (;;) {
        const event = await stream.next();
        if (event.event === UI_STATE_EVENT) {
            return uiStateSchema.parse(JSON.parse(event.data));
        }
    }
}

interface SseEvent {
    readonly event: string;
    readonly data: string;
}

interface SseStream {
    readonly next: () => Promise<SseEvent>;
    readonly close: () => void;
}

/** Minimal SSE client: Node has no `EventSource`, and tests read events one at a time. */
async function openSse(url: string): Promise<SseStream> {
    const controller = new AbortController();
    const response = await fetch(url, { signal: controller.signal });
    if (response.status !== 200 || response.body === null) {
        throw new Error(`SSE channel did not open: ${String(response.status)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const ready: SseEvent[] = [];
    let buffer = '';

    return {
        next: async () => {
            for (;;) {
                const event = ready.shift();
                if (event !== undefined) {
                    return event;
                }

                // Stream types differ between lib.dom and @types/node, so we specify the chunk shape ourselves.
                const chunk: { done: boolean; value?: Uint8Array } = await reader.read();
                if (chunk.done) {
                    throw new Error('SSE channel closed before the expected event');
                }
                buffer += decoder.decode(chunk.value, { stream: true });

                let boundary = buffer.indexOf('\n\n');
                while (boundary !== -1) {
                    ready.push(parseSseEvent(buffer.slice(0, boundary)));
                    buffer = buffer.slice(boundary + 2);
                    boundary = buffer.indexOf('\n\n');
                }
            }
        },
        close: () => {
            controller.abort();
        },
    };
}

function parseSseEvent(raw: string): SseEvent {
    let event = 'message';
    const data: string[] = [];
    for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) {
            event = line.slice('event: '.length);
        } else if (line.startsWith('data: ')) {
            data.push(line.slice('data: '.length));
        }
    }
    return { event, data: data.join('\n') };
}
