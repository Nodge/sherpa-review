import type { ReviewHost } from '@sherpa/protocol';
import {
    UI_ENDPOINTS,
    uiReviewDiffResponseSchema,
    uiReviewLensesResponseSchema,
    uiReviewPrResponseSchema,
    uiReviewThreadsResponseSchema,
} from '@sherpa/protocol';
import type { z } from 'zod';

import { RpcFailure } from './errors.js';
import type { JsonResponse, Route } from './http.js';
import { handlingRpcFailures } from './http.js';

/**
 * UI review endpoints (M1-T10): PR metadata, active iteration diff, threads and lenses. All use GET with a token.
 *
 * Fail-closed in both directions: the adapter validates host responses against its schemas, and the server validates
 * what it sends to the UI against the contract schemas. No host (prKey did not map to anything) means `no_review_host`.
 * A host failure (network, token, invalid response) means `host_unavailable` with a readable reason.
 */

export interface ReviewRoutesOptions {
    readonly host: ReviewHost | null;
}

export function createReviewRoutes(options: ReviewRoutesOptions): Route[] {
    return [
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewPr,
            handle: handlingRpcFailures(async () => {
                const host = hostOf(options);
                return respond(uiReviewPrResponseSchema, { pr: await call(() => host.getPr()) });
            }),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewDiff,
            handle: handlingRpcFailures(async () => {
                const host = hostOf(options);
                return respond(uiReviewDiffResponseSchema, { diff: await call(() => host.getDiff()) });
            }),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewThreads,
            handle: handlingRpcFailures(async () => {
                const host = hostOf(options);
                return respond(uiReviewThreadsResponseSchema, { threads: await call(() => host.getThreads()) });
            }),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewLenses,
            handle: handlingRpcFailures(async () => {
                const host = hostOf(options);
                const [ownership, extra] = await call(() =>
                    Promise.all([host.ownershipLens(), host.extraLenses()]),
                );
                return respond(uiReviewLensesResponseSchema, { ownership, extra });
            }),
        },
    ];
}

function hostOf(options: ReviewRoutesOptions): ReviewHost {
    if (options.host === null) {
        throw new RpcFailure(
            'no_review_host',
            'This PR has no host adapter: its PR key is not recognized as a supported host or fixture key.',
        );
    }
    return options.host;
}

/** An adapter error without a contract code is a host failure, not an internal failure on our side. */
async function call<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof RpcFailure) {
            throw error;
        }
        throw new RpcFailure('host_unavailable', `Host adapter failed: ${messageOf(error)}`);
    }
}

/** The contract schema validates the response body. Invalid data never leaves the server (requirements §7). */
function respond<T>(schema: z.ZodType<T>, body: unknown): JsonResponse {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        throw new RpcFailure(
            'host_unavailable',
            'The host response does not match the review contract.',
            parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        );
    }
    return { status: 200, body: parsed.data };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
