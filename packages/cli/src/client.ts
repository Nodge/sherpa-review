import http from 'node:http';

import type {
    Locale,
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
    LONG_POLL_DEFAULT_SECONDS,
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

/** Client timeout for one `next` request. The request doesn't carry the window, the server sets it. */
export const NEXT_TIMEOUT_MS = (LONG_POLL_DEFAULT_SECONDS + LONG_POLL_SLACK_SECONDS) * 1000;

/** Other endpoints respond immediately, so there is no need for a long wait. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Session labels for worker status in the UI. All are optional and supplied by the model itself. */
export interface WorkerLabels {
    readonly harness: string | undefined;
    readonly model: string | undefined;
    /** Language the agent uses with the reviewer. A hint for the UI locale, not an instruction. */
    readonly lang: Locale | undefined;
}

/** Registers a session as the PR worker (`docs/protocol.md §7`): first skill invocation and every reconnection. */
export async function requestRegister(
    connection: ServerConnection,
    labels: WorkerLabels,
    /** Instruction for the outcome of a local review (`up --local`): null clears the mode, undefined leaves it unchanged. */
    localVerdicts?: string | null,
): Promise<WorkerRegisterResponse> {
    return callWorker<WorkerRegisterRequest, WorkerRegisterResponse>(connection, {
        endpoint: WORKER_ENDPOINTS.register,
        payload: {
            ...(labels.harness === undefined ? {} : { harness: labels.harness }),
            ...(labels.model === undefined ? {} : { model: labels.model }),
            ...(labels.lang === undefined ? {} : { lang: labels.lang }),
            ...(localVerdicts === undefined ? {} : { localVerdicts }),
        },
        requestSchema: workerRegisterRequestSchema,
        responseSchema: workerRegisterResponseSchema,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        role: 'register',
    });
}

/**
 * One long-poll for the next task using the server's window. Uses `node:http`, not `fetch`:
 * see `sendViaHttp`.
 */
export async function requestNext(connection: ServerConnection): Promise<WorkerNextResponse> {
    return callWorker<WorkerNextRequest, WorkerNextResponse>(connection, {
        endpoint: WORKER_ENDPOINTS.next,
        payload: {},
        requestSchema: workerNextRequestSchema,
        responseSchema: workerNextResponseSchema,
        timeoutMs: NEXT_TIMEOUT_MS,
        role: 'worker',
        send: sendViaHttp,
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

/** Shared body fields for all worker requests (`docs/protocol.md §9`). */
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
    /** Call transport. Defaults to `fetch`. Response parsing is independent of it. */
    readonly send?: Transport;
}

/** Raw server response for parsing: success by status code and body as a string. */
interface RawResponse {
    readonly ok: boolean;
    readonly text: string;
}

/** Any network failure becomes `CliError(serverUnavailable)`. Response parsing handles the rest. */
type Transport = (
    connection: ServerConnection,
    endpoint: string,
    body: string,
    timeoutMs: number,
) => Promise<RawResponse>;

/**
 * One worker call: a version handshake in every request body (`docs/protocol.md §9`),
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

    const send = call.send ?? sendViaFetch;
    const response = await send(connection, call.endpoint, JSON.stringify(request.data), call.timeoutMs);

    if (!response.ok) {
        const failure = parseRpcError(response.text);
        throw new RpcCallError(failure.code, formatRpcError(failure, call.role));
    }

    const parsed = call.responseSchema.safeParse(parseJson(response.text));
    if (!parsed.success) {
        throw new CliError(contractMismatch());
    }
    return parsed.data;
}

/** Transport for every endpoint except `next`. They respond immediately, so `fetch` works for them. */
const sendViaFetch: Transport = async (connection, endpoint, body, timeoutMs) => {
    let response: Response;
    try {
        response = await fetch(`http://127.0.0.1:${String(connection.port)}${endpoint}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${connection.token}`,
            },
            body,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch {
        throw new CliError(serverUnavailable(connection.prKey));
    }

    try {
        return { ok: response.ok, text: await response.text() };
    } catch {
        throw new CliError(serverUnavailable(connection.prKey));
    }
};

/**
 * `next` transport using `node:http`. Node's `fetch` uses undici with a 5-minute `headersTimeout`:
 * a response whose headers haven't arrived within that time fails with `UND_ERR_HEADERS_TIMEOUT` regardless
 * of `AbortSignal.timeout` (verified: a 400 s wait aborts at 301 s). The current window is shorter, but
 * leaves little room below that hidden external limit. Here, our own timer sets the deadline.
 */
const sendViaHttp: Transport = (connection, endpoint, body, timeoutMs) =>
    new Promise<RawResponse>((resolve, reject) => {
        let request: http.ClientRequest;
        try {
            request = http.request({
                host: '127.0.0.1',
                port: connection.port,
                path: endpoint,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                    authorization: `Bearer ${connection.token}`,
                },
                // No connection pool. An idle agent socket would keep the process alive after leaving the loop.
                agent: false,
            });
        } catch {
            // Request construction failed (invalid manifest token, such as a forbidden header character):
            // to the caller, the server is just as unavailable as with a socket failure.
            reject(new CliError(serverUnavailable(connection.prKey)));
            return;
        }

        const fail = (): void => {
            clearTimeout(timer);
            request.destroy();
            reject(new CliError(serverUnavailable(connection.prKey)));
        };
        const timer = setTimeout(fail, timeoutMs);

        request.on('error', fail);
        request.on('response', (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('error', fail);
            response.on('end', () => {
                clearTimeout(timer);
                const status = response.statusCode ?? 0;
                resolve({ ok: status >= 200 && status < 300, text: Buffer.concat(chunks).toString('utf8') });
            });
        });
        request.end(body);
    });

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
        'sherpa: the command does not pass the contract, the server would reject it:',
        ...details.map((detail) => `  - ${detail}`),
        'Fix the command arguments (and `SHERPA_WORKER_ID`, if it is set) and call it again.',
    ].join('\n');
}

function contractMismatch(): string {
    return (
        'sherpa: the server replied off-contract — most likely the CLI and the server versions diverged.\n' +
        'Update the Sherpa skill together with the CLI and restart the server.'
    );
}
