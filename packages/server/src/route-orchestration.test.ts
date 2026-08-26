import fsSync from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { makeFixtureHost } from '@sherpa/fixtures';
import type { RouteSectionResult, TaskCompleteResponse, UiReviewRouteResponse } from '@sherpa/protocol';
import {
    LEASE_TTL_SECONDS,
    rpcErrorSchema,
    UI_ENDPOINTS,
    UI_ROUTE_EVENT,
    uiReviewProgressResponseSchema,
    uiReviewRouteResponseSchema,
    uiRouteEventSchema,
    uiRouteGenerateResponseSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { databasePathFor, payloadDirOf } from './paths.js';
import type { TaskRecord } from './queue.js';
import { MAX_RESULT_REJECTIONS } from './queue.js';
import { MAX_SKELETON_TASKS } from './route-orchestrator.js';
import { contentHashOf } from './route-store.js';
import { asRawText, mediumRawResults, mediumReadySnapshot } from './route/fixture-support.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

/**
 * Route orchestration (M2-T4) on the fixture host: automatic enqueueing, result acceptance
 * by the validator, generation phases and recovery after a restart. There is no network host here. `fixture-medium`
 * returns the same diff used to build the validator's golden corpus.
 */

const MEDIUM_PR = 'fixture-medium';
const SMALL_PR = 'fixture-small';
const WORKER = 'w-route';

describe('route orchestration', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];
    let streams: SseStream[];
    let clockOffsetMs: number;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
        streams = [];
        clockOffsetMs = 0;
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

    async function start(prKey: string = MEDIUM_PR): Promise<SherpaServer> {
        const server = await startServer({
            prKey,
            sherpaDir,
            longPollSeconds: 0.3,
            now: () => new Date(Date.now() + clockOffsetMs),
        });
        servers.push(server);
        return server;
    }

    /** Connect the agent and warm up deterministically: tests need not wait for the warmup timer. */
    async function startWithWorker(prKey: string = MEDIUM_PR): Promise<SherpaServer> {
        const server = await start(prKey);
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await server.route.warmup();
        return server;
    }

    async function readRoute(server: SherpaServer): Promise<UiReviewRouteResponse> {
        const response = await get(server.port, UI_ENDPOINTS.reviewRoute, server.token);
        expect(response.status).toBe(200);
        return uiReviewRouteResponseSchema.parse(await response.json());
    }

    function routeTasks(server: SherpaServer, type: 'route.skeleton' | 'route.section'): number[] {
        return server.queue
            .listTasks()
            .filter((task) => task.type === type && task.status !== 'cancelled')
            .map((task) => task.id);
    }

    /** Give a task to the agent and submit its result, through the same path the worker endpoint uses. */
    function completeTask(server: SherpaServer, taskId: number, result: unknown): TaskCompleteResponse {
        const leased = server.queue.next(WORKER);
        expect(leased?.task.id).toBe(taskId);
        return server.queue.complete(WORKER, taskId, typeof result === 'string' ? result : asRawText(result));
    }

    function sectionFor(planIndex: number): RouteSectionResult {
        const section = mediumRawResults().sections.find((entry) => entry.stops[0]?.planIndex === planIndex);
        if (section === undefined) {
            throw new Error(`fixture has no section for stop ${String(planIndex)}`);
        }
        return section;
    }

    it('warmup enqueues a skeleton when an agent is connected, the PR exceeds the threshold and there is no route', async () => {
        const server = await startWithWorker();

        expect(routeTasks(server, 'route.skeleton')).toHaveLength(1);
        const route = await readRoute(server);
        expect(route.route.phase).toBe('reading');
        expect(route.route.smallPr).toBe(false);
        expect(route.routeRevision).toBeGreaterThan(0);
    });

    it('re-registering the agent and repeating warmup creates no duplicates', async () => {
        const server = await startWithWorker();

        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        server.workerRegistry.register('another-session', 'codex');
        await server.route.warmup();
        await server.route.warmup();

        expect(routeTasks(server, 'route.skeleton')).toHaveLength(1);
    });

    it('skeleton → sections → ready snapshot matches the fixture', async () => {
        const server = await startWithWorker();
        const [skeletonId] = routeTasks(server, 'route.skeleton');

        expect(completeTask(server, skeletonId ?? 0, mediumRawResults().skeleton).kind).toBe('accepted');

        const afterSkeleton = (await readRoute(server)).route;
        expect(afterSkeleton.phase).toBe('filling');
        expect(afterSkeleton.snapshot?.stops.map((stop) => stop.id)).toEqual(
            mediumReadySnapshot().stops.map((stop) => stop.id),
        );
        expect(afterSkeleton.snapshot?.contentHash).toBeNull();

        // Sections are enqueued one per stop, in plan order: the first submitted result wins a range
        // conflict, so the queue must offer stops in ascending number order.
        const sectionIds = routeTasks(server, 'route.section');
        expect(sectionIds).toHaveLength(6);
        expect(sectionIds.map((id) => server.route.stopsOfTask(id))).toEqual([[1], [2], [3], [4], [5], [6]]);

        for (const [position, taskId] of sectionIds.entries()) {
            const planIndex = position + 1;
            const leased = server.queue.next(WORKER);
            expect(leased?.task.id).toBe(taskId);
            // The lease is claimed, so the stop is being filled.
            expect((await readRoute(server)).route.snapshot?.stops[position]?.status).toBe('filling');

            expect(server.queue.complete(WORKER, taskId, asRawText(sectionFor(planIndex))).kind).toBe('accepted');
        }

        const ready = (await readRoute(server)).route;
        expect(ready.phase).toBe('ready');
        expect(ready.snapshot?.stops).toEqual(mediumReadySnapshot().stops);
        expect(ready.snapshot?.summary).toBe(mediumReadySnapshot().summary);
        expect(ready.snapshot?.tourOrder).toEqual(mediumReadySnapshot().tourOrder);
        expect(ready.snapshot?.contentHash).toMatch(/^[0-9a-f]{12}$/);
        expect(ready.snapshot?.provenance).toEqual({ harness: 'claude-code', model: 'opus-5' });
        expect(ready.snapshot?.commit).toBe(mediumReadySnapshot().commit);
    });

    it('task payloads are on disk with context and schema present when issued', async () => {
        const server = await startWithWorker();
        const payloadDir = payloadDirOf(sherpaDir, MEDIUM_PR);

        const skeleton = server.queue.getTask(routeTasks(server, 'route.skeleton')[0] ?? 0);
        expectPayloadOnDisk(skeleton, payloadDir);

        completeTask(server, skeleton?.id ?? 0, mediumRawResults().skeleton);
        const section = server.queue.getTask(routeTasks(server, 'route.section')[0] ?? 0);
        expectPayloadOnDisk(section, payloadDir);
        // Both tasks belong to one generation and live in the same subdirectory.
        expect(fsSync.readdirSync(payloadDir)).toHaveLength(1);
    });

    it('restarting generation removes the previous payload', async () => {
        const server = await startWithWorker();
        const payloadDir = payloadDirOf(sherpaDir, MEDIUM_PR);
        const before = server.queue.getTask(routeTasks(server, 'route.skeleton')[0] ?? 0);

        // Failure and a new generation: nobody needs the old files anymore.
        server.queue.next(WORKER);
        server.queue.fail(WORKER, before?.id ?? 0, 'could not complete');
        expect((await readRoute(server)).route.phase).toBe('failed');
        expect(await server.route.generate()).toBe('started');

        expect(fsSync.existsSync(before?.contextFiles[0] ?? '')).toBe(false);
        expect(fsSync.readdirSync(payloadDir)).toHaveLength(1);
        expectPayloadOnDisk(server.queue.getTask(routeTasks(server, 'route.skeleton').at(-1) ?? 0), payloadDir);
    });

    it('invalid skeleton: three rejections preserve the lease, and phase failed prevents a fourth', async () => {
        const server = await startWithWorker();
        const skeletonId = routeTasks(server, 'route.skeleton')[0] ?? 0;
        const broken = asRawText(mediumRawResults().broken.skeletonTourOrderNotPermutation);

        const first = completeTask(server, skeletonId, broken);
        expect(first.kind).toBe('rejected');
        expect(first.kind === 'rejected' && first.errors[0]).toContain('tourOrder');
        expect(server.queue.getTask(skeletonId)).toMatchObject({ status: 'leased', attempt: 1 });
        expect((await readRoute(server)).route.phase).toBe('reading');

        expect(server.queue.complete(WORKER, skeletonId, broken).kind).toBe('rejected');
        expect(server.queue.getTask(skeletonId)?.status).toBe('leased');

        const last = server.queue.complete(WORKER, skeletonId, broken);
        expect(last.kind).toBe('rejected');
        expect(server.queue.getTask(skeletonId)?.status).toBe('failed');

        const route = (await readRoute(server)).route;
        expect(route.phase).toBe('failed');
        expect(route.failure?.message).toContain('Агент не построил план маршрута');
        expect(route.failure?.rawOutput).toBe(broken);
        expect(route.snapshot).toBeNull();
    });

    it('a section failure leaves the phase running, the stop failed and the route eventually ready', async () => {
        const server = await startWithWorker();
        completeTask(server, routeTasks(server, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);
        const sectionIds = routeTasks(server, 'route.section');

        // The agent explicitly failed the first stop and submitted the rest as usual.
        const failing = sectionIds[0] ?? 0;
        server.queue.next(WORKER);
        server.queue.fail(WORKER, failing, 'could not understand this file');

        for (const [position, taskId] of sectionIds.entries()) {
            if (taskId === failing) {
                continue;
            }
            server.queue.next(WORKER);
            server.queue.complete(WORKER, taskId, asRawText(sectionFor(position + 1)));
        }

        const route = (await readRoute(server)).route;
        expect(route.phase).toBe('ready');
        expect(route.snapshot?.stops[0]?.status).toBe('failed');
        expect(route.snapshot?.stops[0]?.validationNotes.join(' ')).toContain('could not understand this file');
        expect(route.snapshot?.stops[1]?.status).toBe('ready');
    });

    it('agent death returns the task on lease expiry, with the stop queued again and the phase filling', async () => {
        const server = await startWithWorker();
        completeTask(server, routeTasks(server, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);
        const sectionIds = routeTasks(server, 'route.section');
        // The agent submitted the first stop before it was killed on the second.
        completeTask(server, sectionIds[0] ?? 0, sectionFor(1));
        server.queue.next(WORKER);
        expect((await readRoute(server)).route.snapshot?.stops[1]?.status).toBe('filling');

        clockOffsetMs = (LEASE_TTL_SECONDS.background + 1) * 1000;
        // Any queue read reclaims the expired lease. No timers are needed.
        server.queue.listTasks();

        expect(server.queue.getTask(sectionIds[1] ?? 0)).toMatchObject({ status: 'queued', attempt: 2 });
        const route = (await readRoute(server)).route;
        expect(route.phase).toBe('filling');
        expect(route.snapshot?.stops[1]?.status).toBe('queued');
        // Filled stops remain readable: the stop submitted before agent death is still here (SPEC §4.4).
        expect(route.snapshot?.stops[0]).toEqual(mediumReadySnapshot().stops[0]);
    });

    it('section batch size is configurable, with three stops in one task', async () => {
        const server = await startServer({
            prKey: MEDIUM_PR,
            sherpaDir,
            longPollSeconds: 0.3,
            route: { sectionBatchSize: 3 },
        });
        servers.push(server);
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await server.route.warmup();
        completeTask(server, routeTasks(server, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);

        const sectionIds = routeTasks(server, 'route.section');
        expect(sectionIds.map((id) => server.route.stopsOfTask(id))).toEqual([
            [1, 2, 3],
            [4, 5, 6],
        ]);

        // The batch is submitted as one result. The validator accepts several stops at once.
        completeTask(server, sectionIds[0] ?? 0, {
            stops: [1, 2, 3].flatMap((planIndex) => sectionFor(planIndex).stops),
        });
        completeTask(server, sectionIds[1] ?? 0, {
            stops: [4, 5, 6].flatMap((planIndex) => sectionFor(planIndex).stops),
        });

        const route = (await readRoute(server)).route;
        expect(route.phase).toBe('ready');
        expect(route.snapshot?.stops).toEqual(mediumReadySnapshot().stops);
    });

    it('a small PR gets no route task and the endpoint says why', async () => {
        const server = await startWithWorker(SMALL_PR);

        expect(routeTasks(server, 'route.skeleton')).toHaveLength(0);
        const route = (await readRoute(server)).route;
        expect(route.smallPr).toBe(true);
        expect(route.phase).toBe('none');

        const response = await postJson(server.port, UI_ENDPOINTS.reviewRouteGenerate, {}, server.token);
        expect(uiRouteGenerateResponseSchema.parse(await response.json()).outcome).toBe('small_pr');
        expect(routeTasks(server, 'route.skeleton')).toHaveLength(0);
    });

    describe('generate endpoint', () => {
        async function generate(server: SherpaServer): Promise<string> {
            const response = await postJson(server.port, UI_ENDPOINTS.reviewRouteGenerate, {}, server.token);
            expect(response.status).toBe(200);
            return uiRouteGenerateResponseSchema.parse(await response.json()).outcome;
        }

        it('starts generation from phase none even without a live agent', async () => {
            const server = await start();

            expect(await generate(server)).toBe('started');
            expect(routeTasks(server, 'route.skeleton')).toHaveLength(1);
            expect((await readRoute(server)).route.phase).toBe('reading');
        });

        it('returns already_running from filling, without duplicates', async () => {
            const server = await startWithWorker();
            completeTask(server, routeTasks(server, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);

            expect(await generate(server)).toBe('already_running');
            expect(routeTasks(server, 'route.skeleton')).toHaveLength(1);
        });

        it('returns started from phase failed, clearing the previous failure and enqueuing the task again', async () => {
            const server = await startWithWorker();
            const skeletonId = routeTasks(server, 'route.skeleton')[0] ?? 0;
            const broken = asRawText(mediumRawResults().broken.skeletonTourOrderNotPermutation);
            completeTask(server, skeletonId, broken);
            server.queue.complete(WORKER, skeletonId, broken);
            server.queue.complete(WORKER, skeletonId, broken);
            expect((await readRoute(server)).route.phase).toBe('failed');

            expect(await generate(server)).toBe('started');

            const route = (await readRoute(server)).route;
            expect(route.phase).toBe('reading');
            expect(route.failure).toBeNull();
            expect(routeTasks(server, 'route.skeleton')).toHaveLength(2);
        });

        it('a new generation clears stop progress but preserves file marks', async () => {
            const server = await start();
            await postJson(
                server.port,
                UI_ENDPOINTS.reviewStopViewed,
                { stopId: 's01', viewed: true, ranges: [{ fileId: 'file-1', side: 'new', start: 3, end: 7 }] },
                server.token,
            );
            await postJson(
                server.port,
                UI_ENDPOINTS.reviewFileViewed,
                { fileId: 'file-2', viewed: true },
                server.token,
            );

            expect(await generate(server)).toBe('started');

            const progress = uiReviewProgressResponseSchema.parse(
                await (await get(server.port, UI_ENDPOINTS.reviewProgress, server.token)).json(),
            );
            expect(progress.stops).toEqual([]);
            expect(progress.files).toEqual([{ fileId: 'file-2', viewed: true, seenRanges: [] }]);
        });

        it('returns no_review_host without a review host while route state stays readable', async () => {
            const server = await start('github-777');

            const response = await postJson(server.port, UI_ENDPOINTS.reviewRouteGenerate, {}, server.token);
            expect(response.status).toBe(404);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('no_review_host');
            expect((await readRoute(server)).route.phase).toBe('none');
        });
    });

    it('cancels an unbound route task and leaves unrelated queue tasks alone', async () => {
        const server = await startWithWorker();
        const skeletonId = routeTasks(server, 'route.skeleton')[0] ?? 0;

        // Orphan: the previous process died between enqueuing the task and recording its binding.
        const orphan = server.queue.enqueue({
            type: 'route.section',
            priority: 'background',
            instructions: 'section without a binding',
            contextFiles: [],
        });
        const echo = server.queue.enqueue({
            type: 'echo',
            priority: 'interactive',
            instructions: 'summarize the diff',
            contextFiles: [],
        });

        expect(server.queue.getTask(orphan.id)?.status).toBe('cancelled');
        expect(server.route.stopsOfTask(orphan.id)).toBeNull();
        expect(server.queue.getTask(echo.id)?.status).toBe('queued');
        // The agent gets a live task, not the orphan: interactive work goes before background work.
        expect(server.queue.next(WORKER)?.task.id).toBe(echo.id);
        server.queue.complete(WORKER, echo.id, 'summarized');
        expect(server.queue.next(WORKER)?.task.id).toBe(skeletonId);
    });

    it('does not re-enqueue forever when applying an accepted plan fails', async () => {
        const server = await startWithWorker();
        const raw = asRawText(mediumRawResults().skeleton);

        // The task is closed without the server: this simulates acceptance whose application never reached
        // the snapshot (a failed write, or process death between commit and effect).
        for (let attempt = 1; attempt <= MAX_SKELETON_TASKS; attempt += 1) {
            const skeletons = routeTasks(server, 'route.skeleton');
            expect(skeletons).toHaveLength(attempt);
            closeTaskBehindServer(sherpaDir, MEDIUM_PR, skeletons.at(-1) ?? 0, raw);
            pokeQueue(server);
        }

        expect(routeTasks(server, 'route.skeleton')).toHaveLength(MAX_SKELETON_TASKS);
        const route = (await readRoute(server)).route;
        expect(route.phase).toBe('failed');
        expect(route.failure?.message).toContain('не смог применить');
        expect(route.failure?.rawOutput).toBe(raw);
    });

    it('acceptance rejection with an unloaded diff spends no budget and leaves the task alive', async () => {
        const first = await startWithWorker();
        const skeletonId = routeTasks(first, 'route.skeleton')[0] ?? 0;
        await first.close();

        // The second server started over the same database, but the host did not provide the diff. Warmup failed,
        // and the agent still holds the task lease from the previous process.
        const broken = makeFixtureHost('medium');
        broken.getDiff = () => Promise.reject(new Error('host is down'));
        const second = await startServer({
            prKey: MEDIUM_PR,
            sherpaDir,
            longPollSeconds: 0.3,
            reviewHostFactory: () => ({ name: 'fixture', host: broken }),
        });
        servers.push(second);
        second.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await second.route.warmup();

        const raw = asRawText(mediumRawResults().skeleton);
        expect(second.queue.next(WORKER)?.task.id).toBe(skeletonId);
        for (let attempt = 0; attempt <= MAX_RESULT_REJECTIONS; attempt += 1) {
            const response = second.queue.complete(WORKER, skeletonId, raw);
            expect(response.kind).toBe('rejected');
            expect(response.kind === 'rejected' && response.errors.join(' ')).toContain('has not loaded the diff');
        }

        expect(second.queue.getTask(skeletonId)).toMatchObject({ status: 'leased', attempt: 1 });
        expect((await readRoute(second)).route.phase).toBe('reading');
    });

    describe('server restart during generation', () => {
        it('tasks survive a restart without duplicates', async () => {
            const first = await startWithWorker();
            completeTask(first, routeTasks(first, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);
            const before = routeTasks(first, 'route.section');
            await first.close();

            const second = await startWithWorker();

            expect(routeTasks(second, 'route.section')).toEqual(before);
            const route = (await readRoute(second)).route;
            expect(route.phase).toBe('filling');
            expect(route.snapshot?.stops[0]?.status).toBe('queued');
        });

        it('enqueuing a missing section preserves payloads of tasks that survived a restart', async () => {
            const first = await startWithWorker();
            completeTask(first, routeTasks(first, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);
            const before = routeTasks(first, 'route.section');
            const survivor = first.queue.getTask(before[0] ?? 0);
            await first.close();
            // The server died halfway through enqueuing the batch: some sections were left without a task.
            dropTask(sherpaDir, MEDIUM_PR, before.at(-1) ?? 0);

            const second = await startWithWorker();

            expect(routeTasks(second, 'route.section')).toHaveLength(before.length);
            for (const file of survivor?.contextFiles ?? []) {
                expect(fsSync.existsSync(file)).toBe(true);
            }
            expectPayloadOnDisk(
                second.queue.getTask(routeTasks(second, 'route.section').at(-1) ?? 0),
                payloadDirOf(sherpaDir, MEDIUM_PR),
            );
        });

        it('re-enqueues a phase that has lost its tasks', async () => {
            const first = await startWithWorker();
            expect(routeTasks(first, 'route.skeleton')).toHaveLength(1);
            await first.close();
            // The server died between acceptance and the write: the tasks are gone, but the phase remains.
            dropTasks(sherpaDir, MEDIUM_PR);

            const second = await startWithWorker();

            expect(routeTasks(second, 'route.skeleton')).toHaveLength(1);
            expect((await readRoute(second)).route.phase).toBe('reading');
        });
    });

    it('SSE sends a route event immediately and on every route change', async () => {
        const server = await start();
        const stream = await openSse(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
        );
        streams.push(stream);

        const first = uiRouteEventSchema.parse(JSON.parse((await nextRoute(stream)).data));

        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await server.route.warmup();

        const afterStart = uiRouteEventSchema.parse(JSON.parse((await nextRoute(stream)).data));
        expect(afterStart.routeRevision).toBeGreaterThan(first.routeRevision);
        expect(afterStart.routeRevision).toBe((await readRoute(server)).routeRevision);
    });
});

describe('snapshot content hash', () => {
    it('depends on contents and ignores bookkeeping fields', () => {
        const snapshot = mediumReadySnapshot();
        const sameContent = {
            ...snapshot,
            snapshotId: 'another-id',
            createdAt: '2030-01-01T00:00:00.000Z',
            provenance: { harness: 'codex', model: null },
            contentHash: 'anything',
        };
        expect(contentHashOf(sameContent)).toBe(contentHashOf(snapshot));

        const edited = {
            ...snapshot,
            stops: snapshot.stops.map((stop, index) =>
                index === 0 ? { ...stop, paragraph: 'paragraph rewritten' } : stop,
            ),
        };
        expect(contentHashOf(edited)).not.toBe(contentHashOf(snapshot));
    });
});

/** Deletes tasks without the server to test recovery of a phase that has lost its tasks. */
function dropTasks(sherpaDir: string, prKey: string): void {
    const db = new DatabaseSync(databasePathFor(sherpaDir, prKey));
    try {
        db.exec('DELETE FROM route_tasks; DELETE FROM tasks;');
    } finally {
        db.close();
    }
}

/** Deletes one task without the server to simulate death halfway through enqueuing a batch. */
function dropTask(sherpaDir: string, prKey: string, taskId: number): void {
    const db = new DatabaseSync(databasePathFor(sherpaDir, prKey));
    try {
        db.exec(`DELETE FROM route_tasks WHERE task_id = ${String(taskId)};`);
        db.exec(`DELETE FROM tasks WHERE id = ${String(taskId)};`);
    } finally {
        db.close();
    }
}

/** Closes a task outside the queue: the server sees "result accepted" but has not applied it yet. */
function closeTaskBehindServer(sherpaDir: string, prKey: string, taskId: number, result: string): void {
    const db = new DatabaseSync(databasePathFor(sherpaDir, prKey));
    try {
        db.prepare(
            `UPDATE tasks SET status = 'done', worker_id = NULL, lease_expires_at = NULL, result = ?
             WHERE id = ?`,
        ).run(result, taskId);
    } finally {
        db.close();
    }
}

/** A queue change that wakes route reconciliation: otherwise it would not notice edits made without the server. */
function pokeQueue(server: SherpaServer): void {
    server.queue.cancel(
        server.queue.enqueue({
            type: 'echo',
            priority: 'interactive',
            instructions: 'wake up reconciliation',
            contextFiles: [],
        }).id,
    );
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

/** Task payload is on disk: context and schema are in this PR's generation directory. */
function expectPayloadOnDisk(task: TaskRecord | null, payloadDir: string): void {
    expect(task?.contextFiles.length).toBeGreaterThan(0);
    for (const file of task?.contextFiles ?? []) {
        expect(file.startsWith(payloadDir)).toBe(true);
        expect(fsSync.readFileSync(file, 'utf8').length).toBeGreaterThan(0);
    }
    expect(task?.resultSchemaFile).toBeDefined();
    expect(JSON.parse(fsSync.readFileSync(task?.resultSchemaFile ?? '', 'utf8'))).toMatchObject({ type: 'object' });
}
