import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

import type { RpcError, RpcErrorCode } from '@sherpa/protocol';

import { extractBearerToken, tokenMatches } from './auth.js';

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
    const payload = JSON.stringify(response.body);
    res.writeHead(response.status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(payload)),
        'cache-control': 'no-store',
    });
    res.end(payload);
}
