// @vitest-environment jsdom
import { chatFixtures, fixtureIteration } from '@sherpa/fixtures';
import type { AgentNote, UiChatResponse, UiRouteState, UiState } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app.tsx';
import type { SessionStore } from './session/session-store.js';
import { createSessionStore } from './session/session-store.js';
import type { ViewId } from './session/views.js';
import type { Store, StoreSnapshot } from './store.js';

/**
 * Notes that lose their anchors after a push: the priority-120 banner opens chat at the note
 * with the lost anchor. The exchange chip names its last valid location.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = function noopScrollIntoView(): void {
    // jsdom has no scrolling.
};

const V2 = fixtureIteration('medium', 1);
const CHAT = chatFixtures('medium');
const NOTES: readonly AgentNote[] = CHAT?.notesAfterPush ?? [];
const LOST = NOTES.find((note) => note.lostAnchor);

const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
    vi.restoreAllMocks();
});

interface Mounted {
    readonly host: HTMLElement;
    readonly session: SessionStore;
    readonly settle: () => Promise<void>;
}

function mountApp(options: { readonly notes?: readonly AgentNote[]; readonly view?: ViewId } = {}): Mounted {
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

    const chat: UiChatResponse = {
        exchanges: [...(CHAT?.exchanges ?? [])],
        notes: [...(options.notes ?? NOTES)],
        chatRevision: 1,
    };
    const route: UiRouteState = {
        phase: 'none',
        smallPr: false,
        snapshot: null,
        failure: null,
        stale: null,
    };
    const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        switch (url.split('?')[0] ?? '') {
            case UI_ENDPOINTS.reviewDiff:
                return Promise.resolve(json({ diff: V2.diff }));
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: V2.ownership, extra: V2.extraLenses }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: V2.threads }));
            case UI_ENDPOINTS.reviewProgress:
                return Promise.resolve(json({ files: [], stops: [], progressRevision: 1 }));
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(json({ route, routeRevision: 1 }));
            case UI_ENDPOINTS.reviewChat:
                return Promise.resolve(json(chat));
            default:
                return Promise.resolve(json({}));
        }
    };

    const state: UiState = {
        prKey: 'fixture/medium',
        worker: { kind: 'never' },
        tasks: [],
        reviewHost: 'fixture',
        pr: V2.pr,
        feedback: { available: false, reason: 'The test feedback channel is unavailable.' },
        iterations: [{ ...V2.iteration, status: 'active' }],
        update: null,
        generationCap: null,
    };
    const snapshot: StoreSnapshot = {
        connection: 'online',
        state,
        error: null,
        progressRevision: 1,
        threadsRevision: 1,
        routeRevision: 1,
        chatRevision: 1,
    };
    const store: Store = {
        subscribe: () => () => undefined,
        getSnapshot: () => snapshot,
        close: () => undefined,
    };

    const session = createSessionStore({
        initial: { view: options.view ?? 'overview', filter: 'all' },
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

    return { host, session, settle };
}

function buttonWith(host: HTMLElement, text: string): HTMLButtonElement | undefined {
    return [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        button.textContent.includes(text),
    );
}

describe('notification about notes without anchors', () => {
    it('shows the count of notes with lost anchors, including outside the route tab', async () => {
        const mounted = mountApp();
        await mounted.settle();

        expect(mounted.host.textContent).toContain('1 note lost its anchor after the new push');
    });

    it('shows no banner when no notes have lost anchors', async () => {
        const mounted = mountApp({ notes: NOTES.filter((note) => !note.lostAnchor) });
        await mounted.settle();

        expect(mounted.host.textContent).not.toContain('lost its anchor after the new push');
    });

    it('"Show" opens chat at the note with the lost anchor and its exchange', async () => {
        const mounted = mountApp();
        await mounted.settle();
        expect(mounted.session.getSnapshot().chatOpen).toBe(false);

        await act(async () => {
            buttonWith(mounted.host, 'View')?.click();
            await Promise.resolve();
        });
        await mounted.settle();

        expect(mounted.session.getSnapshot().chatOpen).toBe(true);
        const exchange = mounted.host.querySelector(`[data-exchange="${String(LOST?.exchangeId ?? 0)}"]`);
        expect(exchange?.textContent).toContain('anchor lost after the push');
        // There is nowhere to navigate from chat to code. The note is absent in the active iteration.
        const pin = exchange?.querySelector<HTMLButtonElement>('.chat-message__note');
        expect(pin?.disabled).toBe(true);
        expect(pin?.title).toBe('anchor lost — the note has no code in this iteration');
    });

    it('dismisses the banner for this tab session with the close button', async () => {
        const mounted = mountApp();
        await mounted.settle();

        await act(async () => {
            mounted.host
                .querySelector<HTMLButtonElement>('[aria-label="Hide the lost-notes banner"]')
                ?.click();
            await Promise.resolve();
        });

        expect(mounted.host.textContent).not.toContain('lost its anchor after the new push');
    });
});
