// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, UiRouteState, UiState } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app.tsx';
import type { RouteFilter, SessionStore } from './session/session-store.js';
import { createSessionStore } from './session/session-store.js';
import type { ViewId } from './session/views.js';
import type { Store, StoreSnapshot } from './store.js';

/**
 * Iteration integration in App (M4-T8): which banners appear in which tab and phase, and
 * whether an invalid "what is new" filter is reset. The tab here is always outside the route,
 * so these tests check what appears outside the route. Banner markup itself is checked by
 * `iteration-banners.test.tsx`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = fixtureIteration('medium');
const READY_SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
})();
const PR_COMMIT = 'a71d4e2c9b8f5301d6e4a2c7b09f8e3d5a4c6b21';

/** Second pass: a snapshot with a previous version, carried-over progress and a couple of classified stops. */
function secondPass(changed: readonly string[]): RouteSnapshot {
    return {
        ...READY_SNAPSHOT,
        previousSnapshotId: 'route-medium-9f3c1ab',
        carried: { kept: 4, total: 7 },
        stops: READY_SNAPSHOT.stops.map((stop) =>
            changed.includes(stop.id) ? { ...stop, change: { kind: 'changed', reason: null, threadIds: [] } } : stop,
        ),
    };
}

function routeState(patch: Partial<UiRouteState> = {}): UiRouteState {
    return { phase: 'ready', smallPr: false, snapshot: READY_SNAPSHOT, failure: null, stale: null, ...patch };
}

const STALE: UiRouteState['stale'] = {
    routeCommit: READY_SNAPSHOT.commit,
    prCommit: PR_COMMIT,
    prDiffId: '182801',
    newIterations: 2,
    affectedStopIds: [],
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
    readonly settle: () => Promise<void>;
}

function mountApp(options: {
    readonly route: UiRouteState;
    readonly view?: ViewId;
    readonly routeFilter?: RouteFilter;
}): Mounted {
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

    const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        switch (url.split('?')[0] ?? '') {
            case UI_ENDPOINTS.reviewDiff:
                return Promise.resolve(json({ diff: DATA.diff }));
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: DATA.ownership, extra: DATA.extraLenses }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: DATA.threads }));
            case UI_ENDPOINTS.reviewProgress:
                return Promise.resolve(json({ files: [], stops: [], progressRevision: 1 }));
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(json({ route: options.route, routeRevision: 1 }));
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
        pr: DATA.pr,
        feedback: { available: false, reason: 'The test feedback channel is unavailable.' },
        iterations: [],
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
        initial: {
            view: options.view ?? 'overview',
            filter: 'all',
            ...(options.routeFilter === undefined ? {} : { routeFilter: options.routeFilter }),
        },
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

describe('iteration banners outside the route tab', () => {
    it('shows a stale route on any tab so it can be rebuilt from anywhere', async () => {
        const mounted = mountApp({ route: routeState({ stale: STALE }) });
        await mounted.settle();

        expect(mounted.host.textContent).toContain('The route was built for');
        expect(mounted.host.textContent).toContain('Rebuild the route');
    });

    it('hides the stale banner during a rebuild because its button is disabled anyway', async () => {
        const mounted = mountApp({ route: routeState({ phase: 'reading', stale: STALE }) });
        await mounted.settle();

        expect(mounted.host.textContent).not.toContain('The route was built for');
    });

    it('hides the second-pass banner outside the route because its button enables a route filter', async () => {
        const mounted = mountApp({ route: routeState({ snapshot: secondPass(['s02']) }) });
        await mounted.settle();

        expect(mounted.host.textContent).not.toContain('The route was rebuilt for');
    });
});

describe('validity of the "what is new" filter', () => {
    it('resets the filter for a ready snapshot without classified stops', async () => {
        const mounted = mountApp({ route: routeState(), routeFilter: 'new' });
        await mounted.settle();

        expect(mounted.session.getSnapshot().routeFilter).toBe('all');
    });

    it('keeps the filter enabled when classified stops exist', async () => {
        const mounted = mountApp({ route: routeState({ snapshot: secondPass(['s02', 's03']) }), routeFilter: 'new' });
        await mounted.settle();

        expect(mounted.session.getSnapshot().routeFilter).toBe('new');
    });

    it('leaves the enabled filter alone while there is no snapshot', async () => {
        const mounted = mountApp({ route: routeState({ phase: 'none', snapshot: null }), routeFilter: 'new' });
        await mounted.settle();

        expect(mounted.session.getSnapshot().routeFilter).toBe('new');
    });
});
