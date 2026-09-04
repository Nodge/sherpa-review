import type {
    Iteration,
    RouteSnapshot,
    UiRouteFillStopResponse,
    UiRouteGenerateResponse,
    UiReviewRouteResponse,
    UiReviewSnapshotsResponse,
    UiSnapshotStatus,
} from '@sherpa/protocol';
import {
    UI_ENDPOINTS,
    uiReviewRouteRequestSchema,
    uiReviewRouteResponseSchema,
    uiReviewSnapshotsResponseSchema,
    uiRouteFillStopRequestSchema,
    uiRouteFillStopResponseSchema,
    uiRouteGenerateRequestSchema,
    uiRouteGenerateResponseSchema,
} from '@sherpa/protocol';
import type { z } from 'zod';

import { RpcFailure } from './errors.js';
import type { JsonResponse, RequestContext, Route } from './http.js';
import { handlingRpcFailures, readJsonBody, readOptionalJsonBody } from './http.js';
import type { IterationFeed } from './iteration-feed.js';
import { routeRevisionOf, withStale } from './iteration-feed.js';
import { optionalParam, parseQuery, respond } from './review-routes.js';
import type { RouteOrchestrator } from './route-orchestrator.js';
import type { RouteStore } from './route-store.js';

/**
 * Route endpoints for reading state and snapshot history, starting generation and filling
 * a single stop.
 *
 * `GET reviewRoute` and `GET reviewSnapshots` read SQLite and work without a review host (the route
 * simply stays in phase `none` without one). Both POST endpoints load the diff before mutation. Without a
 * host they return `no_review_host`, and on host failure they return `host_unavailable`.
 *
 * `stale` is not stored. It is computed here when reading, using the iteration list
 * (`withStale`), which also makes the UI route revision composite (`routeRevisionOf`).
 */

export interface RouteRoutesOptions {
    readonly store: RouteStore;
    readonly orchestrator: RouteOrchestrator;
    /** PR iterations. null means there is no host, so the snapshot cannot become stale. */
    readonly iterationFeed: IterationFeed | null;
}

export function createRouteRoutes(options: RouteRoutesOptions): Route[] {
    return [
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewRoute,
            handle: handlingRpcFailures(
                (ctx): JsonResponse => {
                    const request = parseQuery(
                        uiReviewRouteRequestSchema,
                        { ...optionalParam(ctx, 'snapshot') },
                        'route',
                    );
                    const body: UiReviewRouteResponse = {
                        route:
                            request.snapshot === undefined
                                ? withStale(options.store.read(), options.iterationFeed)
                                : pastRouteState(options, request.snapshot),
                        routeRevision: routeRevisionOf(options.store, options.iterationFeed),
                    };
                    return respond(uiReviewRouteResponseSchema, body, 'local');
                },
            ),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewSnapshots,
            handle: handlingRpcFailures(
                (): JsonResponse => {
                    const body: UiReviewSnapshotsResponse = { snapshots: summarize(options) };
                    return respond(uiReviewSnapshotsResponseSchema, body, 'local');
                },
            ),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewRouteGenerate,
            handle: handlingRpcFailures(async (ctx) => {
                // The body may be absent: auto-start and pre-M5 clients do not specify a language.
                const request = await readOptionalRouteRequest(ctx, uiRouteGenerateRequestSchema);
                const body: UiRouteGenerateResponse = {
                    outcome: await options.orchestrator.generate(request.locale),
                };
                return respond(uiRouteGenerateResponseSchema, body, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewRouteFillStop,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRouteRequest(ctx, uiRouteFillStopRequestSchema);
                const body: UiRouteFillStopResponse = {
                    outcome: await options.orchestrator.fillStop(request.snapshotId, request.planIndex),
                };
                return respond(uiRouteFillStopResponseSchema, body, 'local');
            }),
        },
    ];
}

/**
 * A past snapshot as route state. It is immutable, so its phase is always `ready`,
 * with no failure or small-PR threshold flag. `stale` is computed for this snapshot too. An old
 * snapshot is almost always stale, and the UI opens it read-only.
 */
function pastRouteState(options: RouteRoutesOptions, snapshotId: string): UiReviewRouteResponse['route'] {
    const snapshot = options.store.getSnapshot(snapshotId);
    if (snapshot === null) {
        throw new RpcFailure('bad_request', `This PR has no route snapshot ${snapshotId}.`);
    }
    return withStale(
        { phase: 'ready', smallPr: false, snapshot, failure: null, stale: null },
        options.iterationFeed,
    );
}

function summarize(options: RouteRoutesOptions): UiReviewSnapshotsResponse['snapshots'] {
    const currentId = options.store.current()?.snapshotId ?? null;
    const iterations = options.iterationFeed?.iterations() ?? [];
    return options.store.listSnapshots().map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        diffId: snapshot.diffId,
        commit: snapshot.commit,
        baseCommit: snapshot.baseCommit,
        createdAt: snapshot.createdAt,
        provenance: snapshot.provenance,
        previousSnapshotId: snapshot.previousSnapshotId,
        status: statusOf(snapshot, currentId, iterations),
    }));
}

/**
 * Snapshot status for the picker. The iteration list is empty until someone subscribes to the feed. At that point
 * we cannot say "the commit is no longer in the PR", so it is more accurate to show the snapshot as stale.
 */
function statusOf(
    snapshot: RouteSnapshot,
    currentId: string | null,
    iterations: readonly Iteration[],
): UiSnapshotStatus {
    if (snapshot.snapshotId === currentId) {
        return 'current';
    }
    if (iterations.length === 0) {
        return 'stale';
    }
    const iteration = iterations.find((candidate) => candidate.diffId === snapshot.diffId);
    return iteration === undefined || iteration.status === 'gone' ? 'gone' : 'stale';
}

/**
 * An optional request body. An empty body is an empty object, not an error
 * (POST `route/generate` without fields is a valid call from an older client).
 */
async function readOptionalRouteRequest<T>(ctx: RequestContext, schema: z.ZodType<T>): Promise<T> {
    const raw = await readOptionalJsonBody(ctx.req);
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
        throw new RpcFailure(
            'bad_request',
            'The route request failed contract validation.',
            parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        );
    }
    return parsed.data;
}

/** Route request body. Invalid input cannot pass through. */
async function readRouteRequest<T>(ctx: RequestContext, schema: z.ZodType<T>): Promise<T> {
    const parsed = schema.safeParse(await readJsonBody(ctx.req));
    if (!parsed.success) {
        throw new RpcFailure(
            'bad_request',
            'The route request failed contract validation.',
            parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        );
    }
    return parsed.data;
}
