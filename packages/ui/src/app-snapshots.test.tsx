// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { Iteration, RouteSnapshot, UiRouteStale, UiRouteState, UiSnapshotSummary, UiState } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app.tsx';
import type { Viewing } from './iterations/viewing.js';
import type { SessionStore } from './session/session-store.js';
import { createSessionStore } from './session/session-store.js';
import type { ViewId } from './session/views.js';
import type { Store, StoreSnapshot } from './store.js';

/**
 * Snapshot picker in App: endpoint parameters sent for a previous snapshot,
 * read-only banner text and app behaviour when the server has no snapshots endpoint.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = fixtureIteration('medium');
const CURRENT_SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
})();
const OLD_COMMIT = '5c1d0aa8b7e6f4302d9c8b7a6f5e4d3c2b1a0999';
const OLD_DIFF_ID = '182799';

const OLD_SNAPSHOT: RouteSnapshot = {
    ...CURRENT_SNAPSHOT,
    snapshotId: 'route-medium-5c1d0aa',
    commit: OLD_COMMIT,
    diffId: OLD_DIFF_ID,
    createdAt: '2026-08-31T06:00:00.000Z',
};

function summaryOf(snapshot: RouteSnapshot, status: UiSnapshotSummary['status']): UiSnapshotSummary {
    return {
        snapshotId: snapshot.snapshotId,
        diffId: snapshot.diffId,
        commit: snapshot.commit,
        baseCommit: snapshot.baseCommit,
        createdAt: snapshot.createdAt,
        provenance: snapshot.provenance,
        previousSnapshotId: snapshot.previousSnapshotId,
        status,
    };
}

const SNAPSHOTS: readonly UiSnapshotSummary[] = [
    summaryOf(OLD_SNAPSHOT, 'stale'),
    summaryOf(CURRENT_SNAPSHOT, 'current'),
];

function routeState(patch: Partial<UiRouteState> = {}): UiRouteState {
    return { phase: 'ready', smallPr: false, snapshot: CURRENT_SNAPSHOT, failure: null, stale: null, ...patch };
}

/** The PR moved past the snapshot. Only `stale` identifies the active iteration because the old server provides no slices. */
const PR_COMMIT = 'c0ffee1b2a3d4e5f60718293a4b5c6d7e8f90123';
const PR_DIFF_ID = '182802';
const STALE: UiRouteStale = {
    routeCommit: CURRENT_SNAPSHOT.commit,
    prCommit: PR_COMMIT,
    prDiffId: PR_DIFF_ID,
    newIterations: 1,
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
    readonly calls: string[];
    readonly setIterations: (iterations: readonly Iteration[]) => void;
    readonly settle: () => Promise<void>;
}

function mountApp(options: {
    readonly viewing?: Viewing;
    readonly view?: ViewId;
    readonly snapshots?: readonly UiSnapshotSummary[] | 'missing';
    readonly route?: UiRouteState;
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

    const calls: string[] = [];
    const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const notFound = (): Response =>
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'no endpoint' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
        });
    const route = options.route ?? routeState();
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        switch (url.split('?')[0] ?? '') {
            case UI_ENDPOINTS.reviewDiff:
                return Promise.resolve(
                    json({
                        diff:
                            query.get('diffId') === null
                                ? DATA.diff
                                : { ...DATA.diff, diffId: query.get('diffId'), headCommit: OLD_COMMIT },
                    }),
                );
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: DATA.ownership, extra: DATA.extraLenses }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: DATA.threads }));
            case UI_ENDPOINTS.reviewProgress:
                return Promise.resolve(json({ files: [], stops: [], progressRevision: 1 }));
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(
                    json({
                        route:
                            query.get('snapshot') === null
                                ? route
                                : { ...route, snapshot: OLD_SNAPSHOT, stale: null },
                        routeRevision: 1,
                    }),
                );
            case UI_ENDPOINTS.reviewSnapshots:
                return options.snapshots === 'missing'
                    ? Promise.resolve(notFound())
                    : Promise.resolve(json({ snapshots: options.snapshots ?? SNAPSHOTS }));
            case UI_ENDPOINTS.reviewChat:
                return Promise.resolve(json({ exchanges: [], notes: [], chatRevision: 1 }));
            default:
                return Promise.resolve(json({}));
        }
    };

    let state: UiState = {
        prKey: 'fixture/medium',
        worker: { kind: 'never' },
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
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => snapshot,
        close: () => undefined,
    };
    const setIterations = (iterations: readonly Iteration[]): void => {
        state = { ...state, iterations: [...iterations] };
        snapshot = { ...snapshot, state };
        for (const listener of [...listeners]) {
            listener();
        }
    };

    const session = createSessionStore({
        initial: {
            view: options.view ?? 'overview',
            filter: 'all',
            ...(options.viewing === undefined ? {} : { viewing: options.viewing }),
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
        for (let step = 0; step < 6; step += 1) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
        }
    };

    return { host, session, calls, setIterations, settle };
}

describe('selecting a previous snapshot', () => {
    it('sends endpoints the selected snapshot and iteration parameters', async () => {
        const mounted = mountApp({ viewing: { kind: 'snapshot', snapshotId: OLD_SNAPSHOT.snapshotId } });
        await mounted.settle();

        expect(mounted.calls).toContain(`${UI_ENDPOINTS.reviewRoute}?snapshot=${OLD_SNAPSHOT.snapshotId}`);
        expect(mounted.calls).toContain(`${UI_ENDPOINTS.reviewDiff}?diffId=${OLD_DIFF_ID}`);
        expect(mounted.calls).toContain(`${UI_ENDPOINTS.reviewProgress}?diffId=${OLD_DIFF_ID}`);
    });

    it('shows the read-only banner and returns to the current snapshot', async () => {
        const mounted = mountApp({ viewing: { kind: 'snapshot', snapshotId: OLD_SNAPSHOT.snapshotId } });
        await mounted.settle();

        expect(mounted.host.textContent).toContain('You are looking at snapshot');
        expect(mounted.host.textContent).toContain('read-only');

        const back = [...mounted.host.querySelectorAll('button')].find(
            (button) => button.textContent === 'To the current one',
        );
        expect(back).toBeDefined();
        act(() => {
            back?.click();
        });

        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'current' });
    });

    it('does not write progress in read-only mode, including marks and the mirror', async () => {
        const mounted = mountApp({
            viewing: { kind: 'snapshot', snapshotId: OLD_SNAPSHOT.snapshotId },
            view: 'diff',
        });
        await mounted.settle();

        // Marks and the coverage mirror are the only progress writes. Neither happens in read-only mode.
        expect(mounted.calls.some((url) => url.startsWith(UI_ENDPOINTS.reviewViewedMirror))).toBe(false);
        expect(mounted.calls.some((url) => url.startsWith(UI_ENDPOINTS.reviewFileViewed))).toBe(false);
        expect(mounted.calls.some((url) => url.startsWith(UI_ENDPOINTS.reviewStopViewed))).toBe(false);
    });

    it('the header pill names the selected snapshot and its status', async () => {
        const mounted = mountApp({
            viewing: { kind: 'snapshot', snapshotId: OLD_SNAPSHOT.snapshotId },
            view: 'diff',
        });
        await mounted.settle();

        expect(mounted.host.querySelector('.snapshot-pill')?.textContent).toContain(
            `snapshot ${OLD_COMMIT.slice(0, 7)} · stale`,
        );
    });

    it('keeps the selection when a new iteration list arrives over SSE', async () => {
        const mounted = mountApp({ viewing: { kind: 'snapshot', snapshotId: OLD_SNAPSHOT.snapshotId } });
        await mounted.settle();

        act(() => {
            mounted.setIterations([
                {
                    diffId: OLD_DIFF_ID,
                    baseCommit: 'base',
                    headCommit: OLD_COMMIT,
                    createdAt: '2026-08-31T06:00:00.000Z',
                    status: 'previous',
                },
                {
                    diffId: CURRENT_SNAPSHOT.diffId,
                    baseCommit: 'base',
                    headCommit: CURRENT_SNAPSHOT.commit,
                    createdAt: '2026-08-31T09:00:00.000Z',
                    status: 'active',
                },
            ]);
        });
        await mounted.settle();

        expect(mounted.session.getSnapshot().viewing).toEqual({
            kind: 'snapshot',
            snapshotId: OLD_SNAPSHOT.snapshotId,
        });
        expect(mounted.host.textContent).toContain('read-only');
    });
});

describe('a server without a snapshots endpoint', () => {
    it('handles 404 without breaking the app or showing an error', async () => {
        const mounted = mountApp({ snapshots: 'missing', view: 'diff' });
        await mounted.settle();

        expect(mounted.host.textContent).not.toContain('no endpoint');
        expect(mounted.host.querySelector('.snapshot-pill')?.textContent).toContain('snapshot');
        expect(mounted.host.textContent).not.toContain('read-only');
    });

    it('clears an unknown selection from the URL and shows the current state', async () => {
        const mounted = mountApp({ snapshots: 'missing', viewing: { kind: 'snapshot', snapshotId: 'nonexistent' } });
        await mounted.settle();

        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'current' });
        expect(mounted.host.textContent).not.toContain('read-only');
    });
});

/**
 * The current server sends `iterations: []`, so only the route response without parameters
 * identifies the active iteration. Read it separately from tab data, or selecting an iteration
 * would erase the facts used to resolve that selection and reset it to "current".
 */
describe('selecting an iteration without an iteration list', () => {
    it('survives a reload with `diff=` in the URL', async () => {
        const mounted = mountApp({
            viewing: { kind: 'diff', diffId: PR_DIFF_ID },
            view: 'diff',
            route: routeState({ stale: STALE }),
        });
        await mounted.settle();

        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'diff', diffId: PR_DIFF_ID });
        // This is the active iteration. The same endpoints take no parameters, and writes are allowed.
        expect(mounted.calls.some((url) => url.includes(`diffId=${PR_DIFF_ID}`))).toBe(false);
        expect(mounted.host.textContent).not.toContain('read-only');
        expect(mounted.host.querySelector('.snapshot-pill')?.textContent).toContain(
            `diff ${PR_COMMIT.slice(0, 7)} · no route`,
        );
    });

    it('keeps the selection after "Open diff ... without a route" in the stale banner', async () => {
        const mounted = mountApp({ view: 'diff', route: routeState({ stale: STALE }) });
        await mounted.settle();

        const open = [...mounted.host.querySelectorAll('button')].find((button) =>
            button.textContent.endsWith('diff without a route'),
        );
        expect(open).toBeDefined();
        act(() => {
            open?.click();
        });
        await mounted.settle();

        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'diff', diffId: PR_DIFF_ID });
        expect(mounted.host.textContent).not.toContain('read-only');
    });

    it('does not enter read-only mode during regeneration on the active iteration', async () => {
        const regenerated: RouteSnapshot = {
            ...CURRENT_SNAPSHOT,
            snapshotId: 'route-medium-regen',
            createdAt: '2026-08-31T07:00:00.000Z',
        };
        const mounted = mountApp({
            viewing: { kind: 'snapshot', snapshotId: regenerated.snapshotId },
            view: 'diff',
            snapshots: [summaryOf(regenerated, 'stale'), summaryOf(CURRENT_SNAPSHOT, 'current')],
        });
        await mounted.settle();

        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'snapshot', snapshotId: regenerated.snapshotId });
        expect(mounted.host.textContent).not.toContain('read-only');
    });
});

describe('read-only mode disables all writes', () => {
    it('disables terminal actions with a tooltip', async () => {
        const mounted = mountApp({
            viewing: { kind: 'snapshot', snapshotId: OLD_SNAPSHOT.snapshotId },
            view: 'diff',
        });
        await mounted.settle();

        const disabled = [...mounted.host.querySelectorAll<HTMLButtonElement>('button[disabled]')];
        expect(disabled.some((button) => button.title === 'only in the active iteration')).toBe(true);
    });

    it('places the snapshot pill in the PR header on Overview', async () => {
        const mounted = mountApp({ view: 'overview' });
        await mounted.settle();

        expect(mounted.host.querySelector('.pr-header .snapshot-pill')).not.toBeNull();
    });
});
