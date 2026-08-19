import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

import type { RpcError, RpcErrorCode } from '@sherpa/protocol';

import { extractBearerToken, tokenMatches } from './auth.js';
import { RpcFailure } from './errors.js';

/**
 * Request body limit. Set above the result limit (`RESULT_MAX_BYTES`) so a moderate
 * excess reaches the queue and fails the task instead of being rejected as a malformed request.
 */
export const REQUEST_BODY_MAX_BYTES = 1024 * 1024;

/** HTTP status by contract error code. This is the only place that maps the two. */
const HTTP_STATUS_BY_CODE: Record<RpcErrorCode, number> = {
    unauthorized: 401,
    version_incompatible: 409,
    bad_request: 400,
    unknown_task: 404,
    lease_not_held: 409,
    worker_conflict: 409,
    result_too_large: 413,
    internal: 500,
};

export interface JsonResponse {
    readonly status: number;
    readonly body: unknown;
}

export interface RequestContext {
    readonly req: IncomingMessage;
    readonly url: URL;
}

export type RouteHandler = (ctx: RequestContext) => JsonResponse | Promise<JsonResponse>;

export interface Route {
    readonly method: string;
    readonly path: string;
    readonly handle: RouteHandler;
}

/** Error body in contract format (`rpcErrorSchema`), read by both the CLI and UI. */
export function rpcError(code: RpcErrorCode, message: string, details?: readonly string[]): RpcError {
    return { error: details === undefined ? { code, message } : { code, message, details: [...details] } };
}

/** Domain error response with a contract body and a status matching the code. */
export function rpcFailureResponse(failure: RpcFailure): JsonResponse {
    return {
        status: HTTP_STATUS_BY_CODE[failure.code],
        body: rpcError(failure.code, failure.message, failure.details),
    };
}

/** Wraps an endpoint. Domain `RpcFailure` errors return a contract body, all others return 500. */
export function handlingRpcFailures(handle: RouteHandler): RouteHandler {
    return async (ctx) => {
        try {
            return await handle(ctx);
        } catch (error) {
            if (error instanceof RpcFailure) {
                return rpcFailureResponse(error);
            }
            throw error;
        }
    };
}

/**
 * Reads a JSON request body with a size limit. Malformed JSON, an empty body and an exceeded limit return
 * `bad_request` with a readable message that the model will see in CLI output.
 */
export async function readJsonBody(req: IncomingMessage, maxBytes = REQUEST_BODY_MAX_BYTES): Promise<unknown> {
    const raw = await readBody(req, maxBytes);
    if (raw.trim() === '') {
        throw new RpcFailure('bad_request', 'Empty request body: expected a JSON object.');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'cannot parse';
        throw new RpcFailure('bad_request', `Request body is not JSON: ${message}`);
    }
    return parsed;
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;

        const onData = (chunk: Buffer): void => {
            size += chunk.byteLength;
            if (size <= maxBytes) {
                chunks.push(chunk);
                return;
            }

            // Keep the socket open so the client gets a clear 400 instead of EPIPE while sending the body.
            // Drain the rest of the body so the connection can deliver the response.
            req.off('data', onData);
            req.resume();
            reject(
                new RpcFailure(
                    'bad_request',
                    `Request body exceeds ${String(maxBytes)} bytes, the server does not accept that much.`,
                ),
            );
        };

        req.on('data', onData);
        req.once('end', () => {
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        req.once('error', reject);
    });
}

/**
 * Minimal router on node:http: bearer authentication before routing
 * (every endpoint requires a token, rpc-design §8), then an exact method and path match.
 */
export function createRequestListener(options: { token: string; routes: readonly Route[] }): RequestListener {
    return (req, res) => {
        void handle(req, res, options).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : 'unknown error';
            sendJson(res, {
                status: 500,
                body: rpcError('internal', `Internal server error: ${message}`),
            });
        });
    };
}

async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    options: { token: string; routes: readonly Route[] },
): Promise<void> {
    if (!tokenMatches(options.token, extractBearerToken(req.headers.authorization))) {
        sendJson(res, {
            status: 401,
            body: rpcError('unauthorized', 'An `Authorization: Bearer <token>` header with the token from the manifest is required.'),
        });
        return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = options.routes.find((item) => item.method === req.method && item.path === url.pathname);
    if (route === undefined) {
        sendJson(res, {
            status: 404,
            body: rpcError('bad_request', `Unknown endpoint: ${req.method ?? 'GET'} ${url.pathname}.`),
        });
        return;
    }

    sendJson(res, await route.handle({ req, url }));
}

export function sendJson(res: ServerResponse, response: JsonResponse): void {
    // Long-poll may have unblocked after the connection closed (including during server shutdown).
    if (res.writableEnded || res.destroyed) {
        return;
    }

    const payload = JSON.stringify(response.body);
    res.writeHead(response.status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(payload)),
        'cache-control': 'no-store',
    });
    res.end(payload);
}
