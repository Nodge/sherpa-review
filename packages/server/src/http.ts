import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

import type { RpcError, RpcErrorCode } from '@sherpa/protocol';

import { extractBearerToken, tokenMatches } from './auth.js';
import { RpcFailure } from './errors.js';
import type { StaticAssets } from './static.js';
import { isStaticPath, serveStatic } from './static.js';

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

/** An endpoint that writes its own response (SSE). The router sends nothing after it. */
export type StreamHandler = (ctx: StreamContext) => void | Promise<void>;

export interface StreamContext extends RequestContext {
    readonly res: ServerResponse;
}

/**
 * Endpoint authentication policy. All API endpoints require a token (rpc-design §8).
 * `bearer-or-query` is an exception for SSE because EventSource cannot set headers, so the token
 * arrives as a `?token=` parameter (the server listens only on localhost, decision log).
 */
export type RouteAuth = 'bearer' | 'bearer-or-query';

interface RouteBase {
    readonly method: string;
    readonly path: string;
    /** Defaults to `bearer`. */
    readonly auth?: RouteAuth;
}

export interface JsonRoute extends RouteBase {
    readonly handle: RouteHandler;
}

export interface StreamRoute extends RouteBase {
    readonly stream: StreamHandler;
}

export type Route = JsonRoute | StreamRoute;

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

export interface RequestListenerOptions {
    readonly token: string;
    readonly routes: readonly Route[];
    /** UI static asset source. When set, the server serves it without a token (see `serveStatic`). */
    readonly assets?: StaticAssets;
}

/**
 * A small router on top of node:http. Matches the method and path exactly, then applies
 * authentication of the matched route (all API endpoints require a token, rpc-design §8).
 * Requests that match no route go to UI static assets (no token required because they contain no secrets,
 * and the token reaches the browser in the URL fragment, which never reaches the server).
 */
export function createRequestListener(options: RequestListenerOptions): RequestListener {
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

async function handle(req: IncomingMessage, res: ServerResponse, options: RequestListenerOptions): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = options.routes.find((item) => item.method === req.method && item.path === url.pathname);

    if (route === undefined) {
        if (options.assets !== undefined && req.method === 'GET' && isStaticPath(url.pathname)) {
            if (!(await serveStatic(res, options.assets, url.pathname))) {
                sendJson(res, {
                    status: 404,
                    body: rpcError('bad_request', `UI file ${url.pathname} is not in the build.`),
                });
            }
            return;
        }
        // This order is intentional. An unrelated process without a token must not use response codes
        // to discover which endpoints the server has.
        if (!authorized(options.token, req, url, 'bearer')) {
            sendJson(res, unauthorizedResponse());
            return;
        }
        sendJson(res, {
            status: 404,
            body: rpcError('bad_request', `Unknown endpoint: ${req.method ?? 'GET'} ${url.pathname}.`),
        });
        return;
    }

    if (!authorized(options.token, req, url, route.auth ?? 'bearer')) {
        sendJson(res, unauthorizedResponse());
        return;
    }

    if ('stream' in route) {
        await route.stream({ req, url, res });
        return;
    }
    sendJson(res, await route.handle({ req, url }));
}

function authorized(token: string, req: IncomingMessage, url: URL, auth: RouteAuth): boolean {
    if (tokenMatches(token, extractBearerToken(req.headers.authorization))) {
        return true;
    }
    return auth === 'bearer-or-query' && tokenMatches(token, url.searchParams.get('token'));
}

function unauthorizedResponse(): JsonResponse {
    return {
        status: 401,
        body: rpcError('unauthorized', 'An `Authorization: Bearer <token>` header with the manifest token is required.'),
    };
}

/**
 * Signals that there is nobody left to wait for: the client disconnected or the server is stopping. Used by
 * long-running endpoints, the long-poll `next` and the UI SSE channel.
 * Watches the socket for disconnects because the request body has already been read by the time waiting starts,
 * and `close` on `IncomingMessage` itself no longer fires when the connection breaks.
 */
export function abortOnDisconnect(
    req: IncomingMessage,
    shutdownSignal: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const abort = (): void => {
        controller.abort();
    };

    const socket = req.socket;
    if (shutdownSignal.aborted || socket.destroyed) {
        abort();
    }
    shutdownSignal.addEventListener('abort', abort);
    socket.on('close', abort);

    return {
        signal: controller.signal,
        dispose: () => {
            shutdownSignal.removeEventListener('abort', abort);
            socket.off('close', abort);
        },
    };
}

export function sendJson(res: ServerResponse, response: JsonResponse): void {
    // Long-poll may have unblocked after the connection closed (including during server shutdown).
    if (res.writableEnded || res.destroyed) {
        return;
    }

    // Headers have already been sent, so a streaming endpoint failed partway through its response.
    // A second writeHead would throw ERR_HTTP_HEADERS_SENT inside the router error handler,
    // leaving closing the connection as the only option.
    if (res.headersSent) {
        res.end();
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
