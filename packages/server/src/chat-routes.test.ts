import http from 'node:http';

import type { ChatExchange, RpcError, UiChatAskAnchor } from '@sherpa/protocol';
import { rpcErrorSchema, UI_ENDPOINTS } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatOrchestrator } from './chat-orchestrator.js';
import { createChatRoutes } from './chat-routes.js';
import type { ChatStore } from './chat-store.js';
import { createRequestListener } from './http.js';
import { get, postJson, postRaw } from './test-support.js';

/**
 * Chat endpoints at the handler level. The store and orchestrator are stubs. Tests check the endpoint
 * contract (body validation, orchestrator input, response shape), not chat behaviour.
 */

const TOKEN = 'chat-routes-token';

const EXCHANGE: ChatExchange = {
    id: 1,
    question: 'what is happening here',
    anchor: null,
    status: 'queued',
    taskId: null,
    answer: null,
    progressText: null,
    error: null,
    locale: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
};

describe('chat endpoints', () => {
    let server: http.Server | null;
    let port: number;
    let ask: ReturnType<typeof vi.fn>;
    let cancel: ReturnType<typeof vi.fn>;
    let retry: ReturnType<typeof vi.fn>;
    let deleteNote: ReturnType<typeof vi.fn>;
    let read: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        ask = vi.fn(() => Promise.resolve(EXCHANGE));
        cancel = vi.fn(() => 'cancelled');
        retry = vi.fn(() => Promise.resolve('retried'));
        deleteNote = vi.fn();
        read = vi.fn(() => ({ exchanges: [EXCHANGE], notes: [], chatRevision: 7 }));

        const store = { read, deleteNote } as unknown as ChatStore;
        const orchestrator = { ask, cancel, retry } as unknown as ChatOrchestrator;
        const routes = createChatRoutes({ store, orchestrator });

        const listener = http.createServer(createRequestListener({ token: TOKEN, routes }));
        await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
        const address = listener.address();
        if (address === null || typeof address === 'string') {
            throw new Error('test server is not listening on a TCP port');
        }
        server = listener;
        port = address.port;
    });

    afterEach(async () => {
        const handle = server;
        server = null;
        if (handle !== null) {
            handle.closeAllConnections();
            await new Promise<void>((resolve) => {
                handle.close(() => {
                    resolve();
                });
            });
        }
    });

    async function errorOf(response: Response): Promise<RpcError['error']> {
        return rpcErrorSchema.parse(await response.json()).error;
    }

    it('declares all five chat endpoints at their contract paths', () => {
        const routes = createChatRoutes({
            store: { read, deleteNote } as unknown as ChatStore,
            orchestrator: { ask, cancel, retry } as unknown as ChatOrchestrator,
        });

        expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
            `GET ${UI_ENDPOINTS.reviewChat}`,
            `POST ${UI_ENDPOINTS.reviewChatAsk}`,
            `POST ${UI_ENDPOINTS.reviewChatCancel}`,
            `POST ${UI_ENDPOINTS.reviewChatRetry}`,
            `POST ${UI_ENDPOINTS.reviewChatNoteDelete}`,
        ]);
    });

    it('gets chat history from the store', async () => {
        const response = await get(port, UI_ENDPOINTS.reviewChat, TOKEN);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ chatRevision: 7 });
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('returns 400 with the field path in details for a body that violates the contract', async () => {
        const response = await postJson(port, UI_ENDPOINTS.reviewChatAsk, {}, TOKEN);

        expect(response.status).toBe(400);
        const error = await errorOf(response);
        expect(error.code).toBe('bad_request');
        expect(error.details?.[0]).toContain('text: ');
        expect(ask).not.toHaveBeenCalled();
    });

    it('reports a root validation error without a path or leading colon', async () => {
        const response = await postJson(port, UI_ENDPOINTS.reviewChatAsk, 'string', TOKEN);

        expect(response.status).toBe(400);
        const detail = (await errorOf(response)).details?.[0] ?? '';
        expect(detail).toContain('expected object');
        expect(detail.startsWith(':')).toBe(false);
    });

    it('returns bad_request for malformed JSON instead of 500', async () => {
        const response = await postRaw(port, UI_ENDPOINTS.reviewChatAsk, '{"text": ', TOKEN);

        expect(response.status).toBe(400);
        expect((await errorOf(response)).code).toBe('bad_request');
        expect(ask).not.toHaveBeenCalled();
    });

    it('passes an absent anchor to the orchestrator as null', async () => {
        const response = await postJson(port, UI_ENDPOINTS.reviewChatAsk, { text: 'question' }, TOKEN);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ exchange: EXCHANGE });
        expect(ask.mock.calls[0]).toEqual(['question', null, undefined]);
    });

    it('rejects an explicit null anchor because the field is optional but not nullable', async () => {
        const response = await postJson(port, UI_ENDPOINTS.reviewChatAsk, { text: 'question', anchor: null }, TOKEN);

        expect(response.status).toBe(400);
        expect((await errorOf(response)).details?.[0]).toContain('anchor: ');
        expect(ask).not.toHaveBeenCalled();
    });

    it('passes the specified anchor and locale to the orchestrator unchanged', async () => {
        const anchor: UiChatAskAnchor = {
            fileId: 'file-1',
            path: 'src/index.ts',
            side: 'new',
            start: 10,
            end: 12,
        };

        const response = await postJson(
            port,
            UI_ENDPOINTS.reviewChatAsk,
            { text: 'question', anchor, locale: 'en' },
            TOKEN,
        );

        expect(response.status).toBe(200);
        expect(ask.mock.calls[0]).toEqual(['question', anchor, 'en']);
    });

    it('returns the orchestrator outcome for cancellation and retry', async () => {
        const cancelled = await postJson(port, UI_ENDPOINTS.reviewChatCancel, { exchangeId: 5 }, TOKEN);
        const retried = await postJson(port, UI_ENDPOINTS.reviewChatRetry, { exchangeId: 5 }, TOKEN);

        expect(await cancelled.json()).toEqual({ outcome: 'cancelled' });
        expect(await retried.json()).toEqual({ outcome: 'retried' });
        expect(cancel).toHaveBeenCalledWith(5);
        expect(retry).toHaveBeenCalledWith(5);
    });

    it('confirms note deletion and calls the store exactly once', async () => {
        const response = await postJson(port, UI_ENDPOINTS.reviewChatNoteDelete, { noteId: 3 }, TOKEN);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ acknowledged: true });
        expect(deleteNote.mock.calls).toEqual([[3]]);
    });

    it('does not pass an invalid noteId to the store', async () => {
        const response = await postJson(port, UI_ENDPOINTS.reviewChatNoteDelete, { noteId: 0 }, TOKEN);

        expect(response.status).toBe(400);
        expect((await errorOf(response)).details?.[0]).toContain('noteId: ');
        expect(deleteNote).not.toHaveBeenCalled();
    });
});
