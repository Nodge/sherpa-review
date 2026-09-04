// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { Iteration, RouteSnapshot, Thread, UiRouteState, UiState } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app.tsx';
import { updateFragment } from './fragment.js';
import type { Viewing } from './iterations/viewing.js';
import { sessionFragmentPatch } from './session/session-fragment.js';
import type { SessionStore } from './session/session-store.js';
import { createSessionStore } from './session/session-store.js';
import type { Store, StoreSnapshot } from './store.js';

/**
 * "View at the old commit" navigation (M4-T10): a thread pinned to a previous iteration
 * pinned to, with focus on that thread. The entry point is the "outside the diff" fold in the
 * Discussion card in Overview (SPEC additions §1e), since there is nowhere else to read such a thread. The iteration choice and `thread` go into the fragment
 * in one patch, or changing iterations would clear `thread` as an anchor from another diff.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const V1 = fixtureIteration('medium', 0);
const V2 = fixtureIteration('medium', 1);

/**
 * A thread on a file removed from the PR in the second push. It is in the "outside the diff" fold on Overview.
 * The author is replaced with a human because the discussion card never expands bot threads (§1e item 3).
 */
const OUTSIDE_THREAD = (() => {
    const v2FileIds = new Set(V2.diff.files.map((file) => file.fileId));
    const thread = V2.threads.find(
        (candidate) => candidate.anchor !== null && !v2FileIds.has(candidate.anchor.fileId),
    );
    if (thread?.pinnedTo == null) {
        throw new Error('the medium fixture needs a pinned thread on a removed file');
    }
    return {
        ...thread,
        root: { ...thread.root, author: { login: 'morgan', displayName: 'Morgan Price', bot: false } },
    };
})();

const THREADS: readonly Thread[] = V2.threads.map((thread) =>
    thread.id === OUTSIDE_THREAD.id ? OUTSIDE_THREAD : thread,
);

const READY_SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
})();

const ITERATIONS: readonly Iteration[] = [
    {
        diffId: V1.diff.diffId,
        baseCommit: V1.diff.baseCommit,
        headCommit: V1.diff.headCommit,
        createdAt: '2026-08-19T09:00:00.000Z',
        status: 'previous',
    },
    {
        diffId: V2.diff.diffId,
        baseCommit: V2.diff.baseCommit,
        headCommit: V2.diff.headCommit,
        createdAt: '2026-08-21T11:00:00.000Z',
        status: 'active',
    },
];

const ROUTE: UiRouteState = {
    phase: 'ready',
    smallPr: false,
    snapshot: { ...READY_SNAPSHOT, diffId: V2.diff.diffId, commit: V2.diff.headCommit },
    failure: null,
    stale: null,
};

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
    readonly calls: string[];
    readonly settle: () => Promise<void>;
}

function mountApp(): Mounted {
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

    const calls: string[] = [];
    const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        switch (url.split('?')[0] ?? '') {
            case UI_ENDPOINTS.reviewDiff:
                return Promise.resolve(json({ diff: query.get('diffId') === V1.diff.diffId ? V1.diff : V2.diff }));
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: V2.ownership, extra: V2.extraLenses }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: THREADS }));
            case UI_ENDPOINTS.reviewProgress:
                return Promise.resolve(json({ files: [], stops: [], progressRevision: 1 }));
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(json({ route: ROUTE, routeRevision: 1 }));
            case UI_ENDPOINTS.reviewSnapshots:
                return Promise.resolve(json({ snapshots: [] }));
            case UI_ENDPOINTS.reviewChat:
                return Promise.resolve(json({ exchanges: [], notes: [], chatRevision: 1 }));
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
        iterations: [...ITERATIONS],
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

    // Write the URL with the same code as main, or the test cannot tell whether `thread`
    // survives an iteration change.
    window.location.hash = '#t=token';
    let persistedViewing: Viewing = { kind: 'current' };
    const session = createSessionStore({
        initial: { view: 'overview', filter: 'all' },
        viewPinned: true,
        persist: (next, fragment) => {
            const patch = sessionFragmentPatch(next, persistedViewing, fragment);
            persistedViewing = next.viewing;
            history.replaceState(null, '', updateFragment(window.location.hash, patch));
        },
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
        for (let step = 0; step < 6; step += 1) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        }
    };

    return { host, session, calls, settle };
}

function click(host: HTMLElement, selector: string): void {
    const element = host.querySelector<HTMLElement>(selector);
    expect(element, selector).not.toBeNull();
    act(() => {
        element?.click();
    });
}

describe('showing a thread on an old commit', () => {
    it('expands the "outside the diff" fold on Overview to show the thread with its pin chip', async () => {
        const mounted = mountApp();
        await mounted.settle();

        expect(mounted.host.textContent).toContain('Off the diff');

        click(mounted.host, '.discussion-card__outside-toggle');

        expect(mounted.host.textContent).toContain(
            `pinned to ${(OUTSIDE_THREAD.pinnedTo?.commit ?? '').slice(0, 7)}`,
        );
        expect(mounted.host.querySelector('.thread__pin-action')).not.toBeNull();
    });

    it('opens the pinned iteration in the full diff and keeps `thread` in the fragment', async () => {
        const mounted = mountApp();
        await mounted.settle();
        click(mounted.host, '.discussion-card__outside-toggle');
        click(mounted.host, '.thread__pin-action');
        await mounted.settle();

        expect(mounted.session.getSnapshot().view).toBe('diff');
        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'diff', diffId: V1.diff.diffId });
        expect(window.location.hash).toContain(`diff=${V1.diff.diffId}`);
        expect(window.location.hash).toContain(`thread=${OUTSIDE_THREAD.id}`);
        expect(mounted.calls).toContain(`${UI_ENDPOINTS.reviewDiff}?diffId=${V1.diff.diffId}`);
    });

    it('opens a previous iteration read-only and without a route', async () => {
        const mounted = mountApp();
        await mounted.settle();
        click(mounted.host, '.discussion-card__outside-toggle');
        click(mounted.host, '.thread__pin-action');
        await mounted.settle();

        expect(mounted.host.textContent).toContain('You are looking at the previous iteration');
        expect(mounted.host.textContent).toContain('read-only');
        expect(mounted.host.querySelector('.snapshot-pill')?.textContent).toContain(
            `diff ${V1.diff.headCommit.slice(0, 7)} · no route`,
        );
    });
});
