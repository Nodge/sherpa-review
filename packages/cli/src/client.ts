import type {
    RpcError,
    TaskAckResponse,
    TaskCompleteRequest,
    TaskCompleteResponse,
    TaskFailRequest,
    TaskProgressRequest,
    WorkerNextRequest,
    WorkerNextResponse,
    WorkerRegisterRequest,
    WorkerRegisterResponse,
} from '@sherpa/protocol';
import {
    LONG_POLL_MAX_SECONDS,
    PROTOCOL_VERSION,
    rpcErrorSchema,
    taskAckResponseSchema,
    taskCompleteRequestSchema,
    taskCompleteResponseSchema,
    taskFailRequestSchema,
    taskProgressRequestSchema,
    WORKER_ENDPOINTS,
    workerNextRequestSchema,
    workerNextResponseSchema,
    workerRegisterRequestSchema,
    workerRegisterResponseSchema,
} from '@sherpa/protocol';
import type { ZodType } from 'zod';

import type { ServerConnection } from './discovery.js';
import { serverUnavailable } from './discovery.js';
import { CliError, RpcCallError } from './errors.js';
import type { CallRole } from './format.js';
import { formatRpcError } from './format.js';
import { CLI_VERSION } from './version.js';

/** Margin beyond the server long-poll window. Don't abort before the server, as the response is already in flight. */
const LONG_POLL_SLACK_SECONDS = 30;
const NEXT_TIMEOUT_MS = (LONG_POLL_MAX_SECONDS + LONG_POLL_SLACK_SECONDS) * 1000;

/** Other endpoints respond immediately, so there is no need for a long wait. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Registers the session as the PR worker (rpc-design §7) on the first skill call and every reconnection. */
export async function requestRegister(
    connection: ServerConnection,
    harness: string | undefined,
): Promise<WorkerRegisterResponse> {
    return callWorker<WorkerRegisterRequest, WorkerRegisterResponse>(connection, {
        endpoint: WORKER_ENDPOINTS.register,
        payload: harness === undefined ? {} : { harness },
        requestSchema: workerRegisterRequestSchema,
        responseSchema: workerRegisterResponseSchema,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        role: 'register',
    });
}

export async function requestNext(connection: ServerConnection): Promise<WorkerNextResponse> {
    return callWorker<WorkerNextRequest, WorkerNextResponse>(connection, {
        endpoint: WORKER_ENDPOINTS.next,
        payload: {},
        requestSchema: workerNextRequestSchema,
        responseSchema: workerNextResponseSchema,
        timeoutMs: NEXT_TIMEOUT_MS,
        role: 'worker',
    });
}

export async function requestComplete(
    connection: ServerConnection,
    taskId: number,
    result: string,
): Promise<TaskCompleteResponse> {
    return callWorker<TaskCompleteRequest, TaskCompleteResponse>(connection, {
        endpoint: WORKER_ENDPOINTS.complete,
        payload: { taskId, result },
        requestSchema: taskCompleteRequestSchema,
        responseSchema: taskCompleteResponseSchema,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        role: 'worker',
    });
}

export async function requestProgress(
    connection: ServerConnection,
    taskId: number,
    text: string,
): Promise<TaskAckResponse> {
    return callWorker<TaskProgressRequest, TaskAckResponse>(connection, {
        endpoint: WORKER_ENDPOINTS.progress,
        payload: { taskId, text },
        requestSchema: taskProgressRequestSchema,
        responseSchema: taskAckResponseSchema,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        role: 'worker',
    });
}

export async function requestFail(
    connection: ServerConnection,
    taskId: number,
    reason: string,
): Promise<TaskAckResponse> {
    return callWorker<TaskFailRequest, TaskAckResponse>(connection, {
        endpoint: WORKER_ENDPOINTS.fail,
        payload: { taskId, reason },
        requestSchema: taskFailRequestSchema,
        responseSchema: taskAckResponseSchema,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        role: 'worker',
    });
}

/** Common body fields shared by all worker requests (rpc-design §9). */
type WorkerRequestBase = Pick<WorkerNextRequest, 'protocolVersion' | 'cliVersion' | 'workerId'>;

/** Request fields left to the caller. `callWorker` adds the handshake and identity. */
type WorkerPayload<TRequest extends WorkerRequestBase> = Omit<TRequest, keyof WorkerRequestBase>;

interface WorkerCall<TRequest extends WorkerRequestBase, TResponse> {
    readonly endpoint: string;
    readonly payload: WorkerPayload<TRequest>;
    readonly requestSchema: ZodType<TRequest>;
    readonly responseSchema: ZodType<TResponse>;
    readonly timeoutMs: number;
    /** Call role. Determines the next-step message on a worker conflict. */
    readonly role: CallRole;
}

/**
 * One worker call: version handshake in every request body (rpc-design §9),
 * bearer token from the manifest. Validates the body against the contract schema before sending, and the response after,
 * failing closed in both directions.
 */
async function callWorker<TRequest extends WorkerRequestBase, TResponse>(
    connection: ServerConnection,
    call: WorkerCall<TRequest, TResponse>,
): Promise<TResponse> {
    const request = call.requestSchema.safeParse({
        protocolVersion: PROTOCOL_VERSION,
        cliVersion: CLI_VERSION,
        workerId: connection.workerId,
        ...call.payload,
    });
    if (!request.success) {
        throw new CliError(invalidRequest(request.error.issues.map((issue) => issue.message)));
    }

    let response: Response;
    try {
        response = await fetch(`http://127.0.0.1:${String(connection.port)}${call.endpoint}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${connection.token}`,
            },
            body: JSON.stringify(request.data),
            signal: AbortSignal.timeout(call.timeoutMs),
        });
    } catch {
        throw new CliError(serverUnavailable(connection.prKey));
    }

    const text = await readText(response, connection);
    if (!response.ok) {
        const failure = parseRpcError(text);
        throw new RpcCallError(failure.code, formatRpcError(failure, call.role));
    }

    const parsed = call.responseSchema.safeParse(parseJson(text));
    if (!parsed.success) {
        throw new CliError(contractMismatch());
    }
    return parsed.data;
}

async function readText(response: Response, connection: ServerConnection): Promise<string> {
    try {
        return await response.text();
    } catch {
        throw new CliError(serverUnavailable(connection.prKey));
    }
}

/** An error body outside the contract means a version mismatch. The server must return `rpcErrorSchema`. */
function parseRpcError(text: string): RpcError['error'] {
    const parsed = rpcErrorSchema.safeParse(parseJson(text));
    if (!parsed.success) {
        throw new CliError(contractMismatch());
    }
    return parsed.data.error;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/** Request failed local contract validation: a long `--text`, invalid `SHERPA_WORKER_ID` and similar cases. */
function invalidRequest(details: readonly string[]): string {
    return [
        'sherpa: the command does not meet the contract, the server will reject it:',
        ...details.map((detail) => `  - ${detail}`),
        'Fix the command arguments (and `SHERPA_WORKER_ID` if set) and call it again.',
    ].join('\n');
}

function contractMismatch(): string {
    return (
        'sherpa: the server response does not meet the contract. The CLI and server versions have probably diverged.\n' +
        'Update the Sherpa skill together with the CLI and restart the server.'
    );
}
