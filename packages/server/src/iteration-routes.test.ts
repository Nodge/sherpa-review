import fsSync from 'node:fs';

import { fixtureData, makeFixtureHost } from '@sherpa/fixtures';
import type { Iteration, PrDiff, RouteSectionResult, UiReviewRouteResponse, UiState } from '@sherpa/protocol';
import {
    rpcErrorSchema,
    UI_DEV_ENDPOINTS,
    UI_ENDPOINTS,
    UI_ROUTE_EVENT,
    UI_STATE_EVENT,
    uiReviewDiffResponseSchema,
    uiReviewProgressResponseSchema,
    uiReviewRouteResponseSchema,
    uiReviewSnapshotsResponseSchema,
    uiRouteEventSchema,
    uiStateSchema,
    uiChatResponseSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { asRawText, mediumRawResults } from './route/fixture-support.js';
import type { TaskRecord } from './queue.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

/**
 * Iteration endpoints (M4-T4) on the fixture host: list in the UI snapshot, route `stale`, snapshot
 * history, per-iteration diff and slice between iterations. The `advance-iteration` dev endpoint simulates a "push".
 */

const PR = 'fixture-medium';
const WORKER = 'w-iterations';
/** Iteration metadata for the `medium` fixture: v1, a regular push v2 and a force-push v3 over the second. */
function fixtureIterationMeta(index: number): Omit<Iteration, 'status'> {
    const meta = fixtureData('medium').iterations[index]?.iteration;
    if (meta === undefined) {
        throw new Error(`medium fixture has no iteration ${String(index + 1)}`);
    }
    return meta;
}

const V1 = fixtureIterationMeta(0);
const V2 = fixtureIterationMeta(1);
const V3 = fixtureIterationMeta(2);

/** Shared iteration context key, the same as `diffKeyOf` computes: identifies which iteration owns the diff. */
function diffKeyOf(iteration: { baseCommit: string; headCommit: string }): string {
    return `${iteration.baseCommit}-${iteration.headCommit}`;
}

describe('iterations in UI endpoints', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];
    let streams: SseStream[];
    /** How many times the host computed the interdiff: the cache must ask it only once. */
    let sliceCalls: number;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
        streams = [];
        sliceCalls = 0;
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

    async function start(): Promise<SherpaServer> {
        const host = makeFixtureHost('medium');
        const getDiff = host.getDiff.bind(host);
        host.getDiff = (slice) => {
            if (slice !== undefined) {
                sliceCalls += 1;
            }
            return getDiff(slice);
        };
        const server = await startServer({
            prKey: PR,
            sherpaDir,
            longPollSeconds: 0.3,
            reviewHostFactory: () => ({
                name: 'fixture',
                host,
                advanceIteration: () => host.advanceIteration(),
            }),
        });
        servers.push(server);
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await server.route.warmup();
        return server;
    }

    /** Full generation pass: submit the skeleton and all sections using fixture model outputs. */
    async function completeRoute(server: SherpaServer): Promise<string> {
        const skeleton = routeTasks(server, 'route.skeleton').at(-1) ?? 0;
        completeTask(server, skeleton, mediumRawResults().skeleton);
        for (const [position, taskId] of routeTasks(server, 'route.section').entries()) {
            completeTask(server, taskId, sectionFor(position + 1));
        }
        const route = (await readRoute(server)).route;
        expect(route.phase).toBe('ready');
        return route.snapshot?.snapshotId ?? '';
    }

    /** Pending generation tasks: a rebuild queue also holds closed tasks from the previous generation. */
    function routeTasks(server: SherpaServer, type: 'route.skeleton' | 'route.section'): number[] {
        return server.queue
            .listTasks()
            .filter((task) => task.type === type && task.status === 'queued')
            .map((task) => task.id);
    }

    function completeTask(server: SherpaServer, taskId: number, result: unknown): void {
        const leased = server.queue.next(WORKER);
        expect(leased?.task.id).toBe(taskId);
        server.queue.complete(WORKER, taskId, typeof result === 'string' ? result : asRawText(result));
    }

    function sectionFor(planIndex: number): RouteSectionResult {
        const section = mediumRawResults().sections.find((entry) => entry.stops[0]?.planIndex === planIndex);
        if (section === undefined) {
            throw new Error(`fixture has no section for stop ${String(planIndex)}`);
        }
        return section;
    }

    async function advance(server: SherpaServer): Promise<void> {
        const response = await postJson(
            server.port,
            UI_DEV_ENDPOINTS.fixtureAdvanceIteration,
            {},
            server.token,
        );
        expect(response.status).toBe(200);
    }

    async function readRoute(server: SherpaServer, query = ''): Promise<UiReviewRouteResponse> {
        const response = await get(server.port, `${UI_ENDPOINTS.reviewRoute}${query}`, server.token);
        expect(response.status).toBe(200);
        return uiReviewRouteResponseSchema.parse(await response.json());
    }

    async function readDiff(server: SherpaServer, query = ''): Promise<PrDiff> {
        const response = await get(server.port, `${UI_ENDPOINTS.reviewDiff}${query}`, server.token);
        expect(response.status).toBe(200);
        return uiReviewDiffResponseSchema.parse(await response.json()).diff;
    }

    /** SSE channel with the first state snapshot already read. */
    async function openState(server: SherpaServer): Promise<SseStream> {
        const stream = await openSse(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
        );
        streams.push(stream);
        return stream;
    }

    it('a push reaches the state snapshot without a reload and advances the route revision', async () => {
        const server = await start();
        await completeRoute(server);
        const stream = await openState(server);
        const before = await nextState(stream);
        expect(before.iterations.map((iteration) => [iteration.diffId, iteration.status])).toEqual([
            [V1.diffId, 'active'],
        ]);
        const beforeRoute = uiRouteEventSchema.parse(JSON.parse((await nextRoute(stream)).data));

        await advance(server);

        const after = await nextState(stream);
        expect(after.iterations.map((iteration) => [iteration.diffId, iteration.status])).toEqual([
            [V1.diffId, 'previous'],
            [V2.diffId, 'active'],
        ]);
        const afterRoute = uiRouteEventSchema.parse(JSON.parse((await nextRoute(stream)).data));
        expect(afterRoute.routeRevision).toBeGreaterThan(beforeRoute.routeRevision);
        expect(afterRoute.routeRevision).toBe((await readRoute(server)).routeRevision);
    });

    it('marks a previous iteration route stale and identifies both iterations', async () => {
        const server = await start();
        const snapshotId = await completeRoute(server);
        const stream = await openState(server);
        await nextState(stream);
        expect((await readRoute(server)).route.stale).toBeNull();

        await advance(server);
        await nextState(stream);

        const route = (await readRoute(server)).route;
        expect(route.stale).toMatchObject({
            routeCommit: V1.headCommit,
            prCommit: V2.headCommit,
            prDiffId: V2.diffId,
            newIterations: 1,
        });
        // The same snapshot can be read separately by id: the UI stays on it after a push.
        const past = await readRoute(server, `?snapshot=${snapshotId}`);
        expect(past.route.snapshot?.snapshotId).toBe(snapshotId);
        expect(past.route.phase).toBe('ready');
        expect(past.route.stale).toMatchObject({ prDiffId: V2.diffId });
    });

    it('rejects an unknown snapshot with bad_request', async () => {
        const server = await start();
        const response = await get(server.port, `${UI_ENDPOINTS.reviewRoute}?snapshot=no-such-snapshot`, server.token);
        expect(response.status).toBe(400);
        expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('bad_request');
    });

    it('snapshot history distinguishes current, stale and lost to a force-push', async () => {
        const server = await start();
        const stream = await openState(server);
        await nextState(stream);
        const first = await completeRoute(server);

        await advance(server);
        await nextState(stream);
        expect(await server.route.generate()).toBe('started');
        const second = await completeRoute(server);

        await advance(server);
        await nextState(stream);
        expect(await server.route.generate()).toBe('started');
        const third = await completeRoute(server);

        const response = await get(server.port, UI_ENDPOINTS.reviewSnapshots, server.token);
        expect(response.status).toBe(200);
        const snapshots = uiReviewSnapshotsResponseSchema.parse(await response.json()).snapshots;
        expect(snapshots.map((snapshot) => [snapshot.snapshotId, snapshot.diffId, snapshot.status])).toEqual([
            [first, V1.diffId, 'stale'],
            [second, V2.diffId, 'gone'],
            [third, V3.diffId, 'current'],
        ]);
        expect(snapshots.at(-1)?.previousSnapshotId).toBe(second);
    });

    it('returns a diff by iteration and rejects an unknown iteration', async () => {
        const server = await start();
        const stream = await openState(server);
        await nextState(stream);
        await advance(server);
        await nextState(stream);

        expect((await readDiff(server)).diffId).toBe(V2.diffId);
        expect((await readDiff(server, `?diffId=${V1.diffId}`)).headCommit).toBe(V1.headCommit);
        expect((await readDiff(server, `?diffId=${V2.diffId}`)).headCommit).toBe(V2.headCommit);

        const response = await get(server.port, `${UI_ENDPOINTS.reviewDiff}?diffId=99999`, server.token);
        expect(response.status).toBe(400);
        expect(rpcErrorSchema.parse(await response.json()).error.message).toContain('not saved');
    });

    it('computes an interdiff once and then reads it from the cache', async () => {
        const server = await start();
        const stream = await openState(server);
        await nextState(stream);
        await advance(server);
        await nextState(stream);

        const query = `?base=${V1.diffId}&head=${V2.diffId}`;
        const slice = await readDiff(server, query);
        const before = sliceCalls;
        const again = await readDiff(server, query);

        expect(slice.diffId).toBe(V2.diffId);
        expect(slice.baseCommit).toBe(V1.headCommit);
        expect(again).toEqual(slice);
        expect(sliceCalls).toBe(before);
    });

    it('previous iteration progress is empty: M4-T6 adds the iteration dimension to its tables', async () => {
        const server = await start();
        await completeRoute(server);
        const snapshotId = (await readRoute(server)).route.snapshot?.snapshotId ?? '';
        await postJson(
            server.port,
            UI_ENDPOINTS.reviewStopViewed,
            { snapshotId, stopId: 's01', viewed: true, ranges: [] },
            server.token,
        );
        const stream = await openState(server);
        await nextState(stream);
        await advance(server);
        await nextState(stream);

        const active = await readProgress(server, `?diffId=${V2.diffId}`);
        const past = await readProgress(server, `?diffId=${V1.diffId}`);

        expect(active.stops).toEqual([{ stopId: 's01', viewed: true }]);
        expect(past.stops).toEqual([]);
        expect(past.progressRevision).toBe(active.progressRevision);
    });

    async function readProgress(server: SherpaServer, query = '') {
        const response = await get(server.port, `${UI_ENDPOINTS.reviewProgress}${query}`, server.token);
        expect(response.status).toBe(200);
        return uiReviewProgressResponseSchema.parse(await response.json());
    }
});

describe('generation and questions on their own iteration', () => {
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

    /** Server with an agent, an open SSE channel (otherwise the iteration feed never starts) and a ready route. */
    async function start(): Promise<{ server: SherpaServer; stream: SseStream }> {
        const host = makeFixtureHost('medium');
        const server = await startServer({
            prKey: PR,
            sherpaDir,
            longPollSeconds: 0.3,
            reviewHostFactory: () => ({
                name: 'fixture',
                host,
                advanceIteration: () => host.advanceIteration(),
            }),
        });
        servers.push(server);
        const stream = await openSse(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
        );
        streams.push(stream);
        await nextState(stream);
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await server.route.warmup();
        return { server, stream };
    }

    async function advance(server: SherpaServer, stream: SseStream): Promise<void> {
        const response = await postJson(
            server.port,
            UI_DEV_ENDPOINTS.fixtureAdvanceIteration,
            {},
            server.token,
        );
        expect(response.status).toBe(200);
        await nextState(stream);
    }

    function queuedTasks(server: SherpaServer, type: 'route.skeleton' | 'route.section'): TaskRecord[] {
        return server.queue.listTasks().filter((task) => task.type === type && task.status === 'queued');
    }

    function completeTask(server: SherpaServer, taskId: number, result: unknown): void {
        const leased = server.queue.next(WORKER);
        expect(leased?.task.id).toBe(taskId);
        server.queue.complete(WORKER, taskId, typeof result === 'string' ? result : asRawText(result));
    }

    function sectionFor(planIndex: number): RouteSectionResult {
        const section = mediumRawResults().sections.find((entry) => entry.stops[0]?.planIndex === planIndex);
        if (section === undefined) {
            throw new Error(`fixture has no section for stop ${String(planIndex)}`);
        }
        return section;
    }

    async function readRoute(server: SherpaServer): Promise<UiReviewRouteResponse> {
        const response = await get(server.port, UI_ENDPOINTS.reviewRoute, server.token);
        expect(response.status).toBe(200);
        return uiReviewRouteResponseSchema.parse(await response.json());
    }

    it('a push during generation does not move it to the new iteration: the snapshot is stale from creation', async () => {
        const { server, stream } = await start();
        const skeleton = queuedTasks(server, 'route.skeleton')[0]?.id ?? 0;

        await advance(server, stream);
        completeTask(server, skeleton, mediumRawResults().skeleton);
        const sections = queuedTasks(server, 'route.section');
        for (const [position, task] of sections.entries()) {
            completeTask(server, task.id, sectionFor(position + 1));
        }

        const route = (await readRoute(server)).route;
        expect(route.phase).toBe('ready');
        expect(route.snapshot?.diffId).toBe(V1.diffId);
        expect(route.snapshot?.commit).toBe(V1.headCommit);
        expect(route.stale).toMatchObject({ prDiffId: V2.diffId, newIterations: 1 });
        // Sections queued after the push use the shared diff of their own iteration.
        expect(sections[0]?.contextFiles.some((file) => file.includes(diffKeyOf(V1)))).toBe(true);
    });

    it('a rebuild after a push builds a snapshot on the new iteration and remembers the previous one', async () => {
        const { server, stream } = await start();
        completeTask(server, queuedTasks(server, 'route.skeleton')[0]?.id ?? 0, mediumRawResults().skeleton);
        for (const [position, task] of queuedTasks(server, 'route.section').entries()) {
            completeTask(server, task.id, sectionFor(position + 1));
        }
        const first = (await readRoute(server)).route.snapshot?.snapshotId;

        await advance(server, stream);
        expect(await server.route.generate()).toBe('started');
        completeTask(server, queuedTasks(server, 'route.skeleton')[0]?.id ?? 0, mediumRawResults().skeleton);
        for (const [position, task] of queuedTasks(server, 'route.section').entries()) {
            completeTask(server, task.id, sectionFor(position + 1));
        }

        const route = (await readRoute(server)).route;
        expect(route.snapshot?.diffId).toBe(V2.diffId);
        expect(route.snapshot?.previousSnapshotId).toBe(first);
        expect(route.stale).toBeNull();
    });

    it('filling a stop after a push uses the diff of the snapshot iteration', async () => {
        const { server, stream } = await start();
        completeTask(server, queuedTasks(server, 'route.skeleton')[0]?.id ?? 0, mediumRawResults().skeleton);
        const sections = queuedTasks(server, 'route.section');
        const failed = sections[0]?.id ?? 0;
        expect(server.queue.next(WORKER)?.task.id).toBe(failed);
        server.queue.fail(WORKER, failed, 'agent stopped early');
        for (const [position, task] of sections.entries()) {
            if (task.id !== failed) {
                completeTask(server, task.id, sectionFor(position + 1));
            }
        }
        const snapshotId = (await readRoute(server)).route.snapshot?.snapshotId ?? '';

        await advance(server, stream);
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewRouteFillStop,
            { snapshotId, planIndex: 1 },
            server.token,
        );

        expect(response.status).toBe(200);
        const refill = queuedTasks(server, 'route.section')[0];
        expect(refill?.contextFiles.some((file) => file.includes(diffKeyOf(V1)))).toBe(true);
        expect(refill?.contextFiles.some((file) => file.includes(diffKeyOf(V2)))).toBe(false);
    });

    it('a question about a previous iteration uses its patch and preserves the context of ongoing generation', async () => {
        const { server, stream } = await start();
        completeTask(server, queuedTasks(server, 'route.skeleton')[0]?.id ?? 0, mediumRawResults().skeleton);
        for (const [position, task] of queuedTasks(server, 'route.section').entries()) {
            completeTask(server, task.id, sectionFor(position + 1));
        }
        await advance(server, stream);
        // The rebuild on the new iteration keeps its shared context through an open task.
        expect(await server.route.generate()).toBe('started');
        const routeTask = queuedTasks(server, 'route.skeleton')[0];
        expect(routeTask?.contextFiles.some((file) => file.includes(diffKeyOf(V2)))).toBe(true);

        const anchored = fixtureData('medium').iterations[0]?.diff.files.find(
            (file) => file.path === 'services/orders/src/api/handlers.ts',
        );
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatAsk,
            {
                text: 'Why did this handler look like this in the previous iteration?',
                anchor: {
                    diffId: V1.diffId,
                    fileId: anchored?.fileId,
                    path: anchored?.path,
                    side: 'new',
                    start: 2,
                    end: 4,
                },
            },
            server.token,
        );
        expect(response.status).toBe(200);

        const chatTask = server.queue.listTasks().find((task) => task.type === 'chat');
        const selection = chatTask?.contextFiles.find((file) => file.endsWith('selection.patch.md')) ?? '';
        expect(fsSync.readFileSync(selection, 'utf8')).toContain('services/orders/src/api/handlers.ts');
        // Question cleanup leaves the shared context of the open route task intact.
        for (const file of routeTask?.contextFiles ?? []) {
            expect(fsSync.existsSync(file)).toBe(true);
        }

        // The exchange commit is the head of the anchor iteration: context uses its patch, not the active one.
        expect(server.queue.next(WORKER)?.task.id).toBe(chatTask?.id);
        server.queue.complete(WORKER, chatTask?.id ?? 0, 'The handler did not know about the edit window yet.');
        const chat = uiChatResponseSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.reviewChat, server.token)).json(),
        );
        expect(chat.notes[0]?.origin.commit).toBe(V1.headCommit);
    });

    it('rejects a question about an iteration without a saved patch with bad_request', async () => {
        const { server } = await start();
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewChatAsk,
            {
                text: 'What about the iteration before last?',
                anchor: {
                    diffId: '404404',
                    fileId: 'file-1',
                    path: 'services/orders/src/api/handlers.ts',
                    side: 'new',
                    start: 2,
                    end: 4,
                },
            },
            server.token,
        );

        expect(response.status).toBe(400);
        expect(rpcErrorSchema.parse(await response.json()).error.message).toContain('not saved');
    });
});

async function nextState(stream: SseStream): Promise<UiState> {
    for (;;) {
        const event = await stream.next();
        if (event.event === UI_STATE_EVENT) {
            return uiStateSchema.parse(JSON.parse(event.data));
        }
    }
}

async function nextRoute(stream: SseStream): Promise<SseEvent> {
    for (;;) {
        const event = await stream.next();
        if (event.event === UI_ROUTE_EVENT) {
            return event;
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

/** Minimal SSE client: Node has no `EventSource`, and events here are read one at a time. */
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
