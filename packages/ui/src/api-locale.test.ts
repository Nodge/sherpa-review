import { UI_ENDPOINTS } from '@sherpa/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { askReviewChat, generateReviewRoute } from './api.js';

/** Generation language (M5-T4) goes to the server in the request body. The tab knows it, the server does not. */

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});

function mockJson(payload: unknown): ReturnType<typeof vi.fn> {
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(
            new Response(JSON.stringify(payload), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        ),
    );
    globalThis.fetch = fetch;
    return fetch;
}

function bodyOf(fetch: ReturnType<typeof vi.fn>): unknown {
    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = init?.body;
    return JSON.parse(typeof body === 'string' ? body : 'null');
}

describe('locale in UI API requests', () => {
    it('sends the tab locale in the route generation request body', async () => {
        const fetch = mockJson({ outcome: 'started' });

        expect(await generateReviewRoute('token', 'en')).toBe('started');
        expect(fetch.mock.calls[0]?.[0]).toBe(UI_ENDPOINTS.reviewRouteGenerate);
        expect(bodyOf(fetch)).toEqual({ locale: 'en' });
    });

    it('includes text and locale in a chat question without an anchor', async () => {
        const fetch = mockJson({
            exchange: {
                id: 1,
                question: 'Why?',
                anchor: null,
                status: 'queued',
                taskId: 7,
                answer: null,
                progressText: null,
                error: null,
                locale: 'en',
                createdAt: '2026-09-04T10:00:00.000Z',
                updatedAt: '2026-09-04T10:00:00.000Z',
            },
        });

        const exchange = await askReviewChat('token', 'Why?', undefined, 'en');

        expect(exchange.locale).toBe('en');
        expect(bodyOf(fetch)).toEqual({ text: 'Why?', locale: 'en' });
    });

    it('adds an anchor for a selection question and keeps the locale', async () => {
        const anchor = { fileId: 'f1', path: 'src/main.ts', side: 'new', start: 10, end: 12 } as const;
        const fetch = mockJson({
            exchange: {
                id: 2,
                question: 'Why?',
                anchor: { ...anchor, diffId: 'iter-1' },
                status: 'queued',
                taskId: 8,
                answer: null,
                progressText: null,
                error: null,
                locale: 'ru',
                createdAt: '2026-09-04T10:00:00.000Z',
                updatedAt: '2026-09-04T10:00:00.000Z',
            },
        });

        await askReviewChat('token', 'Why?', anchor, 'ru');

        expect(bodyOf(fetch)).toEqual({ text: 'Why?', locale: 'ru', anchor });
    });
});
