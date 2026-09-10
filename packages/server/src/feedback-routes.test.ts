import { makeFixtureHost } from '@sherpa/fixtures';
import {
    PROTOCOL_VERSION,
    rpcErrorSchema,
    UI_ENDPOINTS,
    uiFeedbackResponseSchema,
    uiStateSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { makeTempSherpaDir, postJson, removeTempSherpaDir, get } from './test-support.js';
import { SERVER_VERSION } from './version.js';

const PR_KEY = 'fixture-medium';


describe('feedback channel', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
    });

    afterEach(async () => {
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    async function start(
        options: Parameters<typeof startServer>[0]['feedback'] = {},
        currentUser: () => string | null | Promise<string | null> = () => 'alice',
    ): Promise<SherpaServer> {
        const host = makeFixtureHost('medium');
        const server = await startServer({
            prKey: PR_KEY,
            sherpaDir,
            idleSeconds: 0,
            reviewHostFactory: () => ({ name: 'fixture', host, currentUser }),
            feedback: {
                env: { SHERPA_ISSUE_TOKEN: ISSUE_TOKEN },
                retryBaseMs: 0,
                sleep: () => Promise.resolve(),
                random: () => 0,
                ...options,
            },
        });
        servers.push(server);
        return server;
    }

    it('creates a subissue with the full automatic context', async () => {
        const requests: { url: string; init: RequestInit | undefined }[] = [];
        const server = await start({
            fetch: (url, init) => {
                requests.push({ url, init });
                return Promise.resolve(new Response(JSON.stringify({ key: '#123456' }), { status: 201 }));
            },
        });
        server.workerRegistry.register('w-feedback', 'claude-code', 'claude-opus-5');

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            {
                text: 'Publication status is not visible\nProblem details.',
                includeContext: true,
                context: { view: 'overview', routePhase: 'ready', uiVersion: '0.6.0' },
            },
            server.token,
        );

        expect(response.status).toBe(200);
        expect(uiFeedbackResponseSchema.parse(await response.json())).toEqual({
            outcome: 'created',
            issueKey: '#123456',
            issueUrl: 'https://github.com/quillmart/quillmart/issues/123456',
            message: null,
        });
        expect(requests).toHaveLength(1);
        
        expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe(`Bearer ${ISSUE_TOKEN}`);
        const body = jsonRequestBody(requests[0]?.init) as Record<string, string>;
        expect(body).toMatchObject({
            queue: 'SHERPA',
            summary: 'Publication status is not visible',
        });
        expect(body).not.toHaveProperty('parent');
        expect(body.description).toContain('Publication status is not visible\nProblem details.');
        expect(body.description).toContain(`Version: UI 0.6.0, server ${SERVER_VERSION}, protocol ${PROTOCOL_VERSION}`);
        expect(body.description).toContain('PR: fixture-medium');
        expect(body.description).toContain('View: overview');
        expect(body.description).toContain('Route phase: ready');
        expect(body.description).toContain('claude-code · claude-opus-5 · connected');
        expect(body.description).toContain('User: alice');
    });

    it('sends text as is without context and does not request the login', async () => {
        const currentUser = vi.fn(() => 'alice');
        let description = '';
        const server = await start(
            {
                fetch: (_url, init) => {
                    description = (jsonRequestBody(init) as { description: string }).description;
                    return Promise.resolve(new Response(JSON.stringify({ key: '#2' }), { status: 201 }));
                },
            },
            currentUser,
        );

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'Text without context', includeContext: false, context: null },
            server.token,
        );

        expect(response.status).toBe(200);
        expect(description).toBe('Text without context');
        expect(currentUser).not.toHaveBeenCalled();
    });

    it('without credentials reports reduced functionality in the snapshot and endpoint, does not call fetch', async () => {
        const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
            Promise.resolve(new Response(JSON.stringify({ key: 'FB-unexpected' }), { status: 201 })),
        );
        const server = await start({ env: {}, fetch: fetchMock });

        const state = uiStateSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.state, server.token)).json(),
        );
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'Keep this text', includeContext: true, context: { view: 'diff', routePhase: 'none', uiVersion: '0.6.0' } },
            server.token,
        );

        expect(state.feedback.available).toBe(false);
        
        expect(state.feedback.reason).toContain('project issues');
        expect(uiFeedbackResponseSchema.parse(await response.json())).toEqual({
            outcome: 'unavailable',
            issueKey: null,
            issueUrl: null,
            message: state.feedback.reason,
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    
        const requests: RequestInit[] = [];
        const server = await start({
            env: {},
            
            fetch: (_url, init) => {
                requests.push(init ?? {});
                
            },
        });

        const state = uiStateSchema.parse(
            await (await get(server.port, UI_ENDPOINTS.state, server.token)).json(),
        );
        expect(state.feedback).toEqual({ available: true, reason: null });

        for (const text of ['First', 'Second']) {
            const response = await postJson(
                server.port,
                UI_ENDPOINTS.feedback,
                { text, includeContext: false, context: null },
                server.token,
            );
            expect(response.status).toBe(200);
            expect(uiFeedbackResponseSchema.parse(await response.json()).outcome).toBe('created');
        }

        
        expect(requests.map((init) => new Headers(init.headers).get('authorization'))).toEqual([
        ]);
    });

    
        const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
            Promise.resolve(new Response(JSON.stringify({ key: 'FB-unexpected' }), { status: 201 })),
        );
        const server = await start({
            env: {},
            
            
            fetch: fetchMock,
        });

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'Keep this text', includeContext: false, context: null },
            server.token,
        );

        expect(response.status).toBe(200);
        const body = uiFeedbackResponseSchema.parse(await response.json());
        expect(body.outcome).toBe('unavailable');
        
        expect(body.message).toContain('project issues');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns host_unavailable after three 503 responses', async () => {
        const fetchMock = vi.fn(() =>
            Promise.resolve(new Response('temporary', { status: 503, statusText: 'Service Unavailable' })),
        );
        const server = await start({ fetch: fetchMock, retryAttempts: 3 });

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'Retry later', includeContext: false, context: null },
            server.token,
        );

        expect(response.status).toBe(502);
        const error = rpcErrorSchema.parse(await response.json());
        expect(error.error.code).toBe('host_unavailable');
        expect(error.error.message).toContain('Your text has been saved');
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not retry network errors: retries only for 429 and 5xx', async () => {
        const fetchMock = vi.fn(() => Promise.reject(new Error('connection refused')));
        const server = await start({ fetch: fetchMock, retryAttempts: 3 });

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'Retry manually', includeContext: false, context: null },
            server.token,
        );

        expect(response.status).toBe(502);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('checks required fields and the text limit before calling the issue service', async () => {
        const fetchMock = vi.fn(() =>
            Promise.resolve(new Response(JSON.stringify({ key: '#3' }), { status: 201 })),
        );
        const server = await start({ fetch: fetchMock });

        const empty = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: '', includeContext: true, context: { view: 'route', routePhase: 'ready', uiVersion: '0.6.0' } },
            server.token,
        );
        const tooLong = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'x'.repeat(20_001), includeContext: false, context: null },
            server.token,
        );
        const badContext = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'ok', includeContext: true, context: { view: '', routePhase: 'unknown', uiVersion: '0.6.0' } },
            server.token,
        );

        expect(empty.status).toBe(400);
        expect(tooLong.status).toBe(400);
        expect(badContext.status).toBe(400);
        expect((await empty.json() as { error: { details?: string[] } }).error.details?.[0]).toContain('text:');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

function jsonRequestBody(init: RequestInit | undefined): unknown {
    if (typeof init?.body !== 'string') {
        throw new Error('test expected a string JSON body');
    }
    return JSON.parse(init.body) as unknown;
}
