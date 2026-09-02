import { UI_ENDPOINTS, uiPrStatePatchSchema, uiPrStateResponseSchema } from '@sherpa/protocol';

import type { Route } from './http.js';
import { handlingRpcFailures } from './http.js';
import type { PrStateStore } from './pr-state-store.js';
import { readRequest, respond } from './review-routes.js';

export interface PrStateRoutesOptions {
    readonly prState: PrStateStore;
}

/**
 * This PR's UI state endpoints (M3-T18). They need no review host: collapsed state and palette history are
 * are local tab data. Like settings, they have no SSE: a second tab for the same PR catches up
 * when it rereads the endpoint. Until then, the last write wins.
 */
export function createPrStateRoutes(options: PrStateRoutesOptions): Route[] {
    return [
        {
            method: 'GET',
            path: UI_ENDPOINTS.prState,
            handle: handlingRpcFailures(() =>
                respond(uiPrStateResponseSchema, { prState: options.prState.read() }, 'local'),
            ),
        },
        {
            method: 'PATCH',
            path: UI_ENDPOINTS.prState,
            handle: handlingRpcFailures(async (ctx) => {
                const patch = await readRequest(ctx, uiPrStatePatchSchema, 'UI state change');
                const prState = options.prState.patch(patch);
                return respond(uiPrStateResponseSchema, { prState }, 'local');
            }),
        },
    ];
}
