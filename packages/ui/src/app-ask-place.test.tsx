// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { UiState } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './app.tsx';
import type { DiffParseMessage, DiffParseReply } from './diff/client.js';
import { parseFileDiff } from './diff/parse.js';
import { createSessionStore } from './session/session-store.js';
import type { Store, StoreSnapshot } from './store.js';

/**
 * Ask AI entry points through the full app: "Other" opens chat with a list of
 * uncovered ranges and no anchor. The hatched Full diff strip anchors chat to its own
 * range. Neither sends the question, it waits for ⏎ in the composer.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = fixtureIteration('medium');
const READY = (() => {
    const state = routeFixtures('medium')?.states.ready ?? null;
    if (state?.snapshot == null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return state;
})();

const VIEWPORT_WIDTH = 900;
const VIEWPORT_HEIGHT = 700;

// jsdom has no layout, ResizeObserver or workers. Without stubs, neither the virtualizer
// nor background patch parsing can produce the markup this test checks.
class NoopResizeObserver {
    observe(): void {
        // Width does not change in jsdom.
    }
    unobserve(): void {
        // See `observe`.
    }
    disconnect(): void {
        // See `observe`.
    }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;

/** The app diff worker uses the same parser without a separate thread. */
class FakeDiffWorker {
    private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

    addEventListener(type: string, listener: (event: unknown) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    postMessage(message: DiffParseMessage): void {
        const reply: DiffParseReply = { id: message.id, ok: true, model: parseFileDiff(message.file) };
        queueMicrotask(() => {
            for (const listener of this.listeners.get('message') ?? []) {
                listener({ data: reply });
            }
        });
    }

    terminate(): void {
        this.listeners.clear();
    }
}
(globalThis as { Worker?: unknown }).Worker ??= FakeDiffWorker;

Element.prototype.getBoundingClientRect = function fakeRect(): DOMRect {
    return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: VIEWPORT_WIDTH,
        bottom: VIEWPORT_HEIGHT,
        width: VIEWPORT_WIDTH,
        height: VIEWPORT_HEIGHT,
        toJSON: () => ({}),
    };
};
for (const [name, value] of [
    ['offsetWidth', VIEWPORT_WIDTH],
    ['offsetHeight', VIEWPORT_HEIGHT],
] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
}
HTMLElement.prototype.scrollIntoView = function noopScrollIntoView(): void {
    // jsdom has no scrolling.
};

const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

/**
 * The virtualizer shows only what fits in the viewport, and all rectangles in jsdom
 * are the same. Narrow the diff to one file to reach its card.
 */
function mountApp(
    view: 'route' | 'diff',
    paths?: readonly string[],
): { readonly host: HTMLElement; readonly settle: () => Promise<void> } {
    const diff =
        paths === undefined
            ? DATA.diff
            : { ...DATA.diff, files: DATA.diff.files.filter((file) => paths.includes(file.path)) };
    const originalFetch = globalThis.fetch;
    const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        switch (url.split('?')[0] ?? '') {
            case UI_ENDPOINTS.reviewDiff:
                return Promise.resolve(json({ diff }));
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: DATA.ownership, extra: DATA.extraLenses }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: DATA.threads }));
            case UI_ENDPOINTS.reviewProgress:
                return Promise.resolve(json({ diffId: query.get('diffId') ?? diff.diffId, files: [], stops: [], progressRevision: 1 }));
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(json({ route: READY, routeRevision: 1 }));
            case UI_ENDPOINTS.reviewChat:
                return Promise.resolve(json({ exchanges: [], notes: [], chatRevision: 1 }));
            default:
                return Promise.resolve(json({}));
        }
    };

    const state: UiState = {
        prKey: 'fixture-medium',
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
    const session = createSessionStore({ initial: { view, filter: 'all' }, viewPinned: true });

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
    });

    // Data loading, deferred background patch parsing and promise resolution.
    const settle = async (): Promise<void> => {
        for (let step = 0; step < 6; step += 1) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 100));
            });
        }
    };
    return { host, settle };
}

function buttonWith(host: HTMLElement, selector: string, label: string): HTMLButtonElement {
    const button = [...host.querySelectorAll<HTMLButtonElement>(selector)].find(
        (candidate) => candidate.textContent === label,
    );
    if (button === undefined) {
        throw new Error(`no "${label}" button on screen`);
    }
    return button;
}

function composerText(host: HTMLElement): string {
    const textarea = host.querySelector<HTMLTextAreaElement>('.chat-panel__textarea');
    if (textarea === null) {
        throw new Error('chat did not open: no composer');
    }
    return textarea.value;
}

describe('Ask AI entry points in the app', () => {
    it('"Other" opens chat with a range list and no anchor', async () => {
        const mounted = mountApp('route');
        await mounted.settle();

        const button = buttonWith(mounted.host, '.route-other__action', 'Ask the agent to place them');
        expect(button.disabled).toBe(false);
        act(() => {
            button.click();
        });

        const text = composerText(mounted.host);
        expect(text).toContain('Place the ranges the model left unplaced into the route stops: ');
        expect(text).toMatch(/[\w/.-]+:\d+/);
        expect(text).toContain('For each one — which stop it belongs to and why');
        // A question has one anchor and many ranges. The composer must not show a range chip.
        expect(mounted.host.querySelector('.chat-panel__context--anchor')).toBeNull();
        expect(mounted.host.querySelector('.chat-panel__context')?.textContent).not.toBe('');
    });

    it('the hatched Full diff strip opens chat anchored to its range', async () => {
        // Neither file is placed in a stop, so all their lines get hatching.
        const mounted = mountApp('diff', ['.github/CODEOWNERS', '.github/workflows/ci.yml']);
        await mounted.settle();

        const strip = mounted.host.querySelector('.route-strip');
        if (strip === null) {
            throw new Error('no hatched strip in the full diff');
        }
        const label = strip.querySelector('.route-strip__text')?.textContent ?? '';
        const numbers = /(\d+)(?:–(\d+))?/.exec(label);
        const button = strip.querySelector<HTMLButtonElement>('.route-strip__action');
        expect(button?.disabled).toBe(false);
        act(() => {
            button?.click();
        });

        const text = composerText(mounted.host);
        expect(text).toMatch(/^Which route stop (does|do) /);
        expect(text).toContain('The model did not place');
        const anchorChip = mounted.host.querySelector('.chat-panel__context--anchor');
        expect(anchorChip).not.toBeNull();
        expect(anchorChip?.textContent).toContain(numbers?.[1] ?? 'no number');
    });
});
