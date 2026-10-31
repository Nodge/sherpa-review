import type { UiFeedbackChannel, UiFeedbackResponse, WorkerStatus } from '@sherpa/protocol';
import {
    PROTOCOL_VERSION,
    UI_ENDPOINTS,
    uiFeedbackChannelSchema,
    uiFeedbackRequestSchema,
    uiFeedbackResponseSchema,
} from '@sherpa/protocol';
import type { z } from 'zod';

import { RpcFailure } from './errors.js';
import type { FeedbackAvailability, FeedbackChannel } from './feedback-channel.js';
import type { JsonResponse, RequestContext, Route } from './http.js';
import { handlingRpcFailures, readJsonBody } from './http.js';
import { SERVER_VERSION } from './version.js';

const NO_CHANNEL_MESSAGE = 'This Sherpa build has no feedback channel.';
const NO_REASON_MESSAGE = 'The feedback channel is currently unavailable.';
const SUMMARY_MAX_CHARS = 100;
const DEFAULT_CURRENT_USER_TIMEOUT_MS = 500;

export interface FeedbackRoutesOptions {
    /** Build feedback channel. If null, the endpoint returns `unavailable`. */
    readonly channel: FeedbackChannel | null;
    readonly prKey: string;
    readonly workerStatus: () => WorkerStatus;
    /** Host-specific whoami. If absent or failed, context uses "unknown". */
    readonly currentUser?: () => string | null | Promise<string | null>;
    readonly currentUserTimeoutMs?: number;
    /**
     * Availability of the `issues` channel, already computed for the snapshot (`feedbackChannelState`): the endpoint and UI
     * use the same value. If absent, the channel is queried here.
     */
    readonly availability?: FeedbackAvailability;
}

/**
 * Channel state for the UI snapshot: button type and form availability. Computed once at server startup,
 * because `issues` availability is synchronous and spawns no processes. The result passes the protocol schema.
 */
export function feedbackChannelState(channel: FeedbackChannel | null): UiFeedbackChannel | null {
    if (channel === null) {
        return null;
    }
    const state: UiFeedbackChannel =
        channel.kind === 'link'
            ? { kind: 'link', url: channel.url }
            : { kind: 'issues', ...channel.availability(), discussionUrl: channel.discussionUrl ?? null };
    const parsed = uiFeedbackChannelSchema.safeParse(state);
    if (!parsed.success) {
        throw new Error(
            `Feedback channel does not match the contract: ${parsed.error.issues
                .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
                .join('; ')}`,
        );
    }
    return parsed.data;
}

/** The feedback POST endpoint does not depend on the review host or a live worker. */
export function createFeedbackRoutes(options: FeedbackRoutesOptions): Route[] {
    const { channel } = options;
    const availability = channel?.kind === 'issues' ? (options.availability ?? channel.availability()) : null;

    return [
        {
            method: 'POST',
            path: UI_ENDPOINTS.feedback,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiFeedbackRequestSchema);
                if (channel === null) {
                    return unavailable(NO_CHANNEL_MESSAGE);
                }
                // The link channel button opens an external page without a form. Requests here bypass the UI.
                if (channel.kind === 'link') {
                    return unavailable(`This build accepts feedback at: ${channel.url}`);
                }
                if (availability !== null && !availability.available) {
                    return unavailable(availability.reason ?? NO_REASON_MESSAGE);
                }

                const description = request.includeContext
                    ? descriptionWithContext(
                          request.text,
                          {
                              prKey: options.prKey,
                              view: request.context?.view ?? 'unknown',
                              routePhase: request.context?.routePhase ?? 'unknown',
                              uiVersion: request.context?.uiVersion ?? 'unknown',
                              worker: options.workerStatus(),
                              user: await bestEffortCurrentUser(
                                  options.currentUser,
                                  options.currentUserTimeoutMs ?? DEFAULT_CURRENT_USER_TIMEOUT_MS,
                              ),
                          },
                      )
                    : request.text;
                const outcome = await channel.create({
                    summary: feedbackSummary(request.text),
                    description,
                });
                if (outcome.kind === 'unavailable') {
                    process.stderr.write(`sherpa-review-server: feedback channel unavailable: ${outcome.reason}\n`);
                    return unavailable(outcome.reason);
                }
                return respond({
                    outcome: 'created',
                    issueKey: outcome.key,
                    issueUrl: outcome.url,
                    message: null,
                });
            }),
        },
    ];
}

function unavailable(message: string): JsonResponse {
    return respond({ outcome: 'unavailable', issueKey: null, issueUrl: null, message });
}

interface FeedbackContext {
    readonly prKey: string;
    readonly view: string;
    readonly routePhase: string;
    readonly uiVersion: string;
    readonly worker: WorkerStatus;
    readonly user: string | null;
}

function descriptionWithContext(text: string, context: FeedbackContext): string {
    return [
        text,
        '',
        '---',
        '## Sherpa context',
        '',
        `- Version: UI ${context.uiVersion}, server ${SERVER_VERSION}, protocol ${PROTOCOL_VERSION}`,
        `- PR: ${context.prKey}`,
        `- View: ${context.view}`,
        `- Route phase: ${context.routePhase}`,
        `- Worker: ${workerDescription(context.worker)}`,
        `- User: ${context.user ?? 'unknown'}`,
    ].join('\n');
}

function workerDescription(worker: WorkerStatus): string {
    if (worker.kind === 'never') {
        return 'not registered';
    }
    const status = worker.kind === 'connected' ? 'connected' : 'disconnected';
    return `${worker.harness ?? 'unknown harness'} · ${worker.model ?? 'unknown model'} · ${status}`;
}

function feedbackSummary(text: string): string {
    const [rawFirstLine = ''] = text.split(/\r?\n/, 1);
    const firstLine = rawFirstLine.trim();
    return (firstLine === '' ? 'Feedback' : firstLine).slice(0, SUMMARY_MAX_CHARS);
}

async function bestEffortCurrentUser(
    source: FeedbackRoutesOptions['currentUser'],
    timeoutMs: number,
): Promise<string | null> {
    if (source === undefined) {
        return null;
    }

    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
            resolve(null);
        }, Math.max(0, timeoutMs));
        timer.unref();
    });
    try {
        const value = await Promise.race([
            Promise.resolve()
                .then(source)
                .catch(() => null),
            timeout,
        ]);
        return nonEmpty(value);
    } finally {
        clearTimeout(timer);
    }
}

async function readRequest<T>(ctx: RequestContext, schema: z.ZodType<T>): Promise<T> {
    const parsed = schema.safeParse(await readJsonBody(ctx.req));
    if (!parsed.success) {
        throw new RpcFailure(
            'bad_request',
            'The feedback request failed contract validation.',
            parsed.error.issues.map((issue) => {
                const path = issue.path.join('.');
                return path === '' ? issue.message : `${path}: ${issue.message}`;
            }),
        );
    }
    return parsed.data;
}

function respond(body: UiFeedbackResponse): JsonResponse {
    const parsed = uiFeedbackResponseSchema.safeParse(body);
    if (!parsed.success) {
        throw new RpcFailure(
            'internal',
            'The server response does not match the feedback contract.',
            parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        );
    }
    return { status: 200, body: parsed.data };
}

function nonEmpty(value: string | null | undefined): string | null {
    const trimmed = value?.trim() ?? '';
    return trimmed === '' ? null : trimmed;
}
