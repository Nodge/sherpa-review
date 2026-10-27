import type { Iteration } from '@sherpa/protocol';
import {
    UI_DEV_ENDPOINTS,
    uiDevFixtureFailDraftWritesRequestSchema,
    uiDevUpdateAvailableRequestSchema,
    uiReviewWriteAckSchema,
    uiUpdateCheckResponseSchema,
} from '@sherpa/protocol';

import { RpcFailure } from './errors.js';
import type { Route } from './http.js';
import { handlingRpcFailures } from './http.js';
import { readRequest, respond } from './review-routes.js';
import type { UpdateChecker } from './update-check.js';

/**
 * Server dev endpoints (`UI_DEV_ENDPOINTS`) provide an operation no real host can offer:
 * a "push" to a fixture PR. It makes the second pass visible both manually and in e2e.
 *
 * Registered only when the fixture host is selected (`hosts/fixture/plugin.ts` provides `advanceIteration`).
 * These routes do not exist at all for other hosts' prKey values, rather than existing and rejecting requests.
 * Authentication uses the same bearer token as UI endpoints. Dev endpoints have no separate mode.
 */

export interface DevRoutesOptions {
    /** Fixture "push": makes the next declared iteration active. */
    readonly advanceIteration: () => Iteration;
    /** Fixture draft write failure, used by e2e to test the buffer. */
    readonly setFailDraftWrites?: (fail: boolean) => void;
    /** Version check for this server. The dev endpoint supplies its result for the fixture. */
    readonly update: UpdateChecker;
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
        ...(options.setFailDraftWrites === undefined
            ? []
            : [
                  {
                      method: 'POST' as const,
                      path: UI_DEV_ENDPOINTS.fixtureFailDraftWrites,
                      handle: handlingRpcFailures(async (ctx) => {
                          const request = await readRequest(
                              ctx,
                              uiDevFixtureFailDraftWritesRequestSchema,
                              'dev draft write failure',
                          );
                          options.setFailDraftWrites?.(request.fail);
                          return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
                      }),
                  },
              ]),
        {
            method: 'POST',
            path: UI_DEV_ENDPOINTS.updateAvailable,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiDevUpdateAvailableRequestSchema, 'new version');
                // Leave the disk cache alone. The supplied version must not survive a restart.
                const update = options.update.setLatest({
                    version: request.version,
                    builtFrom: null,
                    releasedAt: request.releasedAt,
                    whatsNew: request.whatsNew,
                });
                return respond(uiUpdateCheckResponseSchema, { update }, 'local');
            }),
        },
    ];
}
