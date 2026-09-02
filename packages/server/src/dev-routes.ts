import type { Iteration } from '@sherpa/protocol';
import { UI_DEV_ENDPOINTS, uiReviewWriteAckSchema } from '@sherpa/protocol';

import { RpcFailure } from './errors.js';
import type { Route } from './http.js';
import { handlingRpcFailures } from './http.js';
import { respond } from './review-routes.js';

/**
 * Server dev endpoints (`UI_DEV_ENDPOINTS`) provide an operation no real host can offer:
 * a "push" to a fixture PR. It makes the second pass visible both manually and in e2e.
 *
 * Registered only when a fixture host is selected (`hosts/select.ts` provides `advanceIteration`).
 * These endpoints do not exist at all for a non-fixture prKey, rather than existing and refusing requests.
 * Authentication uses the same bearer token as UI endpoints. Dev endpoints have no separate mode.
 */

export interface DevRoutesOptions {
    /** Fixture "push": makes the next declared iteration active. */
    readonly advanceIteration: () => Iteration;
}

export function createDevRoutes(options: DevRoutesOptions): Route[] {
    return [
        {
            method: 'POST',
            path: UI_DEV_ENDPOINTS.fixtureAdvanceIteration,
            handle: handlingRpcFailures(() => {
                try {
                    options.advanceIteration();
                } catch (error) {
                    // "No more iterations" means the fixture is exhausted, not that the server is broken.
                    throw new RpcFailure('bad_request', error instanceof Error ? error.message : String(error));
                }
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
    ];
}
