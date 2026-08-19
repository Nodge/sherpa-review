import type { IncomingMessage } from 'node:http';

import type {
    TaskAckResponse,
    TaskCompleteResponse,
    WorkerNextResponse,
    WorkerRegisterResponse,
} from '@sherpa/protocol';
import {
    PROTOCOL_VERSION,
    protocolVersionsCompatible,
    semverSchema,
    taskFailRequestSchema,
    taskIdSchema,
    taskProgressRequestSchema,
    WORKER_ENDPOINTS,
    workerIdSchema,
    workerNextRequestSchema,
    workerRegisterRequestSchema,
} from '@sherpa/protocol';
import { z } from 'zod';

import { RpcFailure } from './errors.js';
import type { RequestContext, Route } from './http.js';
import { abortOnDisconnect, handlingRpcFailures, readJsonBody } from './http.js';
import type { TaskQueue } from './queue.js';
import type { WorkerRegistry } from './worker-registry.js';

export interface WorkerRoutesOptions {
    readonly queue: TaskQueue;
    readonly registry: WorkerRegistry;
    /** Upper bound for `next` long-poll. Shortened in tests. */
    readonly longPollSeconds: number;
    /** Server shutdown: aborts pending long-polls so close() does not wait for them. */
    readonly shutdownSignal: AbortSignal;
}

/**
 * Fallback queue polling during long-poll: the subscription only catches newly enqueued tasks,
 * but a task can also return to the queue when another worker's lease expires.
 */
const SAFETY_POLL_INTERVAL_MS = 1000;

/**
 * `complete` body without the contract's size refine: exceeding the limit is a task failure
 * (spec §3.5), so it must reach the queue instead of being rejected as an invalid request.
 */
const completeBodySchema = z.object({
    protocolVersion: semverSchema,
    cliVersion: semverSchema,
    workerId: workerIdSchema,
    taskId: taskIdSchema,
    result: z.string(),
});

/**
 * Worker endpoints (rpc-design §3): the session's pull channel, all POST with a contract JSON body.
 * Every valid call is a worker heartbeat (rpc-design §7). Another live session gets
 * `worker_conflict` before the request reaches the queue.
 */
export function createWorkerRoutes(options: WorkerRoutesOptions): Route[] {
    // Taking over the slot means the previous worker is dead: return its leases to the queue immediately, without waiting for TTL.
    const reclaimLeases = (displaced: string | null): void => {
        if (displaced !== null) {
            options.queue.releaseLeasesOf(displaced);
        }
    };

    return [
        {
            method: 'POST',
            path: WORKER_ENDPOINTS.register,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readWorkerRequest(ctx, workerRegisterRequestSchema);
                reclaimLeases(options.registry.register(request.workerId, request.harness));
                const body: WorkerRegisterResponse = {
                    kind: 'registered',
                    message:
                        'The session is registered as the worker for this PR. Call `sherpa worker next` ' +
                        'and follow the instructions in its output.',
                };
                return { status: 200, body };
            }),
        },
        {
            method: 'POST',
            path: WORKER_ENDPOINTS.next,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readWorkerRequest(ctx, workerNextRequestSchema);
                reclaimLeases(options.registry.touch(request.workerId));
                const body: WorkerNextResponse = await pollForTask(options, ctx.req, request.workerId);
                return { status: 200, body };
            }),
        },
        {
            method: 'POST',
            path: WORKER_ENDPOINTS.complete,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readWorkerRequest(ctx, completeBodySchema);
                reclaimLeases(options.registry.touch(request.workerId));
                const body: TaskCompleteResponse = options.queue.complete(
                    request.workerId,
                    request.taskId,
                    request.result,
                );
                return { status: 200, body };
            }),
        },
        {
            method: 'POST',
            path: WORKER_ENDPOINTS.progress,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readWorkerRequest(ctx, taskProgressRequestSchema);
                reclaimLeases(options.registry.touch(request.workerId));
                const body: TaskAckResponse = options.queue.progress(request.workerId, request.taskId, request.text);
                return { status: 200, body };
            }),
        },
        {
            method: 'POST',
            path: WORKER_ENDPOINTS.fail,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readWorkerRequest(ctx, taskFailRequestSchema);
                reclaimLeases(options.registry.touch(request.workerId));
                const body: TaskAckResponse = options.queue.fail(request.workerId, request.taskId, request.reason);
                return { status: 200, body };
            }),
        },
    ];
}

/** Request body + version handshake (rpc-design §9): checked on every worker call. */
async function readWorkerRequest<T extends { protocolVersion: string }>(
    ctx: RequestContext,
    schema: z.ZodType<T>,
): Promise<T> {
    const body = await readJsonBody(ctx.req);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        throw new RpcFailure(
            'bad_request',
            'The request failed contract validation. Fix the fields and call the command again.',
            parsed.error.issues.map((issue) => {
                const path = issue.path.join('.');
                return path === '' ? issue.message : `${path}: ${issue.message}`;
            }),
        );
    }

    if (!protocolVersionsCompatible(parsed.data.protocolVersion, PROTOCOL_VERSION)) {
        throw new RpcFailure(
            'version_incompatible',
            `CLI protocol version ${parsed.data.protocolVersion} is incompatible with server version ${PROTOCOL_VERSION}. ` +
                'Update the skill together with the CLI and restart the Sherpa server. They are installed as one distribution.',
        );
    }
    return parsed.data;
}

/**
 * Long-poll `next`: returns a task as soon as one is available, or `idle` when the window expires
 * ("call again"), because a call that waits forever will hit the harness timeout (rpc-design §1).
 */
async function pollForTask(
    options: WorkerRoutesOptions,
    req: IncomingMessage,
    workerId: string,
): Promise<WorkerNextResponse> {
    const deadline = Date.now() + options.longPollSeconds * 1000;
    const abort = abortOnDisconnect(req, options.shutdownSignal);

    try {
        for (;;) {
            // Check before `next`, or a disconnected worker (or one caught by server shutdown)
            // would receive a lease it will never learn about.
            if (abort.signal.aborted) {
                break;
            }

            // While the call was waiting, a new session may have taken the slot (the previous one exceeded the silence timeout).
            // Otherwise the old worker would take a task from it.
            options.registry.assertOwner(workerId);

            const leased = options.queue.next(workerId);
            if (leased !== null) {
                return { kind: 'task', task: leased.task, lease: leased.lease };
            }

            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                break;
            }
            await waitForWork(options.queue, abort.signal, Math.min(remaining, SAFETY_POLL_INTERVAL_MS));
        }
    } finally {
        abort.dispose();
    }

    return { kind: 'idle', message: 'No tasks yet. Call `sherpa worker next` again.' };
}

/** Waits for a task to be enqueued, a fallback tick or disconnection. The timer does not keep the process alive. */
function waitForWork(queue: TaskQueue, signal: AbortSignal, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }

        const finish = (): void => {
            clearTimeout(timer);
            unsubscribe();
            signal.removeEventListener('abort', finish);
            resolve();
        };

        const timer = setTimeout(finish, timeoutMs);
        timer.unref();
        const unsubscribe = queue.subscribe(finish);
        signal.addEventListener('abort', finish);
    });
}

