// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { Iteration, RouteSnapshot, UiRouteState, UiState } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app.tsx';
import { parseFileDiff } from './diff/parse.js';
import { createSessionStore } from './session/session-store.js';
import type { Store, StoreSnapshot } from './store.js';

/**
 * Read progress for the displayed iteration. Until the route is rebuilt, the tab
 * uses the snapshot iteration's diff. Active-iteration progress refers to different `fileId` values,
 * so applying it would clear every mark on screen.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const V1 = fixtureIteration('medium', 0);
const V2 = fixtureIteration('medium', 1);

const READY_SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
})();

/** The file in the first route stop. Its mark must survive a new iteration. */
const MARKED_FILE = (() => {
    const fileId = READY_SNAPSHOT.stops[0]?.anchors[0]?.fileId ?? null;
    if (fileId === null) {
        throw new Error('the medium fixture needs a snapshot with an anchor in the first stop');
    }
    return fileId;
})();

function iteration(source: typeof V1, status: Iteration['status'], createdAt: string): Iteration {
    return {
        diffId: source.diff.diffId,
        baseCommit: source.diff.baseCommit,
        headCommit: source.diff.headCommit,
        createdAt,
        status,
    };
}

const V1_ACTIVE = iteration(V1, 'active', '2026-08-31T09:00:00.000Z');
const V1_PREVIOUS = iteration(V1, 'previous', '2026-08-31T09:00:00.000Z');
const V2_ACTIVE = iteration(V2, 'active', '2026-08-31T11:00:00.000Z');

const STALE: UiRouteState['stale'] = {
    routeCommit: V1.diff.headCommit,
    prCommit: V2.diff.headCommit,
    prDiffId: V2.diff.diffId,
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
    /** The `diffId` sent with each progress request. `null` means no parameter. */
    readonly progressCalls: (string | null)[];
    /** Makes the endpoint respond for another iteration, like a server that ignores the parameter. */
    readonly answerAs: (diffId: string | null) => void;
    readonly settle: () => Promise<void>;
    readonly push: (patch: {
        readonly iterations?: readonly Iteration[];
        readonly route?: UiRouteState;
        readonly progressRevision?: number;
    }) => void;
}

function mountApp(): Mounted {
    let answeredAs: string | null = null;
    const originalFetch = globalThis.fetch;
    const globals = globalThis as { Worker?: unknown; ResizeObserver?: unknown };
    const originalWorker = globals.Worker;
    const originalResizeObserver = globals.ResizeObserver;

    // jsdom has no real worker. Use the same parser in the same thread.
    class FakeWorker {
        private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
        addEventListener(type: string, listener: (event: unknown) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }
        postMessage(message: { id: number; file: Parameters<typeof parseFileDiff>[0] }): void {
            const reply = { id: message.id, ok: true, model: parseFileDiff(message.file) };
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
    globals.Worker = FakeWorker;
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

    let route: UiRouteState = {
        phase: 'ready',
        smallPr: false,
        snapshot: READY_SNAPSHOT,
        failure: null,
        stale: null,
    };
    const progressCalls: (string | null)[] = [];
    const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        switch (url.split('?')[0] ?? '') {
            case UI_ENDPOINTS.reviewDiff:
                return Promise.resolve(
                    json({ diff: query.get('diffId') === V2.diff.diffId ? V2.diff : V1.diff }),
                );
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: V1.ownership, extra: V1.extraLenses, ownershipSource: 'CODEOWNERS' }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: V1.threads }));
            case UI_ENDPOINTS.reviewProgress: {
                const asked = query.get('diffId');
                progressCalls.push(asked);
                const answered = answeredAs ?? asked ?? V1.diff.diffId;
                return Promise.resolve(
                    json({
                        diffId: answered,
                        // The mark exists only in iteration V1. Its `fileId` does not exist in V2.
                        files:
                            answered === V1.diff.diffId
                                ? [{ fileId: MARKED_FILE, viewed: true, seenRanges: [] }]
                                : [],
                        stops: [],
                        progressRevision: snapshot.progressRevision ?? 1,
                    }),
                );
            }
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(json({ route, routeRevision: snapshot.routeRevision ?? 1 }));
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
        pr: V1.pr,
        feedback: { available: false, reason: 'The test feedback channel is unavailable.' },
        iterations: [V1_ACTIVE],
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

    const session = createSessionStore({ initial: { view: 'route', filter: 'all' }, viewPinned: true });
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
        globals.Worker = originalWorker;
        globals.ResizeObserver = originalResizeObserver;
    });

    const settle = async (): Promise<void> => {
        for (let step = 0; step < 12; step += 1) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
            });
        }
    };

    const push = (patch: {
        readonly iterations?: readonly Iteration[];
        readonly route?: UiRouteState;
        readonly progressRevision?: number;
    }): void => {
        if (patch.route !== undefined) {
            route = patch.route;
        }
        snapshot = {
            ...snapshot,
            routeRevision: (snapshot.routeRevision ?? 0) + (patch.route === undefined ? 0 : 1),
            progressRevision: patch.progressRevision ?? snapshot.progressRevision,
            state:
                patch.iterations === undefined
                    ? snapshot.state
                    : ({ ...snapshot.state, iterations: [...patch.iterations] } as UiState),
        };
        act(() => {
            for (const listener of [...listeners]) {
                listener();
            }
        });
    };

    return {
        host,
        progressCalls,
        answerAs: (diffId) => {
            answeredAs = diffId;
        },
        settle,
        push,
    };
}

/** The viewed mark for a file marked in iteration V1 progress. */
function markedViewed(host: HTMLElement): boolean {
    const card = host.querySelector(`.file-card[data-file="${MARKED_FILE}"]`);
    return card?.querySelector('button.viewed-toggle')?.getAttribute('aria-pressed') === 'true';
}

describe('progress is read for the displayed iteration', () => {
    it('sends the displayed diff `diffId` instead of omitting the parameter', async () => {
        const mounted = mountApp();
        await mounted.settle();

        expect(mounted.progressCalls).toEqual([V1.diff.diffId]);
        expect(markedViewed(mounted.host)).toBe(true);
    });

    it('keeps marks after a new iteration by reloading progress for the snapshot iteration', async () => {
        const mounted = mountApp();
        await mounted.settle();
        expect(markedViewed(mounted.host)).toBe(true);

        // Push: V2 is now active, but the route snapshot stays on V1, so the tab shows its diff.
        mounted.push({
            iterations: [V1_PREVIOUS, V2_ACTIVE],
            route: { phase: 'ready', smallPr: false, snapshot: READY_SNAPSHOT, failure: null, stale: STALE },
            progressRevision: 2,
        });
        await mounted.settle();

        expect(mounted.progressCalls.every((diffId) => diffId === V1.diff.diffId)).toBe(true);
        expect(mounted.progressCalls.length).toBeGreaterThan(1);
        expect(markedViewed(mounted.host)).toBe(true);
    });

    it('discards a response for another iteration and keeps the marks on screen', async () => {
        const mounted = mountApp();
        await mounted.settle();
        expect(markedViewed(mounted.host)).toBe(true);

        // The server responded for the active iteration although the request named the displayed one.
        mounted.answerAs(V2.diff.diffId);
        mounted.push({ progressRevision: 2 });
        await mounted.settle();

        expect(mounted.progressCalls.length).toBeGreaterThan(1);
        expect(markedViewed(mounted.host)).toBe(true);
    });
});
