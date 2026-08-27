import http from 'node:http';

import { rpcErrorSchema } from '@sherpa/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { Route } from './http.js';
import { createRequestListener } from './http.js';
import { get, postJson } from './test-support.js';

const TOKEN = 'manifest-token';

describe('router: routes assembled at startup', () => {
    let running: { server: http.Server; port: number } | null = null;

    afterEach(async () => {
        const handle = running;
        running = null;
        if (handle !== null) {
            handle.server.closeAllConnections();
            await new Promise<void>((resolve) => {
                handle.server.close(() => {
                    resolve();
                });
            });
        }
    });

    async function listen(routes: readonly Route[], ready: Promise<void>): Promise<number> {
        const server = http.createServer(createRequestListener({ token: TOKEN, routes, ready }));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('test server is not listening on a TCP port');
        }
        running = { server, port: address.port };
        return address.port;
    }

    /**
     * Regression: the manifest is published before worker endpoints, so a call using a fresh manifest
     * can legitimately arrive between publication and route assembly. A 404 at that point
     * falsely reports a missing endpoint, causing the session to treat the server as incompatible.
     */
    it('a call arriving before route assembly waits for routes instead of receiving 404', async () => {
        const routes: Route[] = [healthRoute()];
        let markReady!: () => void;
        const port = await listen(
            routes,
            new Promise<void>((resolve) => {
                markReady = resolve;
            }),
        );

        const pending = postJson(port, '/worker/register', {}, TOKEN);
        await new Promise((resolve) => setTimeout(resolve, 50));
        routes.push({
            method: 'POST',
            path: '/worker/register',
            handle: () => ({ status: 200, body: { kind: 'registered' } }),
        });
        markReady();

        const response = await pending;
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ kind: 'registered' });
    });

    /** `/healthz` exists from the start. A competing process uses it to check liveness and must not wait. */
    it('a route in the initial set responds without waiting for the others to be ready', async () => {
        // The promise never resolves. If `/healthz` waited for it, the test would never receive a response.
        const port = await listen([healthRoute()], neverReady());

        const response = await get(port, '/healthz', TOKEN);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
    });

    it('after readiness, an unknown endpoint returns 404 without waiting', async () => {
        const port = await listen([healthRoute()], Promise.resolve());

        const response = await postJson(port, '/worker/next', {}, TOKEN);

        expect(response.status).toBe(404);
        expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('bad_request');
    });

    it('without a token, an unknown endpoint returns 401 even after readiness', async () => {
        const port = await listen([healthRoute()], Promise.resolve());

        const response = await postJson(port, '/worker/next', {});

        expect(response.status).toBe(401);
        expect(rpcErrorSchema.parse(await response.json()).error.code).toBe('unauthorized');
    });
});

/** Readiness that never arrives, to check that an initial route does not wait for it. */
function neverReady(): Promise<void> {
    return new Promise<void>(() => undefined);
}

function healthRoute(): Route {
    return { method: 'GET', path: '/healthz', handle: () => ({ status: 200, body: { ok: true } }) };
}
