import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

import type { RpcError, RpcErrorCode } from '@sherpa/protocol';

import { extractBearerToken, tokenMatches } from './auth.js';
import { RpcFailure } from './errors.js';
import type { ActivityTracker } from './idle.js';
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
    not_found: 404,
    lease_not_held: 409,
    worker_conflict: 409,
    result_too_large: 413,
    no_review_host: 404,
    host_unavailable: 502,
    internal: 500,
};

export interface JsonResponse {
    readonly status: number;
    readonly body: unknown;
}

export interface RequestContext {
    readonly req: IncomingMessage;
    readonly url: URL;
    /**
     * Subscribes to this response connection closing. For a regular request, this is just after sending,
     * for SSE and long-poll, it is a disconnect or the end of the stream. Endpoints use it to count open connections.
     * Calls the listener immediately if the connection is already closed.
     */
    readonly onClose: (listener: () => void) => void;
}

export type RouteHandler = (ctx: RequestContext) => JsonResponse | Promise<JsonResponse>;

/** An endpoint that writes its own response (SSE). The router sends nothing after it. */
export type StreamHandler = (ctx: StreamContext) => void | Promise<void>;

export interface StreamContext extends RequestContext {
    readonly res: ServerResponse;
}

/**
 * Endpoint authentication policy. All API endpoints require a token (docs/protocol.md §8).
 * `bearer-or-query` is an exception for SSE because EventSource cannot set headers, so the token
 * arrives in the `?token=` parameter (the server listens only on localhost).
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
        throw new RpcFailure('bad_request', 'Empty request body: a JSON object is expected.');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'cannot be parsed';
        throw new RpcFailure('bad_request', `The request body is not JSON: ${message}`);
    }
    return parsed;
}

/**
 * The same, but an empty body is valid input and returns `null`. Used by endpoints where all fields
 * are optional (`route/generate`: an old client sends POST with no body at all).
 */
export async function readOptionalJsonBody(
    req: IncomingMessage,
    maxBytes = REQUEST_BODY_MAX_BYTES,
): Promise<unknown> {
    const raw = await readBody(req, maxBytes);
    if (raw.trim() === '') {
        return null;
    }

    try {
        return JSON.parse(raw);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'cannot be parsed';
        throw new RpcFailure('bad_request', `The request body is not JSON: ${message}`);
    }
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
                    `The request body is larger than ${String(maxBytes)} bytes — the server does not accept that much.`,
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
    /** Tracks activity for shutdown on idle. A single point for the entire HTTP layer. */
    readonly activity?: ActivityTracker;
    /**
     * Resolves when `routes` is fully assembled. Until then, the set contains only `/healthz`, so a request
     * that matches no route waits for this moment and tries again. The manifest is published
     * before the other endpoints, so an immediate call would otherwise receive 404 for an existing endpoint.
     * `/healthz` must not wait. It exists from the start and a competing process uses it to check liveness.
     */
    readonly ready?: Promise<void>;
}

/**
 * A small router on top of node:http. Matches the method and path exactly, then applies
 * the matched route authentication policy (all API endpoints require a token, docs/protocol.md §8).
 * Requests that match no route go to UI static assets (no token required because they contain no secrets,
 * and the token reaches the browser in the URL fragment, which never reaches the server).
 */
export function createRequestListener(options: RequestListenerOptions): RequestListener {
    return (req, res) => {
        // A connection is open until its response closes. For a regular request, this is a moment,
        // for SSE and long-poll, it lasts as long as the stream.
        const connectionClosed = options.activity?.open();
        if (connectionClosed !== undefined) {
            res.once('close', connectionClosed);
        }

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
    options: RequestListenerOptions,
): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let route = findRoute(options.routes, req.method, url.pathname);

    if (route === undefined && options.ready !== undefined) {
        await options.ready;
        route = findRoute(options.routes, req.method, url.pathname);
    }

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

    const onClose = (listener: () => void): void => {
        if (res.closed || res.destroyed) {
            listener();
            return;
        }
        res.once('close', listener);
    };

    if ('stream' in route) {
        await route.stream({ req, url, res, onClose });
        return;
    }
    sendJson(res, await route.handle({ req, url, onClose }));
}

function findRoute(routes: readonly Route[], method: string | undefined, pathname: string): Route | undefined {
    return routes.find((item) => item.method === method && item.path === pathname);
}

function authorized(expected: string, req: IncomingMessage, url: URL, auth: RouteAuth): boolean {
    const provided = [extractBearerToken(req.headers.authorization)];
    if (auth === 'bearer-or-query') {
        provided.push(url.searchParams.get('token'));
    }
    return provided.some((token) => tokenMatches(expected, token));
}

function unauthorizedResponse(): JsonResponse {
    return {
        status: 401,
        body: rpcError(
            'unauthorized',
            'An `Authorization: Bearer <token>` header with the token from the manifest is required.',
        ),
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
