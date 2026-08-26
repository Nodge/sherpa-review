import type { UiRouteGenerateResponse, UiReviewRouteResponse } from '@sherpa/protocol';
import { UI_ENDPOINTS, uiReviewRouteResponseSchema, uiRouteGenerateResponseSchema } from '@sherpa/protocol';

import type { JsonResponse, Route } from './http.js';
import { handlingRpcFailures } from './http.js';
import { respond } from './review-routes.js';
import type { RouteOrchestrator } from './route-orchestrator.js';
import type { RouteStore } from './route-store.js';

/**
 * Route endpoints (M2-T4): generation state and start.
 *
 * Both work without a review host. The route lives in this PR's SQLite database, like reading progress.
 * The host is only needed for building: `generate` returns `no_review_host` without it.
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
    ];
}
