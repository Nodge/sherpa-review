// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { AgentNote, ChatAnchor, ChatExchange, UiChatResponse, UiState } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app.tsx';
import { mergeChatResponse, openExchangeInChatRequest, withoutChatNote } from './app/chat-state.js';
import { createSessionStore } from './session/session-store.js';
import type { Store, StoreSnapshot } from './store.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = fixtureIteration('medium');
const EMPTY_CHAT: UiChatResponse = { exchanges: [], notes: [], chatRevision: 1 };
const NOTE_ANCHOR: ChatAnchor = { diffId: DATA.diff.diffId, fileId: 'file-1', path: 'src/cache.ts', side: 'new', start: 41, end: 43 };
const NOTE: AgentNote = {
    id: 31,
    exchangeId: 7,
    anchor: NOTE_ANCHOR,
    text: 'Agent answer',
    lostAnchor: false,
    origin: { commit: 'abcdef1', anchor: NOTE_ANCHOR },
    createdAt: '2026-09-01T10:01:00.000Z',
};

function exchange(id: number, question: string, overrides: Partial<ChatExchange> = {}): ChatExchange {
    return {
        id,
        question,
        anchor: null,
        status: 'queued',
        taskId: id,
        answer: null,
        progressText: null,
        error: null,
        locale: null,
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:00.000Z',
        ...overrides,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((next, fail) => {
        resolve = next;
        reject = fail;
    });
    return { promise, resolve, reject };
}

interface MountedApp {
    readonly host: HTMLElement;
    readonly chatGetCount: () => number;
    readonly pushChatRevision: (revision: number) => void;
    readonly settle: () => Promise<void>;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
    vi.restoreAllMocks();
});

function mountApp(options: {
    readonly chatGets?: readonly (() => Promise<Response>)[];
    readonly askExchange?: ChatExchange;
} = {}): MountedApp {
    const originalFetch = globalThis.fetch;
    const globals = globalThis as { ResizeObserver?: unknown };
    const originalResizeObserver = globals.ResizeObserver;
    globals.ResizeObserver ??= class {
        observe(): void {
            // jsdom has no layout.
        }
        unobserve(): void {
            // jsdom has no layout.
        }
        disconnect(): void {
            // jsdom has no layout.
        }
    };

    const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    let chatGetCount = 0;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = url.split('?')[0] ?? '';
        switch (path) {
            case UI_ENDPOINTS.reviewDiff:
                return Promise.resolve(json({ diff: DATA.diff }));
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: DATA.threads }));
            case UI_ENDPOINTS.reviewProgress:
                return Promise.resolve(json({ diffId: DATA.diff.diffId, files: [], stops: [], progressRevision: 1 }));
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(
                    json({
                        route: { phase: 'none', smallPr: false, snapshot: null, failure: null },
                        routeRevision: 1,
                    }),
                );
            case UI_ENDPOINTS.reviewChat: {
                const handler = options.chatGets?.[chatGetCount];
                chatGetCount += 1;
                return handler?.() ?? Promise.resolve(json(EMPTY_CHAT));
            }
            case UI_ENDPOINTS.reviewChatAsk:
                if (init?.method !== 'POST' || options.askExchange === undefined) {
                    return Promise.resolve(json({ error: 'unexpected ask' }, 500));
                }
                return Promise.resolve(json({ exchange: options.askExchange }));
            default:
                return Promise.resolve(json({}));
        }
    };

    const state: UiState = {
        prKey: 'fixture/medium',
        worker: {
            kind: 'connected',
            workerId: 'worker-1',
            harness: 'claude-code',
            model: 'opus-5',
            registeredAt: '2026-09-01T09:00:00.000Z',
            lastSeenAt: '2026-09-01T10:00:00.000Z',
        },
        tasks: [],
        reviewHost: 'fixture',
        pr: DATA.pr,
        feedback: { available: false, reason: 'The test feedback channel is unavailable.' },
        iterations: [],
        update: null,
        generationCap: null,
    };
    let snapshot: StoreSnapshot = {
        connection: 'online',
        state,
        error: null,
        progressRevision: 1,
        threadsRevision: 1,
        routeRevision: 1,
        chatRevision: 1,
    };
    const listeners = new Set<() => void>();
    const store: Store = {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getSnapshot: () => snapshot,
        close: () => undefined,
    };
    const pushChatRevision = (revision: number): void => {
        act(() => {
            snapshot = { ...snapshot, chatRevision: revision };
            for (const listener of [...listeners]) {
                listener();
            }
        });
    };

    const session = createSessionStore({
        initial: { view: 'overview', filter: 'all', chatOpen: true },
        viewPinned: true,
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<App store={store} session={session} token="token" />);
    });

    cleanups.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
        globalThis.fetch = originalFetch;
        globals.ResizeObserver = originalResizeObserver;
    });

    const settle = async (): Promise<void> => {
        for (let step = 0; step < 4; step += 1) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        }
    };

    return { host, chatGetCount: () => chatGetCount, pushChatRevision, settle };
}

describe('note and chat integration in App', () => {
    it('opens the panel and builds a target for the linked exchange', () => {
        const session = createSessionStore({ initial: { view: 'diff', filter: 'all' } });

        const request = openExchangeInChatRequest(session, NOTE.exchangeId, 9);

        expect(session.getSnapshot().chatOpen).toBe(true);
        expect(request).toEqual({ id: 9, target: { kind: 'exchange', exchangeId: NOTE.exchangeId } });
    });

    it('does not restore an optimistically deleted note from a stale GET after another revision', () => {
        const local = { exchanges: [exchange(7, 'Question', { status: 'done', answer: 'Answer' })], notes: [NOTE], chatRevision: 1 };
        const optimistic = withoutChatNote(local, NOTE.id);
        const staleServer = { ...local, chatRevision: 2 };
        const pendingDeletions = new Set([NOTE.id]);

        expect(optimistic.notes).toEqual([]);
        expect(mergeChatResponse(staleServer, optimistic, pendingDeletions).notes).toEqual([]);
    });
});

describe('reloading chat history in App', () => {
    it('makes a new GET after the SSE revision increases and ignores an older concurrent response', async () => {
        const oldResponse = deferred<Response>();
        const newResponse = deferred<Response>();
        const mounted = mountApp({
            chatGets: [() => oldResponse.promise, () => newResponse.promise],
        });
        expect(mounted.chatGetCount()).toBe(1);

        mounted.pushChatRevision(2);
        expect(mounted.chatGetCount()).toBe(2);

        newResponse.resolve(
            new Response(
                JSON.stringify({ exchanges: [exchange(2, 'New question')], notes: [], chatRevision: 2 }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        );
        await mounted.settle();
        expect(mounted.host.textContent).toContain('New question');

        oldResponse.resolve(
            new Response(
                JSON.stringify({ exchanges: [exchange(1, 'Outdated question')], notes: [], chatRevision: 1 }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        );
        await mounted.settle();
        expect(mounted.host.textContent).toContain('New question');
        expect(mounted.host.textContent).not.toContain('Outdated question');
    });

    it('keeps an optimistic exchange when reloading a server snapshot that has not caught up', async () => {
        const optimistic = exchange(7, 'Why is there a separate check here?');
        const mounted = mountApp({
            chatGets: [
                () => Promise.resolve(new Response(JSON.stringify(EMPTY_CHAT), { status: 200 })),
                () =>
                    Promise.resolve(
                        new Response(
                            JSON.stringify({ exchanges: [], notes: [], chatRevision: 2 }),
                            { status: 200 },
                        ),
                    ),
            ],
            askExchange: optimistic,
        });
        await mounted.settle();

        const textarea = mounted.host.querySelector<HTMLTextAreaElement>('textarea');
        if (textarea === null) {
            throw new Error('no question field');
        }
        await act(async () => {
            Object.defineProperty(textarea, 'value', {
                configurable: true,
                value: optimistic.question,
                writable: true,
            });
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await Promise.resolve();
        });
        expect(mounted.host.textContent).toContain(optimistic.question);

        mounted.pushChatRevision(2);
        await mounted.settle();
        expect(mounted.chatGetCount()).toBe(2);
        expect(mounted.host.textContent).toContain(optimistic.question);
    });

    it('passes the initial history loading error to the panel', async () => {
        const mounted = mountApp({
            chatGets: [
                () =>
                    Promise.resolve(
                        new Response(JSON.stringify({ error: { code: 'internal', message: 'History is temporarily unavailable' } }), {
                            status: 500,
                            headers: { 'content-type': 'application/json' },
                        }),
                    ),
            ],
        });
        await mounted.settle();

        expect(mounted.host.querySelector('[role="alert"]')?.textContent).toContain(
            'Could not load the chat history: History is temporarily unavailable',
        );
        expect(mounted.host.textContent).not.toContain('Ask about the PR');
    });
});
