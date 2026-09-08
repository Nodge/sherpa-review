import fsSync from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { makeFixtureHost } from '@sherpa/fixtures';
import type { PrDiff, RouteSectionResult, TaskCompleteResponse, UiReviewRouteResponse, UiState } from '@sherpa/protocol';
import {
    LEASE_TTL_SECONDS,
    rpcErrorSchema,
    UI_ENDPOINTS,
    UI_ROUTE_EVENT,
    uiReviewProgressResponseSchema,
    uiReviewRouteResponseSchema,
    uiRouteEventSchema,
    uiRouteFillStopResponseSchema,
    uiRouteGenerateResponseSchema,
    uiStateSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { databasePathFor, routePayloadDirOf, sharedPayloadDirOf } from './paths.js';
import type { TaskRecord } from './queue.js';
import { MAX_RESULT_REJECTIONS } from './queue.js';
import { requiredSeenRanges } from './progress-store.js';
import { DEFAULT_ROUTE_CONFIG, isSmallPr, MAX_SKELETON_TASKS } from './route-orchestrator.js';
import { contentHashOf } from './route-store.js';
import {
    asRawText,
    mediumDiff,
    mediumRawResults,
    mediumRawResultsEn,
    mediumReadySnapshot,
} from './route/fixture-support.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, makeTempSherpaDir, postJson, postRaw, removeTempSherpaDir } from './test-support.js';

/**
 * Route orchestration on the fixture host: automatic enqueuing, result acceptance
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

    /** A server over the same database, but the host is on the next iteration: a push happened while it was down. */
    async function startWithPushedHost(host: ReturnType<typeof makeFixtureHost>): Promise<SherpaServer> {
        const server = await startServer({
            prKey: MEDIUM_PR,
            sherpaDir,
            longPollSeconds: 0.3,
            reviewHostFactory: () => ({ name: 'fixture', host }),
        });
        servers.push(server);
        server.workerRegistry.register(WORKER, 'claude-code', 'opus-5');
        await server.route.warmup();
        return server;
    }

    async function readRoute(server: SherpaServer): Promise<UiReviewRouteResponse> {
        const response = await get(server.port, UI_ENDPOINTS.reviewRoute, server.token);
        expect(response.status).toBe(200);
        return uiReviewRouteResponseSchema.parse(await response.json());
    }

    async function readState(server: SherpaServer): Promise<UiState> {
        const response = await get(server.port, UI_ENDPOINTS.state, server.token);
        expect(response.status).toBe(200);
        return uiStateSchema.parse(await response.json());
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

    /** Bring the current generation to ready through the normal worker loop. */
    async function completeRoute(server: SherpaServer): Promise<void> {
        completeTask(server, routeTasks(server, 'route.skeleton').at(-1) ?? 0, mediumRawResults().skeleton);
        for (const [position, taskId] of routeTasks(server, 'route.section').entries()) {
            completeTask(server, taskId, sectionFor(position + 1));
        }
        expect((await readRoute(server)).route.phase).toBe('ready');
    }

    /** The same for a rebuild: submits only waiting tasks, leaving those completed in the previous pass untouched. */
    async function completeGeneration(server: SherpaServer, options: { ready?: boolean } = {}): Promise<void> {
        const queued = (type: 'route.skeleton' | 'route.section'): number[] =>
            server.queue
                .listTasks()
                .filter((task) => task.type === type && task.status === 'queued')
                .map((task) => task.id);
        const skeleton = queued('route.skeleton').at(-1);
        if (skeleton !== undefined) {
            completeTask(server, skeleton, mediumRawResults().skeleton);
        }
        for (const [position, taskId] of queued('route.section').entries()) {
            completeTask(server, taskId, sectionFor(position + 1));
        }
        if (options.ready !== false) {
            expect((await readRoute(server)).route.phase).toBe('ready');
        }
    }

    /** Ready route with one failed slot, the initial state for the fill-stop endpoint. */
    async function completeRouteWithFailedFirstStop(server: SherpaServer): Promise<void> {
        completeTask(server, routeTasks(server, 'route.skeleton').at(-1) ?? 0, mediumRawResults().skeleton);
        const sections = routeTasks(server, 'route.section');
        const failedTaskId = sections[0] ?? 0;
        expect(server.queue.next(WORKER)?.task.id).toBe(failedTaskId);
        server.queue.fail(WORKER, failedTaskId, 'the agent stopped early');
        for (const [position, taskId] of sections.entries()) {
            if (taskId !== failedTaskId) {
                completeTask(server, taskId, sectionFor(position + 1));
            }
        }
        const route = (await readRoute(server)).route;
        expect(route.phase).toBe('ready');
        expect(route.snapshot?.stops[0]?.status).toBe('failed');
    }

    async function readProgress(server: SherpaServer, query = '') {
        return uiReviewProgressResponseSchema.parse(
            await (await get(server.port, `${UI_ENDPOINTS.reviewProgress}${query}`, server.token)).json(),
        );
    }

    async function markStop(server: SherpaServer, stopId = 's01', fileId = 'file-1'): Promise<void> {
        const snapshotId = (await readRoute(server)).route.snapshot?.snapshotId;
        if (snapshotId === undefined) {
            throw new Error('a stop mark requires a route snapshot');
        }
        await postJson(
            server.port,
            UI_ENDPOINTS.reviewStopViewed,
            {
                snapshotId,
                stopId,
                viewed: true,
                ranges: [{ fileId, side: 'new', start: 3, end: 7 }],
            },
            server.token,
        );
    }

    /**
     * A stop mark with the ranges the UI would compute: carryover to a new snapshot
     * treats it as viewed only when all changed lines of its anchors are covered.
     */
    async function markStopCovering(server: SherpaServer, stopId: string): Promise<void> {
        const route = (await readRoute(server)).route;
        const stop = route.snapshot?.stops.find((candidate) => candidate.id === stopId);
        if (route.snapshot === null || stop === undefined) {
            throw new Error(`snapshot has no stop ${stopId}`);
        }
        await postJson(
            server.port,
            UI_ENDPOINTS.reviewStopViewed,
            {
                snapshotId: route.snapshot.snapshotId,
                stopId,
                viewed: true,
                ranges: requiredSeenRanges(stop.anchors, mediumDiff()),
            },
            server.token,
        );
    }

    async function fillStop(server: SherpaServer, snapshotId: string, planIndex: number): Promise<string> {
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.reviewRouteFillStop,
            { snapshotId, planIndex },
            server.token,
        );
        expect(response.status).toBe(200);
        return uiRouteFillStopResponseSchema.parse(await response.json()).outcome;
    }

    it('warmup enqueues a skeleton when an agent is connected, the PR exceeds the threshold and there is no route', async () => {
        const server = await startWithWorker();

        expect(routeTasks(server, 'route.skeleton')).toHaveLength(1);
        const route = await readRoute(server);
        expect(route.route.phase).toBe('reading');
        expect(route.route.smallPr).toBe(false);
        expect(route.routeRevision).toBeGreaterThan(0);
    });

    it('generation cap reaches UI state and survives a database reread', async () => {
        const server = await startWithWorker();
        expect((await readState(server)).generationCap).toBeNull();

        completeTask(server, routeTasks(server, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);

        // The whole `medium` diff fits the budget: nothing was truncated, and the cap records that too.
        const cap = { filesCovered: mediumDiff().files.length, filesTotal: mediumDiff().files.length, machineFiles: 0, truncated: false };
        expect((await readState(server)).generationCap).toEqual(cap);

        // Restart over the same database: the cap lives in `meta`, not process memory.
        await server.close();
        const restarted = await start();
        expect((await readState(restarted)).generationCap).toEqual(cap);
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
        expect(ready.snapshot?.provenance).toEqual({ harness: 'claude-code', model: 'opus-5', locale: 'ru' });
        expect(ready.snapshot?.commit).toBe(mediumReadySnapshot().commit);
    });

    it('task payloads are on disk with context and schema present when issued', async () => {
        const server = await startWithWorker();
        const payloadDir = routePayloadDirOf(sherpaDir, MEDIUM_PR);
        const sharedDir = sharedPayloadDirOf(sherpaDir, MEDIUM_PR);

        const skeleton = server.queue.getTask(routeTasks(server, 'route.skeleton')[0] ?? 0);
        expectPayloadOnDisk(skeleton, payloadDir, sharedDir);

        completeTask(server, skeleton?.id ?? 0, mediumRawResults().skeleton);
        const section = server.queue.getTask(routeTasks(server, 'route.section')[0] ?? 0);
        expectPayloadOnDisk(section, payloadDir, sharedDir);
        // The skeleton and sections share the same diff path, not a copy per task.
        expect(section?.contextFiles[1]).toBe(skeleton?.contextFiles[1]);
        expect(fsSync.readFileSync(section?.contextFiles[2] ?? '', 'utf8')).not.toContain('## Patches');
        // Both tasks belong to one generation and live in the same subdirectory.
        expect(fsSync.readdirSync(payloadDir)).toHaveLength(1);
    });

    it('restarting generation removes the previous payload', async () => {
        const server = await startWithWorker();
        const payloadDir = routePayloadDirOf(sherpaDir, MEDIUM_PR);
        const sharedDir = sharedPayloadDirOf(sherpaDir, MEDIUM_PR);
        const before = server.queue.getTask(routeTasks(server, 'route.skeleton')[0] ?? 0);

        // Failure and a new generation: nobody needs the old files anymore.
        server.queue.next(WORKER);
        server.queue.fail(WORKER, before?.id ?? 0, 'could not complete');
        expect((await readRoute(server)).route.phase).toBe('failed');
        expect(await server.route.generate()).toBe('started');

        // The previous generation directory is gone. The key's shared diff survives it, since the generation does not own it.
        expect(fsSync.existsSync(before?.resultSchemaFile ?? '')).toBe(false);
        expect(fsSync.existsSync(before?.contextFiles[1] ?? '')).toBe(true);
        expect(fsSync.readdirSync(payloadDir)).toHaveLength(1);
        expectPayloadOnDisk(
            server.queue.getTask(routeTasks(server, 'route.skeleton').at(-1) ?? 0),
            payloadDir,
            sharedDir,
        );
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
        // Filled content stays readable: the stop submitted before the agent died is still there
        // (docs/design/SPEC-elements.md §4.4).
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

    // The threshold measures only the size of the change: counting files would leave a lone 500-line file
    // (an RFC in the docs) without a route.
    it('the route threshold counts lines, not files', () => {
        const diffOf = (changes: readonly [additions: number, deletions: number][]): PrDiff => ({
            diffId: 'd1',
            baseCommit: 'base',
            headCommit: 'head',
            files: changes.map(([additions, deletions], index) => ({
                fileId: `f${String(index)}`,
                path: `file-${String(index)}.md`,
                oldPath: null,
                changeType: 'add',
                binary: false,
                generated: false,
                additions,
                deletions,
                patch: null,
                viewed: null,
                blameUrl: null,
                hostFileUrl: null,
                image: null,
            })),
        });

        expect(isSmallPr(diffOf([[548, 0]]), DEFAULT_ROUTE_CONFIG)).toBe(false);
        expect(isSmallPr(diffOf([[7, 1]]), DEFAULT_ROUTE_CONFIG)).toBe(true);
        expect(isSmallPr(diffOf([[40, 0]]), DEFAULT_ROUTE_CONFIG)).toBe(true);
        expect(
            isSmallPr(
                diffOf([
                    [20, 0],
                    [25, 0],
                ]),
                DEFAULT_ROUTE_CONFIG,
            ),
        ).toBe(false);
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

        it('returns already_running from phases reading/filling without duplicates', async () => {
            const server = await startWithWorker();

            expect(await generate(server)).toBe('already_running');
            expect(routeTasks(server, 'route.skeleton')).toHaveLength(1);

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

        it('starts a new skeleton from ready, leaving the old snapshot and progress readable', async () => {
            const server = await startWithWorker();
            await completeRoute(server);
            await markStop(server);
            const before = (await readRoute(server)).route.snapshot;

            expect(await generate(server)).toBe('started');

            const rebuilding = (await readRoute(server)).route;
            expect(rebuilding.phase).toBe('reading');
            expect(rebuilding.snapshot).toEqual(before);
            expect(rebuilding.failure).toBeNull();
            expect((await readProgress(server)).stops).toEqual([{ stopId: 's01', viewed: true }]);
            expect(routeTasks(server, 'route.skeleton')).toHaveLength(2);
        });

        it('cancelling a rebuild returns to ready with the old snapshot and progress', async () => {
            const server = await startWithWorker();
            await completeRoute(server);
            await markStop(server);
            const before = (await readRoute(server)).route.snapshot;

            expect(await generate(server)).toBe('started');
            server.queue.cancel(routeTasks(server, 'route.skeleton').at(-1) ?? 0);

            const restored = (await readRoute(server)).route;
            expect(restored.phase).toBe('ready');
            expect(restored.snapshot).toEqual(before);
            expect(restored.failure).toBeNull();
            expect((await readProgress(server)).stops).toEqual([{ stopId: 's01', viewed: true }]);
        });

        it('a rebuild skeleton failure preserves the old snapshot and progress', async () => {
            const server = await startWithWorker();
            await completeRoute(server);
            await markStop(server);
            const before = (await readRoute(server)).route.snapshot;

            expect(await generate(server)).toBe('started');
            const skeletonId = routeTasks(server, 'route.skeleton').at(-1) ?? 0;
            expect(server.queue.next(WORKER)?.task.id).toBe(skeletonId);
            server.queue.fail(WORKER, skeletonId, 'could not rebuild');

            const failed = (await readRoute(server)).route;
            expect(failed.phase).toBe('failed');
            expect(failed.snapshot).toEqual(before);
            expect(failed.failure?.message).toContain('could not rebuild');
            expect((await readProgress(server)).stops).toEqual([{ stopId: 's01', viewed: true }]);
        });

        it('new snapshot marks arrive through carryover, not with the plan', async () => {
            const server = await startWithWorker();
            await completeRoute(server);
            await markStopCovering(server, 's01');
            const before = (await readRoute(server)).route.snapshot;

            expect(await generate(server)).toBe('started');
            expect((await readProgress(server)).stops).toHaveLength(1);

            const skeletonId = routeTasks(server, 'route.skeleton').at(-1) ?? 0;
            expect(completeTask(server, skeletonId, mediumRawResults().skeleton).kind).toBe('accepted');

            const accepted = (await readRoute(server)).route;
            expect(accepted.phase).toBe('filling');
            expect(accepted.snapshot?.snapshotId).not.toBe(before?.snapshotId);
            // The plan has no anchors yet, so there is nothing to carry over. Marks arrive with filled sections.
            expect((await readProgress(server)).stops).toEqual([]);
            // The plan has no anchors. `carried` appears only on freezing, so the banner has no numbers until then.
            expect(accepted.snapshot?.carried).toBeNull();

            await completeGeneration(server);
            expect((await readProgress(server)).stops).toEqual([{ stopId: 's01', viewed: true }]);
        });

        it('a late mark for the old snapshot does not reach a new stop with the same id', async () => {
            const server = await startWithWorker();
            await completeRoute(server);
            const oldSnapshotId = (await readRoute(server)).route.snapshot?.snapshotId;
            if (oldSnapshotId === undefined) {
                throw new Error('a ready route needs a snapshotId');
            }

            expect(await generate(server)).toBe('started');
            const skeletonId = routeTasks(server, 'route.skeleton').at(-1) ?? 0;
            expect(completeTask(server, skeletonId, mediumRawResults().skeleton).kind).toBe('accepted');

            const activeSnapshotId = (await readRoute(server)).route.snapshot?.snapshotId;
            expect(activeSnapshotId).not.toBe(oldSnapshotId);
            await postJson(
                server.port,
                UI_ENDPOINTS.reviewStopViewed,
                {
                    snapshotId: oldSnapshotId,
                    stopId: 's01',
                    viewed: true,
                    ranges: [{ fileId: 'file-1', side: 'new', start: 3, end: 7 }],
                },
                server.token,
            );

            expect(await readProgress(server)).toMatchObject({ files: [], stops: [] });
        });

        it('a mark carryover failure also rolls back snapshot freezing', async () => {
            const server = await startWithWorker();
            await completeRoute(server);
            await markStopCovering(server, 's01');
            const before = (await readRoute(server)).route.snapshot;
            expect(await generate(server)).toBe('started');

            const db = new DatabaseSync(databasePathFor(sherpaDir, MEDIUM_PR));
            // Mark carryover writes to `stop_progress` inside the snapshot freezing transaction.
            db.exec(`
                CREATE TRIGGER reject_stop_progress_carry
                BEFORE INSERT ON stop_progress
                BEGIN
                    SELECT RAISE(ABORT, 'test rollback');
                END;
            `);
            try {
                await completeGeneration(server, { ready: false });

                const rebuilding = (await readRoute(server)).route;
                // The snapshot is not frozen: the freezing transaction rolled back along with carryover.
                expect(rebuilding.phase).toBe('filling');
                expect(rebuilding.snapshot?.contentHash).toBeNull();
                // Skeleton acceptance has not carried over anything yet: the plan has no anchors.
                expect(rebuilding.snapshot?.carried).toBeNull();
                // The previous snapshot's marks are intact, and no marks for the new one appeared.
                expect(db.prepare('SELECT snapshot_id, stop_id, viewed FROM stop_progress').all()).toEqual([
                    { snapshot_id: before?.snapshotId, stop_id: 's01', viewed: 1 },
                ]);
            } finally {
                db.exec('DROP TRIGGER reject_stop_progress_carry;');
                db.close();
            }
        });

        it('a new generation on the same iteration carries over marks instead of clearing them', async () => {
            const server = await startWithWorker();
            await completeRoute(server);
            await markStopCovering(server, 's01');
            await postJson(
                server.port,
                UI_ENDPOINTS.reviewFileViewed,
                { fileId: 'file-2', viewed: true },
                server.token,
            );

            expect(await generate(server)).toBe('started');
            await completeGeneration(server);

            const route = (await readRoute(server)).route;
            // The denominator counts stops with anchors: carryover cannot cover the synthetic "Other" stop.
            expect(route.snapshot?.stops).toHaveLength(7);
            expect(route.snapshot?.stops.filter((stop) => stop.anchors.length > 0)).toHaveLength(6);
            expect(route.snapshot?.carried).toEqual({ kept: 1, total: 6, zeroReason: null });
            const progress = uiReviewProgressResponseSchema.parse(
                await (await get(server.port, UI_ENDPOINTS.reviewProgress, server.token)).json(),
            );
            expect(progress.stops).toEqual([{ stopId: 's01', viewed: true }]);
            expect(progress.files).toContainEqual({ fileId: 'file-2', viewed: true, seenRanges: [] });
        });

        it('carryover with no marks yields zero and gives "nothing to carry over" as the reason', async () => {
            const server = await startWithWorker();
            await completeRoute(server);

            expect(await generate(server)).toBe('started');
            await completeGeneration(server);

            const route = (await readRoute(server)).route;
            expect(route.snapshot?.carried).toEqual({ kept: 0, total: 6, zeroReason: 'no_marks' });
        });

        it('marks that cover no complete stop do not mean "nothing to carry over"', async () => {
            const server = await startWithWorker();
            await completeRoute(server);
            // Only part of the stop's ranges: the stop does not count as fully viewed.
            await markStop(server, 's01');

            expect(await generate(server)).toBe('started');
            await completeGeneration(server);

            const route = (await readRoute(server)).route;
            // Regeneration uses the same iteration: by construction it has no carried lines,
            // but the reviewer has marks, so the reason is computed from the source iteration.
            expect(route.snapshot?.carried).toEqual({ kept: 0, total: 6, zeroReason: 'no_overlap' });
        });

        it('returns no_review_host without a review host while route state stays readable', async () => {
            const server = await start('github-777');

            const response = await postJson(server.port, UI_ENDPOINTS.reviewRouteGenerate, {}, server.token);
            expect(response.status).toBe(404);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('no_review_host');
            expect((await readRoute(server)).route.phase).toBe('none');
        });
    });

    /**
     * Generation language: fallback order "tab request → settings → agent hint → Russian"
     * and a snapshot written entirely in one language.
     */
    describe('generation language', () => {
        async function generateWith(server: SherpaServer, body: unknown): Promise<string> {
            const response = await postJson(server.port, UI_ENDPOINTS.reviewRouteGenerate, body, server.token);
            expect(response.status).toBe(200);
            return uiRouteGenerateResponseSchema.parse(await response.json()).outcome;
        }

        function skeletonInstructionsOf(server: SherpaServer): string {
            const task = server.queue.listTasks().find((candidate) => candidate.type === 'route.skeleton');
            return task?.instructions ?? '';
        }

        function guideOf(server: SherpaServer, type: 'route.skeleton' | 'route.section'): string {
            const task = server.queue
                .listTasks()
                .filter((candidate) => candidate.type === type && candidate.status !== 'cancelled')
                .at(-1);
            const guide = task?.contextFiles.find((file) => file.includes('-guide-'));
            return guide === undefined ? '' : fsSync.readFileSync(guide, 'utf8');
        }

        it('request locale reaches prompts, provenance and the synthetic stop', async () => {
            // No agent: warmup must not start generation before the endpoint does.
            const server = await start();

            expect(await generateWith(server, { locale: 'en' })).toBe('started');
            expect(skeletonInstructionsOf(server)).toContain('in English');
            expect(guideOf(server, 'route.skeleton')).toContain('**Write in English.**');

            const skeletonId = routeTasks(server, 'route.skeleton').at(-1) ?? 0;
            completeTask(server, skeletonId, mediumRawResultsEn().skeleton);

            const route = (await readRoute(server)).route;
            expect(route.snapshot?.provenance.locale).toBe('en');
            expect(route.snapshot?.stops.at(-1)?.title).toBe('Other — lines the model did not place');
            // Sections continue the skeleton: their guide uses the same language.
            expect(guideOf(server, 'route.section')).toContain('**Write in English.**');
        });

        it('generation locale survives a restart and the skeleton is accepted in its task language', async () => {
            const first = await start();
            expect(await generateWith(first, { locale: 'en' })).toBe('started');
            const skeletonId = routeTasks(first, 'route.skeleton').at(-1) ?? 0;
            await first.close();

            fsSync.writeFileSync(`${sherpaDir}/settings.json`, JSON.stringify({ locale: 'ru' }));
            const second = await start();
            expect(completeTask(second, skeletonId, mediumRawResultsEn().skeleton).kind).toBe('accepted');

            const route = (await readRoute(second)).route;
            expect(route.snapshot?.provenance.locale).toBe('en');
            expect(route.snapshot?.stops.at(-1)?.title).toBe('Other — lines the model did not place');
            expect(guideOf(second, 'route.section')).toContain('**Write in English.**');
        });

        it('uses the explicit settings choice when the request has no locale', async () => {
            fsSync.writeFileSync(`${sherpaDir}/settings.json`, JSON.stringify({ locale: 'en' }));
            const server = await start();

            expect(await generateWith(server, {})).toBe('started');
            expect(skeletonInstructionsOf(server)).toContain('in English');
        });

        it('the `auto` setting leaves the choice to the agent hint', async () => {
            const server = await start();
            server.workerRegistry.register(WORKER, 'claude-code', 'opus-5', 'en');
            // Automatic warmup enqueuing follows the same fallback order: no language was specified for it.
            await server.route.warmup();

            expect(routeTasks(server, 'route.skeleton')).toHaveLength(1);
            expect(skeletonInstructionsOf(server)).toContain('in English');
        });

        it('defaults to English when no language is specified, with an optional request body', async () => {
            const server = await start();

            const response = await postRaw(server.port, UI_ENDPOINTS.reviewRouteGenerate, '', server.token);
            expect(response.status).toBe(200);
            expect(uiRouteGenerateResponseSchema.parse(await response.json()).outcome).toBe('started');
            expect(skeletonInstructionsOf(server)).toContain('in English');
        });

        it('rejects an unsupported locale in the body under the contract', async () => {
            const server = await start();

            const response = await postJson(
                server.port,
                UI_ENDPOINTS.reviewRouteGenerate,
                { locale: 'de' },
                server.token,
            );
            expect(response.status).toBe(400);
            expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('bad_request');
        });
    });

    describe('fill-stop endpoint', () => {
        function openSectionTasks(server: SherpaServer): TaskRecord[] {
            return server.queue
                .listTasks()
                .filter(
                    (task) =>
                        task.type === 'route.section' && (task.status === 'queued' || task.status === 'leased'),
                );
        }

        it('fills a failed stop with one section without changing the snapshot or losing other progress', async () => {
            const server = await startWithWorker();
            await completeRouteWithFailedFirstStop(server);
            await markStop(server, 's02', 'file-2');
            const before = (await readRoute(server)).route.snapshot;
            const snapshotId = before?.snapshotId ?? '';
            const beforeHash = before?.contentHash;

            expect(await fillStop(server, snapshotId, 1)).toBe('started');

            const filling = (await readRoute(server)).route;
            expect(filling.phase).toBe('filling');
            expect(filling.snapshot?.snapshotId).toBe(snapshotId);
            expect(filling.snapshot?.contentHash).toBeNull();
            expect(filling.snapshot?.stops[0]).toMatchObject({ status: 'queued', validationNotes: [] });
            const [section] = openSectionTasks(server);
            expect(openSectionTasks(server)).toHaveLength(1);
            expect(server.route.stopsOfTask(section?.id ?? 0)).toEqual([1]);

            expect(completeTask(server, section?.id ?? 0, sectionFor(1)).kind).toBe('accepted');

            const ready = (await readRoute(server)).route;
            expect(ready.phase).toBe('ready');
            expect(ready.snapshot?.snapshotId).toBe(snapshotId);
            expect(ready.snapshot?.stops[0]).toEqual(mediumReadySnapshot().stops[0]);
            expect(ready.snapshot?.contentHash).toMatch(/^[0-9a-f]{12}$/);
            expect(ready.snapshot?.contentHash).not.toBe(beforeHash);
            expect((await readProgress(server)).stops).toEqual([{ stopId: 's02', viewed: true }]);
        });

        it('fills from the saved iteration patch even when the host is down', async () => {
            const first = await startWithWorker();
            await completeRouteWithFailedFirstStop(first);
            const snapshotId = (await readRoute(first)).route.snapshot?.snapshotId ?? '';
            await first.close();

            const broken = makeFixtureHost('medium');
            broken.getDiff = () => Promise.reject(new Error('host is down'));
            const second = await startServer({
                prKey: MEDIUM_PR,
                sherpaDir,
                longPollSeconds: 0.3,
                reviewHostFactory: () => ({ name: 'fixture', host: broken }),
            });
            servers.push(second);

            const response = await postJson(
                second.port,
                UI_ENDPOINTS.reviewRouteFillStop,
                { snapshotId, planIndex: 1 },
                second.token,
            );

            expect(response.status).toBe(200);
            expect(uiRouteFillStopResponseSchema.parse(await response.json()).outcome).toBe('started');
            expect((await readRoute(second)).route.phase).toBe('filling');
        });

        it('an unavailable diff leaves the route outside filling and the failed stop unchanged', async () => {
            const first = await startWithWorker();
            await completeRouteWithFailedFirstStop(first);
            const before = await readRoute(first);
            const snapshotId = before.route.snapshot?.snapshotId ?? '';
            await first.close();
            // Neither the host nor local storage has the iteration patch, so there is nothing to resolve section anchors against.
            dropIterations(sherpaDir, MEDIUM_PR);

            const broken = makeFixtureHost('medium');
            broken.getDiff = () => Promise.reject(new Error('host is down'));
            const second = await startServer({
                prKey: MEDIUM_PR,
                sherpaDir,
                longPollSeconds: 0.3,
                reviewHostFactory: () => ({ name: 'fixture', host: broken }),
            });
            servers.push(second);
            const beforeFill = await readRoute(second);
            expect(beforeFill.route).toEqual(before.route);

            const response = await postJson(
                second.port,
                UI_ENDPOINTS.reviewRouteFillStop,
                { snapshotId, planIndex: 1 },
                second.token,
            );

            expect(response.status).toBe(502);
            const error = rpcErrorSchema.parse(await response.json());
            expect(error.error.code).toBe('host_unavailable');
            expect(error.error.message).toContain('Host adapter did not return the diff');
            expect(await readRoute(second)).toEqual(beforeFill);
            expect(openSectionTasks(second)).toHaveLength(0);
        });

        it('guards distinguish a busy phase, an old snapshot and an already filled stop', async () => {
            const server = await startWithWorker();
            expect(await fillStop(server, 'another-snapshot', 1)).toBe('already_running');

            completeTask(server, routeTasks(server, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);
            const sections = routeTasks(server, 'route.section');
            const fillingSnapshotId = (await readRoute(server)).route.snapshot?.snapshotId ?? '';
            expect(await fillStop(server, fillingSnapshotId, 1)).toBe('already_running');

            const failedTaskId = sections[0] ?? 0;
            expect(server.queue.next(WORKER)?.task.id).toBe(failedTaskId);
            server.queue.fail(WORKER, failedTaskId, 'the agent stopped early');
            for (const [position, taskId] of sections.entries()) {
                if (taskId !== failedTaskId) {
                    completeTask(server, taskId, sectionFor(position + 1));
                }
            }

            const snapshotId = (await readRoute(server)).route.snapshot?.snapshotId ?? '';
            expect(await fillStop(server, 'old-snapshot', 1)).toBe('stale_snapshot');
            expect(await fillStop(server, snapshotId, 1)).toBe('started');
            expect(await fillStop(server, snapshotId, 1)).toBe('already_running');
            const [refill] = openSectionTasks(server);
            expect(openSectionTasks(server)).toHaveLength(1);

            expect(completeTask(server, refill?.id ?? 0, sectionFor(1)).kind).toBe('accepted');
            expect(await fillStop(server, snapshotId, 1)).toBe('not_unfilled');
            expect(openSectionTasks(server)).toHaveLength(0);
        });

        it('a fill failure restores the failed stop and phase ready in the same snapshot', async () => {
            const server = await startWithWorker();
            await completeRouteWithFailedFirstStop(server);
            const before = (await readRoute(server)).route.snapshot;
            const snapshotId = before?.snapshotId ?? '';

            expect(await fillStop(server, snapshotId, 1)).toBe('started');
            const [section] = openSectionTasks(server);
            expect(server.queue.next(WORKER)?.task.id).toBe(section?.id);
            server.queue.fail(WORKER, section?.id ?? 0, 'refill failed');

            const ready = (await readRoute(server)).route;
            expect(ready.phase).toBe('ready');
            expect(ready.snapshot?.snapshotId).toBe(snapshotId);
            expect(ready.snapshot?.stops[0]?.status).toBe('failed');
            expect(ready.snapshot?.stops[0]?.validationNotes.join(' ')).toContain('refill failed');
            expect(ready.snapshot?.stops.slice(1)).toEqual(before?.stops.slice(1));
        });

        it('full regeneration and filling block each other', async () => {
            const server = await startWithWorker();
            expect((await readRoute(server)).route.phase).toBe('reading');
            expect(await fillStop(server, 'another-snapshot', 1)).toBe('already_running');

            await completeRouteWithFailedFirstStop(server);
            const snapshotId = (await readRoute(server)).route.snapshot?.snapshotId ?? '';
            expect(await fillStop(server, snapshotId, 1)).toBe('started');
            expect(await server.route.generate()).toBe('already_running');
            expect(openSectionTasks(server)).toHaveLength(1);
        });

        it('a restart during filling preserves the task and reconciliation brings the stop to ready', async () => {
            const first = await startWithWorker();
            await completeRouteWithFailedFirstStop(first);
            const snapshotId = (await readRoute(first)).route.snapshot?.snapshotId ?? '';
            expect(await fillStop(first, snapshotId, 1)).toBe('started');
            const taskId = openSectionTasks(first)[0]?.id ?? 0;
            await first.close();

            const second = await startWithWorker();
            expect((await readRoute(second)).route.phase).toBe('filling');
            expect(openSectionTasks(second).map((task) => task.id)).toEqual([taskId]);
            expect(second.route.stopsOfTask(taskId)).toEqual([1]);

            expect(completeTask(second, taskId, sectionFor(1)).kind).toBe('accepted');
            const ready = (await readRoute(second)).route;
            expect(ready.phase).toBe('ready');
            expect(ready.snapshot?.snapshotId).toBe(snapshotId);
            expect(ready.snapshot?.stops[0]?.status).toBe('ready');
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
        // The generation iteration's patch is missing locally too. Otherwise acceptance would need no host.
        dropIterations(sherpaDir, MEDIUM_PR);

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
                routePayloadDirOf(sherpaDir, MEDIUM_PR),
                sharedPayloadDirOf(sherpaDir, MEDIUM_PR),
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

        it('accepts a skeleton against its task iteration after a push while the server was down', async () => {
            const first = await startWithWorker();
            const skeletonId = routeTasks(first, 'route.skeleton')[0] ?? 0;
            await first.close();

            // The author pushed while the server was down: v2 is active, but the plan was read from v1.
            const pushed = makeFixtureHost('medium');
            pushed.advanceIteration();
            const second = await startWithPushedHost(pushed);
            const active = (await pushed.listIterations()).find((iteration) => iteration.status === 'active');

            expect(second.queue.next(WORKER)?.task.id).toBe(skeletonId);
            expect(completeTask(second, skeletonId, mediumRawResults().skeleton).kind).toBe('accepted');

            const route = (await readRoute(second)).route;
            expect(route.snapshot?.diffId).toBe(mediumDiff().diffId);
            expect(route.snapshot?.diffId).not.toBe(active?.diffId);
            // Sections of this snapshot resolve against the same v1. Otherwise acceptance would reject them.
            expect(route.phase).toBe('filling');
        });

        it('a lost route iteration patch stops generation with a reason instead of repeating warmup', async () => {
            const first = await startWithWorker();
            completeTask(first, routeTasks(first, 'route.skeleton')[0] ?? 0, mediumRawResults().skeleton);
            expect((await readRoute(first)).route.phase).toBe('filling');
            await first.close();
            // Section tasks are lost, there are no local patches, and the PR has moved on: there is nothing
            // to build a section from. Repeated warmup cannot help here and must not loop.
            dropTasks(sherpaDir, MEDIUM_PR);
            dropIterations(sherpaDir, MEDIUM_PR);

            const pushed = makeFixtureHost('medium');
            pushed.advanceIteration();
            const second = await startWithPushedHost(pushed);

            const route = (await readRoute(second)).route;
            expect(route.phase).toBe('failed');
            expect(route.failure?.message).toContain('Build the route again');
            expect(routeTasks(second, 'route.section')).toHaveLength(0);
        });

        it('a rebuild survives a restart with the old snapshot and its own task', async () => {
            const first = await startWithWorker();
            await completeRoute(first);
            const before = (await readRoute(first)).route.snapshot;
            expect(await first.route.generate()).toBe('started');
            const skeletons = routeTasks(first, 'route.skeleton');
            await first.close();

            const second = await startWithWorker();
            const rebuilding = (await readRoute(second)).route;

            expect(rebuilding.phase).toBe('reading');
            expect(rebuilding.snapshot).toEqual(before);
            expect(routeTasks(second, 'route.skeleton')).toEqual(skeletons);
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
            provenance: { harness: 'codex', model: null, locale: null },
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

/** Deletes local iteration patches to simulate a diff unavailable from both the host and local storage. */
function dropIterations(sherpaDir: string, prKey: string): void {
    const db = new DatabaseSync(databasePathFor(sherpaDir, prKey));
    try {
        db.exec('DELETE FROM interdiffs; DELETE FROM iterations;');
    } finally {
        db.close();
    }
}

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

/**
 * The task payload is on disk: immutable context at the shared path, task-specific files and schema in this PR's
 * generation directory.
 */
function expectPayloadOnDisk(task: TaskRecord | null, payloadDir: string, sharedDir: string): void {
    expect(task?.contextFiles.length).toBeGreaterThan(0);
    for (const file of task?.contextFiles ?? []) {
        expect(file.startsWith(payloadDir) || file.startsWith(sharedDir)).toBe(true);
        expect(fsSync.readFileSync(file, 'utf8').length).toBeGreaterThan(0);
    }
    // The guide and diff use shared paths. The generation directory holds only its own files.
    expect(task?.contextFiles.filter((file) => file.startsWith(sharedDir))).toHaveLength(2);
    expect(task?.resultSchemaFile).toBeDefined();
    expect(task?.resultSchemaFile?.startsWith(payloadDir)).toBe(true);
    expect(JSON.parse(fsSync.readFileSync(task?.resultSchemaFile ?? '', 'utf8'))).toMatchObject({ type: 'object' });
}
