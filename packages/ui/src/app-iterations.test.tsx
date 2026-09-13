// @vitest-environment jsdom
import {
    fixtureIteration,
    MEDIUM_DIFF_ID,
    MEDIUM_DIFF_ID_V2,
    MEDIUM_HEAD_COMMIT,
    MEDIUM_HEAD_COMMIT_V2,
    routeFixtures,
} from '@sherpa/fixtures';
import type { Iteration, RouteSnapshot, UiRouteState, UiState } from '@sherpa/protocol';
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
 * Iteration integration in App: which banners appear on which tab and in which phase, and
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
        carried: { kept: 4, total: 7, zeroReason: null },
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
    /** How often the tab called each endpoint. The diff and lenses have no revision of their own. */
    readonly calls: (endpoint: string) => number;
    /** A new state snapshot, as over SSE. A route change also increases `routeRevision`, which triggers a reload. */
    readonly push: (patch: { readonly iterations?: readonly Iteration[]; readonly route?: UiRouteState }) => void;
}

/** A PR iteration in the state list. `active` is the one returned by endpoints without parameters. */
function iteration(diffId: string, headCommit: string, status: Iteration['status']): Iteration {
    return {
        diffId,
        baseCommit: READY_SNAPSHOT.baseCommit,
        headCommit,
        createdAt: '2026-08-21T10:00:00.000Z',
        status,
    };
}

function mountApp(options: {
    readonly route: UiRouteState;
    readonly view?: ViewId;
    readonly routeFilter?: RouteFilter;
    readonly iterations?: readonly Iteration[];
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

    // The route and state snapshot change during the test. `push` feeds the endpoint and subscription.
    let route = options.route;
    const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const calls = new Map<string, number>();
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const endpoint = url.split('?')[0] ?? '';
        calls.set(endpoint, (calls.get(endpoint) ?? 0) + 1);
        switch (endpoint) {
            case UI_ENDPOINTS.reviewDiff:
                return Promise.resolve(json({ diff: DATA.diff }));
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: DATA.ownership, extra: DATA.extraLenses }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: DATA.threads }));
            case UI_ENDPOINTS.reviewProgress:
                return Promise.resolve(json({ diffId: DATA.diff.diffId, files: [], stops: [], progressRevision: 1 }));
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(json({ route, routeRevision: snapshot.routeRevision ?? 1 }));
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
        iterations: [...(options.iterations ?? [])],
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

    const push = (patch: { readonly iterations?: readonly Iteration[]; readonly route?: UiRouteState }): void => {
        if (patch.route !== undefined) {
            route = patch.route;
        }
        snapshot = {
            ...snapshot,
            routeRevision: (snapshot.routeRevision ?? 0) + (patch.route === undefined ? 0 : 1),
            state:
                patch.iterations === undefined
                    ? snapshot.state
                    : ({ ...snapshot.state, iterations: [...patch.iterations] } as UiState),
        };
        act(() => {
            for (const listener of listeners) {
                listener();
            }
        });
    };

    return { host, session, settle, calls: (endpoint) => calls.get(endpoint) ?? 0, push };
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

/**
 * The diff and lenses have no revision of their own. They are immutable within an iteration. Reload them
 * when "without parameters" starts meaning a different iteration, which happens when a new
 * skeleton is accepted, not on push. Read the previous iteration's whole route without anchor drift.
 */
describe('reloading the diff and lenses when the iteration changes', () => {
    const V1_ACTIVE = iteration(MEDIUM_DIFF_ID, MEDIUM_HEAD_COMMIT, 'active');
    const V1_PREVIOUS = { ...V1_ACTIVE, status: 'previous' } as const;
    const V2_ACTIVE = iteration(MEDIUM_DIFF_ID_V2, MEDIUM_HEAD_COMMIT_V2, 'active');
    const SNAPSHOT_V2: RouteSnapshot = {
        ...READY_SNAPSHOT,
        snapshotId: 'route-medium-a71d4e2',
        diffId: MEDIUM_DIFF_ID_V2,
        commit: MEDIUM_HEAD_COMMIT_V2,
        previousSnapshotId: READY_SNAPSHOT.snapshotId,
    };

    it('keeps the diff on push while a route exists because the snapshot stays on the previous iteration', async () => {
        const mounted = mountApp({ route: routeState(), iterations: [V1_ACTIVE] });
        await mounted.settle();
        expect(mounted.calls(UI_ENDPOINTS.reviewDiff)).toBe(1);
        expect(mounted.calls(UI_ENDPOINTS.reviewLenses)).toBe(1);

        mounted.push({ iterations: [V1_PREVIOUS, V2_ACTIVE], route: routeState({ stale: STALE }) });
        await mounted.settle();

        expect(mounted.calls(UI_ENDPOINTS.reviewDiff)).toBe(1);
        expect(mounted.calls(UI_ENDPOINTS.reviewLenses)).toBe(1);
    });

    it('reloads the diff and lenses when the route moves to a new iteration', async () => {
        const mounted = mountApp({ route: routeState(), iterations: [V1_ACTIVE] });
        await mounted.settle();

        mounted.push({ iterations: [V1_PREVIOUS, V2_ACTIVE], route: routeState({ stale: STALE }) });
        await mounted.settle();
        expect(mounted.calls(UI_ENDPOINTS.reviewDiff)).toBe(1);

        mounted.push({ route: routeState({ snapshot: SNAPSHOT_V2 }) });
        await mounted.settle();

        expect(mounted.calls(UI_ENDPOINTS.reviewDiff)).toBe(2);
        expect(mounted.calls(UI_ENDPOINTS.reviewLenses)).toBe(2);
    });

    it('moves the reader to the new iteration on push when there is no route', async () => {
        const mounted = mountApp({
            route: routeState({ phase: 'none', snapshot: null }),
            iterations: [V1_ACTIVE],
        });
        await mounted.settle();

        mounted.push({ iterations: [V1_PREVIOUS, V2_ACTIVE] });
        await mounted.settle();

        expect(mounted.calls(UI_ENDPOINTS.reviewDiff)).toBe(2);
        expect(mounted.calls(UI_ENDPOINTS.reviewLenses)).toBe(2);
    });

    it('does not fetch the diff for other state changes', async () => {
        const mounted = mountApp({ route: routeState(), iterations: [V1_ACTIVE] });
        await mounted.settle();

        mounted.push({ iterations: [V1_ACTIVE] });
        await mounted.settle();

        expect(mounted.calls(UI_ENDPOINTS.reviewDiff)).toBe(1);
    });
});
