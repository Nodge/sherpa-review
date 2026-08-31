import type { UiRouteFillStopResponse, UiRouteGenerateResponse, UiReviewRouteResponse } from '@sherpa/protocol';
import {
    UI_ENDPOINTS,
    uiReviewRouteResponseSchema,
    uiRouteFillStopRequestSchema,
    uiRouteFillStopResponseSchema,
    uiRouteGenerateResponseSchema,
} from '@sherpa/protocol';
import type { z } from 'zod';

import { RpcFailure } from './errors.js';
import type { JsonResponse, RequestContext, Route } from './http.js';
import { handlingRpcFailures, readJsonBody } from './http.js';
import { respond } from './review-routes.js';
import type { RouteOrchestrator } from './route-orchestrator.js';
import type { RouteStore } from './route-store.js';

/**
 * Route endpoints: read state, start generation and fill one stop.
 *
 * `GET reviewRoute` reads SQLite and works without a review host. Both POST endpoints load
 * the diff before mutating: `no_review_host` without a host, `host_unavailable` on host failure.
 */

export interface RouteRoutesOptions {
    readonly store: RouteStore;
    readonly orchestrator: RouteOrchestrator;
}

export function createRouteRoutes(options: RouteRoutesOptions): Route[] {
    return [
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewRoute,
            handle: handlingRpcFailures(
                (): JsonResponse => {
                    const body: UiReviewRouteResponse = {
                        route: options.store.read(),
                        routeRevision: options.store.revision,
                    };
                    return respond(uiReviewRouteResponseSchema, body, 'local');
                },
            ),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewRouteGenerate,
            handle: handlingRpcFailures(async () => {
                const body: UiRouteGenerateResponse = { outcome: await options.orchestrator.generate() };
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
