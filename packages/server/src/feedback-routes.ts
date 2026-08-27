import type { UiFeedbackAvailability, UiFeedbackResponse, WorkerStatus } from '@sherpa/protocol';
import {
    PROTOCOL_VERSION,
    UI_ENDPOINTS,
    uiFeedbackRequestSchema,
    uiFeedbackResponseSchema,
} from '@sherpa/protocol';
import type { z } from 'zod';

import { RpcFailure } from './errors.js';
import type { JsonResponse, RequestContext, Route } from './http.js';
import { handlingRpcFailures, readJsonBody } from './http.js';
import {
    DEFAULT_FEEDBACK_PARENT,
    DEFAULT_FEEDBACK_QUEUE,
    IssueClient,



import { SERVER_VERSION } from './version.js';

/** Where to send feedback manually. Uses the configured parent, not a hardcoded default. */
export function feedbackUnavailableMessage(parent: string): string {
    return `You can send feedback directly to issue ${parent} or to Alice Ingram.`;
}

const SUMMARY_PREFIX = '[Sherpa] ';
const SUMMARY_MAX_CHARS = 100;
const DEFAULT_CURRENT_USER_TIMEOUT_MS = 500;

export interface FeedbackIntegrationOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly fetch?: IssueFetchLike;
    readonly baseUrl?: string;
    readonly queue?: string;
    readonly parent?: string;
    readonly retryAttempts?: number;
    readonly retryBaseMs?: number;
    readonly timeoutMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly random?: () => number;
    readonly currentUserTimeoutMs?: number;
}

export interface FeedbackRoutesOptions extends FeedbackIntegrationOptions {
    readonly prKey: string;
    readonly workerStatus: () => WorkerStatus;
    /** Host-specific whoami. If absent or failed, context uses "unknown". */
    readonly currentUser?: () => string | null | Promise<string | null>;
}

/** Channel availability for the UI snapshot. Checks only the environment. */
export function feedbackAvailability(env: NodeJS.ProcessEnv = process.env): UiFeedbackAvailability {
    const parent = nonEmpty(env.SHERPA_FEEDBACK_PARENT) ?? DEFAULT_FEEDBACK_PARENT;
    return issueTokenAvailable({ env })
        ? { available: true, reason: null }
        : { available: false, reason: feedbackUnavailableMessage(parent) };
}

/** The feedback POST endpoint does not depend on the review host or a live worker. */
export function createFeedbackRoutes(options: FeedbackRoutesOptions): Route[] {
    const env = options.env ?? process.env;
    const parent = nonEmpty(options.parent ?? env.SHERPA_FEEDBACK_PARENT) ?? DEFAULT_FEEDBACK_PARENT;
    const availability: UiFeedbackAvailability = issueTokenAvailable({ env })
        ? { available: true, reason: null }
        : { available: false, reason: feedbackUnavailableMessage(parent) };
    
        token: issueTokenSource({ env }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        queue: nonEmpty(options.queue ?? env.SHERPA_FEEDBACK_QUEUE) ?? DEFAULT_FEEDBACK_QUEUE,
        parent,
        ...(options.retryAttempts === undefined ? {} : { retryAttempts: options.retryAttempts }),
        ...(options.retryBaseMs === undefined ? {} : { retryBaseMs: options.retryBaseMs }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        ...(options.random === undefined ? {} : { random: options.random }),
    });

    return [
        {
            method: 'POST',
            path: UI_ENDPOINTS.feedback,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiFeedbackRequestSchema);
                if (!availability.available) {
                    return respond({
                        outcome: 'unavailable',
                        issueKey: null,
                        issueUrl: null,
                        message: availability.reason ?? feedbackUnavailableMessage(parent),
                    });
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
                
                    summary: feedbackSummary(request.text),
                    description,
                });
                return respond({
                    outcome: 'created',
                    issueKey: issue.key,
                    issueUrl: issue.url,
                    message: null,
                });
            }),
        },
    ];
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
    return `${SUMMARY_PREFIX}${firstLine === '' ? 'Feedback' : firstLine}`.slice(0, SUMMARY_MAX_CHARS);
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
