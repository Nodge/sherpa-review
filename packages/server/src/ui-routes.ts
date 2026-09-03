import type { ServerResponse } from 'node:http';

import type {
    PrMeta,
    UiCancelResponse,
    UiChatEvent,
    UiFeedbackAvailability,
    UiEnqueueResponse,
    UiProgressEvent,
    UiReviewEvent,
    UiRouteEvent,
    UiState,
    UiTask,
} from '@sherpa/protocol';
import {
    UI_CHAT_EVENT,
    UI_ENDPOINTS,
    UI_PROGRESS_EVENT,
    UI_REVIEW_EVENT,
    UI_ROUTE_EVENT,
    UI_STATE_EVENT,
    uiCancelRequestSchema,
    uiEnqueueRequestSchema,
    uiTaskSchema,
} from '@sherpa/protocol';
import type { z } from 'zod';

import type { ChatStore } from './chat-store.js';
import { RpcFailure } from './errors.js';
import type { RequestContext, Route, StreamContext } from './http.js';
import { abortOnDisconnect, handlingRpcFailures, readJsonBody } from './http.js';
import type { IterationFeed } from './iteration-feed.js';
import { routeRevisionOf } from './iteration-feed.js';
import type { ProgressStore } from './progress-store.js';
import type { TaskQueue, TaskRecord } from './queue.js';
import type { ReviewFeed } from './review-feed.js';
import type { RouteStore } from './route-store.js';
import type { UiPresence } from './ui-presence.js';
import type { WorkerRegistry } from './worker-registry.js';

/**
 * Synchronous PR metadata source: snapshots are assembled in a timer and a microtask, where
 * waiting for a network `getPr()` is not an option. Implemented by `PrMetaCache`.
 */
export interface PrMetaSource {
    /** null means there is no host or metadata has not loaded yet. */
    get: () => PrMeta | null;
    subscribe: (listener: () => void) => () => void;
}

export interface UiRoutesOptions {
    readonly prKey: string;
    readonly queue: TaskQueue;
    readonly registry: WorkerRegistry;
    /** This PR's host adapter name. null means no host and no review endpoints. */
    readonly reviewHost: string | null;
    /** PR metadata for the snapshot: updates also wake SSE clients. */
    readonly prMeta: PrMetaSource;
    /** Feedback channel availability depends only on credentials in the environment. */
    readonly feedback: UiFeedbackAvailability;
    /** Thread revision for SSE. null means this server never has review events. */
    readonly reviewFeed: ReviewFeed | null;
    /** PR iterations: their list is part of the snapshot, and changing the active one makes the route stale. */
    readonly iterationFeed: IterationFeed | null;
    /** Reading progress: its revision is sent over the channel to synchronize the second tab. */
    readonly progress: ProgressStore;
    /** Route state: its revision is sent over the channel in the same way as progress. */
    readonly route: RouteStore;
    /** Chat history and notes: the event carries only a revision, data is reread through a separate endpoint. */
    readonly chat: ChatStore;
    /** Reviewer presence is tracked only through live SSE connections on this channel. */
    readonly presence: UiPresence;
    /** Server shutdown: closes pending SSE connections so close() does not wait for them. */
    readonly shutdownSignal: AbortSignal;
}

/**
 * SSE channel tick with no changes. Also lazily expires leases through `listTasks` when nobody
 * calls the server: otherwise the UI would stay `leased` forever after a session silently died.
 */
const KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * UI endpoints (rpc-design §2): REST for actions, SSE for reactivity. Only the
 * snapshot is exposed. It excludes server internals (file paths, lease workerId).
 */
export function createUiRoutes(options: UiRoutesOptions): Route[] {
    return [
        {
            method: 'GET',
            path: UI_ENDPOINTS.state,
            handle: handlingRpcFailures(() => ({ status: 200, body: buildState(options) })),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.enqueue,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readUiRequest(ctx, uiEnqueueRequestSchema);
                const record = options.queue.enqueue({
                    type: request.type,
                    priority: request.priority ?? 'interactive',
                    instructions: echoInstructions(request.text),
                    contextFiles: [],
                });
                const body: UiEnqueueResponse = { task: toUiTask(record) };
                return { status: 200, body };
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.cancel,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readUiRequest(ctx, uiCancelRequestSchema);
                const body: UiCancelResponse = { outcome: options.queue.cancel(request.taskId) };
                return { status: 200, body };
            }),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.events,
            // EventSource cannot send headers, so the token arrives as a `?token=` parameter.
            auth: 'bearer-or-query',
            stream: (ctx) => {
                streamState(options, ctx);
            },
        },
    ];
}

/**
 * SSE channel: sends a snapshot immediately, then on every queue or worker status change.
 * Bursts of synchronous changes produce one event because a snapshot costs more than the delay.
 */
function streamState(options: UiRoutesOptions, ctx: StreamContext): void {
    const { res } = ctx;
    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
    });

    const abort = abortOnDisconnect(ctx.req, options.shutdownSignal);
    const disconnectPresence = options.presence.connect();
    let scheduled = false;

    const push = (): void => {
        if (abort.signal.aborted || res.writableEnded || res.destroyed) {
            return;
        }

        let payload: string;
        try {
            payload = JSON.stringify(buildState(options));
        } catch (error) {
            // Snapshot assembly failed: corrupt data hit the fail-closed boundary
            // (`uiTaskSchema`, context file parsing). Nobody can catch this exception from a timer
            // or microtask, so close the channel: the UI will show "reconnecting".
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`sherpa-server: failed to assemble UI snapshot: ${message}\n`);
            stop();
            return;
        }
        sendEvent(res, UI_STATE_EVENT, payload);
    };

    const schedule = (): void => {
        if (scheduled) {
            return;
        }
        scheduled = true;
        queueMicrotask(() => {
            scheduled = false;
            push();
        });
    };

    const pushReview = (revision: number): void => {
        if (abort.signal.aborted || res.writableEnded || res.destroyed) {
            return;
        }
        const event: UiReviewEvent = { threadsRevision: revision };
        sendEvent(res, UI_REVIEW_EVENT, JSON.stringify(event));
    };

    const pushProgress = (revision: number): void => {
        if (abort.signal.aborted || res.writableEnded || res.destroyed) {
            return;
        }
        const event: UiProgressEvent = { progressRevision: revision };
        sendEvent(res, UI_PROGRESS_EVENT, JSON.stringify(event));
    };

    // The revision is composite: `stale` is computed from iterations (`withStale`), outside `RouteStore`,
    // so without the feed a push would not make the UI reread the route.
    const pushRoute = (): void => {
        if (abort.signal.aborted || res.writableEnded || res.destroyed) {
            return;
        }
        const event: UiRouteEvent = { routeRevision: routeRevisionOf(options.route, options.iterationFeed) };
        sendEvent(res, UI_ROUTE_EVENT, JSON.stringify(event));
    };

    const pushChat = (revision: number): void => {
        if (abort.signal.aborted || res.writableEnded || res.destroyed) {
            return;
        }
        const event: UiChatEvent = { chatRevision: revision };
        sendEvent(res, UI_CHAT_EVENT, JSON.stringify(event));
    };

    const keepalive = setInterval(push, KEEPALIVE_INTERVAL_MS);
    keepalive.unref();

    const unsubscribeQueue = options.queue.subscribeChanges(schedule);
    const unsubscribeWorker = options.registry.subscribe(schedule);
    const unsubscribePrMeta = options.prMeta.subscribe(schedule);
    // Thread subscription starts with the first SSE client and stops with the last (see ReviewFeed).
    // It starts after the first state snapshot so that the channel begins with `state`.
    let unsubscribeReview: (() => void) | null = null;
    let unsubscribeIterations: (() => void) | null = null;
    let unsubscribeProgress: (() => void) | null = null;
    let unsubscribeRoute: (() => void) | null = null;
    let unsubscribeChat: (() => void) | null = null;

    const stop = (): void => {
        clearInterval(keepalive);
        unsubscribeQueue();
        unsubscribeWorker();
        unsubscribePrMeta();
        unsubscribeReview?.();
        unsubscribeIterations?.();
        unsubscribeProgress?.();
        unsubscribeRoute?.();
        unsubscribeChat?.();
        disconnectPresence();
        abort.dispose();
        if (!res.writableEnded && !res.destroyed) {
            res.end();
        }
    };
    abort.signal.addEventListener('abort', stop);
    // The connection may have broken (or server shutdown begun) before subscribing.
    if (abort.signal.aborted) {
        stop();
        return;
    }

    // Subscribe to iterations before the first snapshot: their list is part of state, and the
    // route's `stale` flag is part of its revision. It emits its own events only after initial pushes,
    // otherwise the channel would begin with 2 identical `route` events.
    let iterationsReady = false;
    if (options.iterationFeed !== null) {
        unsubscribeIterations = options.iterationFeed.subscribe(() => {
            if (!iterationsReady) {
                return;
            }
            schedule();
            pushRoute();
        });
    }

    push();
    // Send the current revision immediately: a reconnected client must learn that threads changed.
    // The channel may have closed during `push` (snapshot assembly failed), leaving nothing to subscribe to.
    if (options.reviewFeed !== null && !res.writableEnded && !res.destroyed) {
        pushReview(options.reviewFeed.revision);
        unsubscribeReview = options.reviewFeed.subscribe(pushReview);
    }
    // Reading progress is local and independent of the host: the event always exists, even without a review host.
    if (!res.writableEnded && !res.destroyed) {
        pushProgress(options.progress.revision);
        unsubscribeProgress = options.progress.subscribe(pushProgress);
    }
    // The route is local state too: without a host, it simply never leaves the `none` phase.
    if (!res.writableEnded && !res.destroyed) {
        pushRoute();
        unsubscribeRoute = options.route.subscribe(pushRoute);
    }
    if (!res.writableEnded && !res.destroyed) {
        pushChat(options.chat.revision);
        unsubscribeChat = options.chat.subscribe(pushChat);
    }
    iterationsReady = true;
}

function sendEvent(res: ServerResponse, event: string, data: string): void {
    // A newline inside data breaks the SSE format, so each line gets its own `data:`.
    const payload = data.split('\n').map((line) => `data: ${line}`);
    res.write(`event: ${event}\n${payload.join('\n')}\n\n`);
}

function buildState(options: UiRoutesOptions): UiState {
    return {
        prKey: options.prKey,
        worker: options.registry.status(),
        tasks: options.queue.listTasks().map(toUiTask),
        reviewHost: options.reviewHost,
        pr: options.prMeta.get(),
        feedback: options.feedback,
        iterations: options.iterationFeed?.iterations() ?? [],
        // Filled by M5-T9 and M5-T14.
        update: null,
        generationCap: null,
    };
}

/** Task slice for the UI. `parse` is the same fail-closed boundary as in `toLeasedTask`. */
function toUiTask(record: TaskRecord): UiTask {
    return uiTaskSchema.parse({
        id: record.id,
        type: record.type,
        priority: record.priority,
        status: record.status,
        heldByWorker: record.status === 'leased' || (record.status === 'cancelled' && record.workerId !== null),
        attempt: record.attempt,
        instructions: record.instructions,
        progressText: record.progressText,
        result: record.result,
        failReason: record.failReason,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
    });
}

/**
 * Echo task instructions are built on the server: the UI sends only text, and the prompt is part of the contract.
 * The model reads task text, so it is in English. The CLI supplies the submission command itself
 * (`formatTask`), so there is no reason to duplicate it here.
 */
function echoInstructions(text: string): string {
    return [
        'This is a check echo task of the Sherpa loop.',
        'Save exactly this text to a file (no quotes, no comments) and submit it as the result:',
        '',
        text,
    ].join('\n');
}

/** UI request body: validation errors are returned as a list, as in worker endpoints. */
async function readUiRequest<T>(ctx: RequestContext, schema: z.ZodType<T>): Promise<T> {
    const body = await readJsonBody(ctx.req);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        throw new RpcFailure(
            'bad_request',
            'Request failed contract validation.',
            parsed.error.issues.map((issue) => {
                const path = issue.path.join('.');
                return path === '' ? issue.message : `${path}: ${issue.message}`;
            }),
        );
    }
    return parsed.data;
}
