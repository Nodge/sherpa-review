import http from 'node:http';

import type { Iteration, RouteSnapshot, RpcError, UiRouteState } from '@sherpa/protocol';
import {
    rpcErrorSchema,
    UI_ENDPOINTS,
    uiReviewRouteResponseSchema,
    uiReviewSnapshotsResponseSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRequestListener } from './http.js';
import type { IterationFeed } from './iteration-feed.js';
import { mediumReadySnapshot } from './route/fixture-support.js';
import type { RouteOrchestrator } from './route-orchestrator.js';
import { createRouteRoutes } from './route-routes.js';
import type { RouteStore } from './route-store.js';
import { get, postJson, postRaw } from './test-support.js';

/**
 * Route endpoints at handler level, with stubbed store and orchestrator. Checks what
 * each endpoint computes itself: snapshot statuses, composite revision and request body validation.
 */

const TOKEN = 'route-routes-token';

/** Snapshot with its id and iteration replaced. Everything else comes from an existing fixture. */
function snapshotOf(snapshotId: string, diffId: string, createdAt: string): RouteSnapshot {
    return { ...mediumReadySnapshot(), snapshotId, diffId, createdAt, previousSnapshotId: null };
}

function iterationOf(diffId: string, status: Iteration['status']): Iteration {
    return {
        diffId,
        baseCommit: 'base',
        headCommit: `head-${diffId}`,
        createdAt: '2026-09-01T10:00:00.000Z',
        status,
    };
}

interface Stubs {
    readonly state: UiRouteState;
    readonly snapshots: RouteSnapshot[];
    readonly current: RouteSnapshot | null;
    readonly revision: number;
    readonly feed: IterationFeed | null;
}

describe('route endpoints', () => {
    let server: http.Server | null;
    let port: number;
    let generate: ReturnType<typeof vi.fn>;
    let fillStop: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        server = null;
        generate = vi.fn(() => Promise.resolve('started'));
        fillStop = vi.fn(() => Promise.resolve('started'));
    });

    afterEach(async () => {
        const handle = server;
        server = null;
        if (handle !== null) {
            handle.closeAllConnections();
            await new Promise<void>((resolve) => {
                handle.close(() => {
                    resolve();
                });
            });
        }
    });

    async function start(stubs: Partial<Stubs> = {}): Promise<void> {
        const snapshots = stubs.snapshots ?? [];
        const current = stubs.current ?? null;
        const state: UiRouteState = stubs.state ?? {
            phase: current === null ? 'none' : 'ready',
            smallPr: false,
            snapshot: current,
            failure: null,
            stale: null,
        };
        const store = {
            revision: stubs.revision ?? 0,
            read: () => state,
            current: () => current,
            listSnapshots: () => snapshots,
            getSnapshot: (id: string) => snapshots.find((snapshot) => snapshot.snapshotId === id) ?? null,
        } as unknown as RouteStore;
        const routes = createRouteRoutes({
            store,
            orchestrator: { generate, fillStop } as unknown as RouteOrchestrator,
            iterationFeed: stubs.feed ?? null,
        });

        const listener = http.createServer(createRequestListener({ token: TOKEN, routes }));
        await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
        const address = listener.address();
        if (address === null || typeof address === 'string') {
            throw new Error('test server is not listening on a TCP port');
        }
        server = listener;
        port = address.port;
    }

    async function errorOf(response: Response): Promise<RpcError['error']> {
        return rpcErrorSchema.parse(await response.json()).error;
    }

    it('without an iteration feed, marks every snapshot except the current one stale', async () => {
        const past = snapshotOf('snap-1', 'iter-1', '2026-09-01T10:00:00.000Z');
        const live = snapshotOf('snap-2', 'iter-2', '2026-09-01T11:00:00.000Z');
        await start({ snapshots: [past, live], current: live });

        const response = await get(port, UI_ENDPOINTS.reviewSnapshots, TOKEN);

        expect(response.status).toBe(200);
        const body = uiReviewSnapshotsResponseSchema.parse(await response.json());
        // The iteration list is empty, so we cannot say "the commit is gone". "Stale" is more accurate.
        expect(body.snapshots.map((snapshot) => [snapshot.snapshotId, snapshot.status])).toEqual([
            ['snap-1', 'stale'],
            ['snap-2', 'current'],
        ]);
    });

    it('without a feed, the route revision equals the store revision', async () => {
        await start({ revision: 17 });

        const response = await get(port, UI_ENDPOINTS.reviewRoute, TOKEN);

        expect(uiReviewRouteResponseSchema.parse(await response.json()).routeRevision).toBe(17);
    });

    it('marks a snapshot gone when its iteration has left the PR', async () => {
        const gone = snapshotOf('snap-1', 'iter-gone', '2026-09-01T10:00:00.000Z');
        const stale = snapshotOf('snap-2', 'iter-old', '2026-09-01T11:00:00.000Z');
        const live = snapshotOf('snap-3', 'iter-live', '2026-09-01T12:00:00.000Z');
        const feed = {
            iterations: () => [iterationOf('iter-old', 'previous'), iterationOf('iter-live', 'active')],
            staleFor: () => null,
            revision: 0,
        } as unknown as IterationFeed;
        await start({ snapshots: [gone, stale, live], current: live, feed });

        const response = await get(port, UI_ENDPOINTS.reviewSnapshots, TOKEN);

        const body = uiReviewSnapshotsResponseSchema.parse(await response.json());
        expect(body.snapshots.map((snapshot) => snapshot.status)).toEqual(['gone', 'stale', 'current']);
    });

    it('marks a snapshot gone when its iteration is declared gone', async () => {
        const past = snapshotOf('snap-1', 'iter-1', '2026-09-01T10:00:00.000Z');
        const live = snapshotOf('snap-2', 'iter-2', '2026-09-01T11:00:00.000Z');
        const feed = {
            iterations: () => [iterationOf('iter-1', 'gone'), iterationOf('iter-2', 'active')],
            staleFor: () => null,
            revision: 0,
        } as unknown as IterationFeed;
        await start({ snapshots: [past, live], current: live, feed });

        const body = uiReviewSnapshotsResponseSchema.parse(
            await (await get(port, UI_ENDPOINTS.reviewSnapshots, TOKEN)).json(),
        );

        expect(body.snapshots.map((snapshot) => snapshot.status)).toEqual(['gone', 'current']);
    });

    it('a past snapshot is always ready without a failure, even when the live phase is failed', async () => {
        const past = snapshotOf('snap-1', 'iter-1', '2026-09-01T10:00:00.000Z');
        const live = snapshotOf('snap-2', 'iter-2', '2026-09-01T11:00:00.000Z');
        await start({
            snapshots: [past, live],
            current: live,
            state: {
                phase: 'failed',
                smallPr: true,
                snapshot: live,
                failure: { message: 'the model did not submit a skeleton', rawOutput: null },
                stale: null,
            },
        });

        const response = await get(port, `${UI_ENDPOINTS.reviewRoute}?snapshot=snap-1`, TOKEN);

        const body = uiReviewRouteResponseSchema.parse(await response.json());
        expect(body.route.snapshot?.snapshotId).toBe('snap-1');
        expect(body.route.phase).toBe('ready');
        expect(body.route.smallPr).toBe(false);
        expect(body.route.failure).toBeNull();
    });

    it('an unknown snapshot in the query returns bad_request', async () => {
        await start({ snapshots: [], current: null });

        const response = await get(port, `${UI_ENDPOINTS.reviewRoute}?snapshot=snap-missing`, TOKEN);

        expect(response.status).toBe(400);
        expect((await errorOf(response)).code).toBe('bad_request');
    });

    it('a malformed fill-stop body does not reach the orchestrator', async () => {
        await start();

        const response = await postJson(
            port,
            UI_ENDPOINTS.reviewRouteFillStop,
            { snapshotId: 'snap-1', planIndex: 0 },
            TOKEN,
        );

        expect(response.status).toBe(400);
        const error = await errorOf(response);
        expect(error.code).toBe('bad_request');
        expect(error.details?.[0]).toContain('planIndex: ');
        expect(fillStop).not.toHaveBeenCalled();
    });

    it('malformed JSON on either POST endpoint returns bad_request', async () => {
        await start();

        const generateResponse = await postRaw(port, UI_ENDPOINTS.reviewRouteGenerate, '{"locale": ', TOKEN);
        const fillResponse = await postRaw(port, UI_ENDPOINTS.reviewRouteFillStop, 'not json at all', TOKEN);

        expect(generateResponse.status).toBe(400);
        expect((await errorOf(generateResponse)).code).toBe('bad_request');
        expect(fillResponse.status).toBe(400);
        expect((await errorOf(fillResponse)).code).toBe('bad_request');
        expect(generate).not.toHaveBeenCalled();
        expect(fillStop).not.toHaveBeenCalled();
    });
});
