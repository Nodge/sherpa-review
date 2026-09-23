import type { IncomingMessage } from 'node:http';

import type {
    TaskAckResponse,
    TaskCompleteResponse,
    WorkerNextResponse,
    WorkerRegisterResponse,
    WorkerStatus,
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
import type { UiPresence } from './ui-presence.js';
import type { WorkerRegistry } from './worker-registry.js';

export interface WorkerRoutesOptions {
    readonly queue: TaskQueue;
    readonly registry: WorkerRegistry;
    /** UI presence: its departure stops the worker once no open tasks remain. */
    readonly presence: UiPresence;
    /** Long-poll `next` window. Shortened in tests. */
    readonly longPollSeconds: number;
    /** Server shutdown: aborts pending long-polls so close() does not wait for them. */
    readonly shutdownSignal: AbortSignal;
    /**
     * Writes the slot owner to the PR state file (`writeWorkerIdFile`) synchronously in the same tick
     * as claiming the slot, so writes follow registration order.
     */
    readonly publishWorkerId: (workerId: string) => void;
}

/**
 * Fallback queue polling during long-poll: the subscription only catches newly enqueued tasks,
 * but a task can also return to the queue when another worker's lease expires.
 */
const SAFETY_POLL_INTERVAL_MS = 1000;

/**
 * `complete` body without the contract's size refine: exceeding the limit is a task failure
 * (docs/architecture.md §7.5), so it must reach the queue instead of being rejected as an invalid request.
 */
const completeBodySchema = z.object({
    protocolVersion: semverSchema,
    cliVersion: semverSchema,
    workerId: workerIdSchema,
    taskId: taskIdSchema,
    result: z.string(),
});

/**
 * Worker endpoints (docs/protocol.md §3): the session's pull channel, all POST with a contract JSON body.
 * Every valid call is a worker heartbeat (docs/protocol.md §7). A non-owner's call is rejected with
 * `worker_conflict` before reaching the queue. `register` is the exception: a new session
 * takes over the slot even from a live one.
 */
export function createWorkerRoutes(options: WorkerRoutesOptions): Route[] {
    const subscribeSlotChange = watchSlotOwner(options.registry);

    // The slot changed owners. Return the previous worker's leases to the queue immediately, without waiting for TTL.
    const reclaimLeases = (displaced: string | null): void => {
        if (displaced !== null) {
            options.queue.releaseLeasesOf(displaced);
        }
    };

    /**
     * Call heartbeat and connection tracking: while the request is in flight (all the minutes of
     * a `next` long-poll), the session is alive. The server sees disconnection at once and detects death soon.
     * The connection only counts for a session that passed the slot ownership check.
     */
    const heartbeat = (ctx: RequestContext, workerId: string, claim: () => string | null): void => {
        reclaimLeases(claim());
        ctx.onClose(options.registry.holdConnection(workerId));
    };

    return [
        {
            method: 'POST',
            path: WORKER_ENDPOINTS.register,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readWorkerRequest(ctx, workerRegisterRequestSchema);
                heartbeat(ctx, request.workerId, () =>
                    options.registry.register(request.workerId, request.harness, request.model, request.lang),
                );
                // Immediately after claiming the slot, with no await in between: the identity file must
                // change in the same order as the slot owner.
                options.publishWorkerId(request.workerId);
                const body: WorkerRegisterResponse = {
                    kind: 'registered',
                    message:
                        'This session is registered as the worker of this PR. Run `sherpa worker next` ' +
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
                heartbeat(ctx, request.workerId, () => options.registry.touch(request.workerId));
                const body: WorkerNextResponse = await pollForTask(
                    options,
                    subscribeSlotChange,
                    ctx.req,
                    request.workerId,
                    options.longPollSeconds,
                );
                return { status: 200, body };
            }),
        },
        {
            method: 'POST',
            path: WORKER_ENDPOINTS.complete,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readWorkerRequest(ctx, completeBodySchema);
                heartbeat(ctx, request.workerId, () => options.registry.touch(request.workerId));
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
                heartbeat(ctx, request.workerId, () => options.registry.touch(request.workerId));
                const body: TaskAckResponse = options.queue.progress(request.workerId, request.taskId, request.text);
                return { status: 200, body };
            }),
        },
        {
            method: 'POST',
            path: WORKER_ENDPOINTS.fail,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readWorkerRequest(ctx, taskFailRequestSchema);
                heartbeat(ctx, request.workerId, () => options.registry.touch(request.workerId));
                const body: TaskAckResponse = options.queue.fail(request.workerId, request.taskId, request.reason);
                return { status: 200, body };
            }),
        },
    ];
}

/** Request body and version handshake (docs/protocol.md §9): checked on every worker call. */
async function readWorkerRequest<T extends { protocolVersion: string }>(
    ctx: RequestContext,
    schema: z.ZodType<T>,
): Promise<T> {
    const body = await readJsonBody(ctx.req);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        throw new RpcFailure(
            'bad_request',
            'The request failed contract validation — fix the fields and call the command again.',
            parsed.error.issues.map((issue) => {
                const path = issue.path.join('.');
                return path === '' ? issue.message : `${path}: ${issue.message}`;
            }),
        );
    }

    if (!protocolVersionsCompatible(parsed.data.protocolVersion, PROTOCOL_VERSION)) {
        throw new RpcFailure(
            'version_incompatible',
            `The CLI protocol version ${parsed.data.protocolVersion} is incompatible with the server one ` +
                `${PROTOCOL_VERSION}. Update the skill together with the CLI and restart the Sherpa server — ` +
                'they ship together.',
        );
    }
    return parsed.data;
}

/**
 * Long-poll `next`: returns a task as soon as one appears. UI departure stops the worker
 * when no tasks are open. Window expiry returns `idle`, and the CLI retries itself. Liveness does not
 * depend on the window. While the call is pending, its open connection keeps the worker alive.
 */
async function pollForTask(
    options: WorkerRoutesOptions,
    subscribeSlotChange: SubscribeSlotChange,
    req: IncomingMessage,
    workerId: string,
    windowSeconds: number,
): Promise<WorkerNextResponse> {
    const deadline = Date.now() + windowSeconds * 1000;
    const abort = abortOnDisconnect(req, options.shutdownSignal);

    try {
        for (;;) {
            // Check before `next`, or a disconnected worker (or one caught by server shutdown)
            // would receive a lease it will never learn about.
            if (abort.signal.aborted) {
                break;
            }

            // While the call was pending, a new session could have taken the slot by registering,
            // without waiting for the old one to die. Otherwise the old worker would take its task.
            options.registry.assertOwner(workerId);

            if (shouldFinishWorker(options)) {
                // The session is about to end. Release its holds on cancelled tasks too,
                // or the UI would show a dead worker as busy until TTL expires.
                options.queue.releaseCancelledHoldsOf(workerId);
                return { kind: 'done', message: 'The reviewer closed the tab. Work is finished.' };
            }

            const leased = options.queue.next(workerId);
            if (leased !== null) {
                return { kind: 'task', task: leased.task, lease: leased.lease };
            }

            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                break;
            }
            await waitForWork(
                options.queue,
                options.presence,
                subscribeSlotChange,
                abort.signal,
                Math.min(remaining, SAFETY_POLL_INTERVAL_MS),
            );
        }
    } finally {
        abort.dispose();
    }

    // The CLI consumes `idle` and retries itself. The model never sees this text.
    return { kind: 'idle', message: 'No tasks yet. Call `sherpa worker next` again.' };
}

/** The UI has left and no task is waiting to be claimed or completed. */
function shouldFinishWorker(options: WorkerRoutesOptions): boolean {
    return (
        options.presence.uiGone &&
        !options.queue.listTasks().some((task) => task.status === 'queued' || task.status === 'leased')
    );
}

/** Waits for a queue change, UI departure, slot change, fallback tick or disconnection. */
function waitForWork(
    queue: TaskQueue,
    presence: UiPresence,
    subscribeSlotChange: SubscribeSlotChange,
    signal: AbortSignal,
    timeoutMs: number,
): Promise<void> {
    return new Promise<void>((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }

        let timer: NodeJS.Timeout | null = null;
        let unsubscribeQueue = (): void => undefined;
        let unsubscribePresence = (): void => undefined;
        let unsubscribeSlot = (): void => undefined;
        let finished = false;

        const finish = (): void => {
            if (finished) {
                return;
            }
            finished = true;
            if (timer !== null) {
                clearTimeout(timer);
            }
            unsubscribeQueue();
            unsubscribePresence();
            unsubscribeSlot();
            signal.removeEventListener('abort', finish);
            resolve();
        };

        timer = setTimeout(finish, timeoutMs);
        timer.unref();
        unsubscribeQueue = queue.subscribeChanges(finish);
        unsubscribePresence = presence.subscribe(finish);
        unsubscribeSlot = subscribeSlotChange(finish);
        signal.addEventListener('abort', finish);

        // The transition could occur between the check in `pollForTask` and subscription setup.
        if (presence.uiGone) {
            finish();
        }
    });
}

/** Subscribes to slot ownership changes. Returns an unsubscribe function like other server subscriptions. */
type SubscribeSlotChange = (listener: () => void) => () => void;

/**
 * Tracks the slot owner for pending long-polls: takeover displaces a session immediately, so its
 * `next` must return `worker_conflict` in the same second instead of waiting out the window.
 * No need to unsubscribe from the registry: the endpoints have the same lifetime, and `WorkerRegistry.close()`
 * clears listeners itself.
 */
function watchSlotOwner(registry: WorkerRegistry): SubscribeSlotChange {
    const waiters = new Set<() => void>();
    let owner = ownerOf(registry.status());

    registry.subscribe((status) => {
        const next = ownerOf(status);
        if (next === owner) {
            return;
        }

        owner = next;
        for (const wake of [...waiters]) {
            wake();
        }
    });

    return (listener) => {
        waiters.add(listener);
        return () => {
            waiters.delete(listener);
        };
    };
}

function ownerOf(status: WorkerStatus): string | null {
    return status.kind === 'never' ? null : status.workerId;
}

