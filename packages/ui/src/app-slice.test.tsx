// @vitest-environment jsdom
import { fixtureInterdiff, fixtureIteration, GALLERY_HOSTS } from '@sherpa/fixtures';
import type { Iteration, PrDiff, UiState } from '@sherpa/protocol';
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
 * An inter-iteration slice in App: parameters used to load the diff, data never requested
 * in a slice, and what the header, banner, route tab and empty slice show.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const V1 = fixtureIteration('medium', 0);
const V2 = fixtureIteration('medium', 1);
const V3 = fixtureIteration('medium', 2);
const INTERDIFF: PrDiff = fixtureInterdiff('medium', 0, 1);
const BASE = V1.iteration.diffId;
const HEAD = V2.iteration.diffId;
const SLICE: Viewing = { kind: 'slice', base: BASE, head: HEAD };

const ITERATIONS: readonly Iteration[] = [
    { ...V1.iteration, status: 'previous' },
    { ...V2.iteration, status: 'active' },
];

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

function mountApp(options: {
    readonly viewing?: Viewing;
    readonly view?: ViewId;
    /** Slice endpoint response. Defaults to the fixture interdiff. */
    readonly interdiff?: PrDiff;
    /** The slice endpoint rejects the request with this message (400 for a real host, 502 for the fixture). */
    readonly sliceError?: string;
    /** PR iterations. Defaults to previous v1 and active v2. */
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

    const calls: string[] = [];
    const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        const query = new URLSearchParams(url.split('?')[1] ?? '');
        switch (url.split('?')[0] ?? '') {
            case UI_ENDPOINTS.reviewDiff:
                if (query.get('base') !== null && options.sliceError !== undefined) {
                    return Promise.resolve(
                        new Response(JSON.stringify({ error: { code: 'bad_request', message: options.sliceError } }), {
                            status: 400,
                            headers: { 'content-type': 'application/json' },
                        }),
                    );
                }
                return Promise.resolve(
                    json({ diff: query.get('base') === null ? V2.diff : (options.interdiff ?? INTERDIFF) }),
                );
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: V2.ownership, extra: V2.extraLenses, ownershipSource: 'CODEOWNERS' }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: V2.threads }));
            case UI_ENDPOINTS.reviewProgress:
                return Promise.resolve(json({ diffId: query.get('diffId') ?? V2.diff.diffId, files: [], stops: [], progressRevision: 1 }));
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(
                    json({
                        route: { phase: 'none', smallPr: false, snapshot: null, failure: null, stale: null },
                        routeRevision: 1,
                    }),
                );
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
        reviewHost: GALLERY_HOSTS.fixture,
        pr: V2.pr,
        feedback: { kind: 'issues', available: false, reason: 'The test feedback channel is unavailable.', discussionUrl: null },
        iterations: [...(options.iterations ?? ITERATIONS)],
        update: null,
        updateChannel: false,
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
        initial: {
            view: options.view ?? 'diff',
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

    return { host, session, calls, settle };
}

describe('inter-iteration slice', () => {
    it('loads the diff through the base/head endpoint and requests neither progress nor lenses', async () => {
        const mounted = mountApp({ viewing: SLICE });
        await mounted.settle();

        expect(mounted.calls).toContain(`${UI_ENDPOINTS.reviewDiff}?base=${BASE}&head=${HEAD}`);
        expect(mounted.calls.some((url) => url.startsWith(UI_ENDPOINTS.reviewProgress))).toBe(false);
        expect(mounted.calls.some((url) => url.startsWith(UI_ENDPOINTS.reviewLenses))).toBe(false);
        // A slice does not need the iteration diff, so nothing calls the endpoint without parameters.
        expect(mounted.calls).not.toContain(UI_ENDPOINTS.reviewDiff);
    });

    it('names both sides in the indicator and explains read-only mode in the banner', async () => {
        const mounted = mountApp({ viewing: SLICE });
        await mounted.settle();

        expect(mounted.host.querySelector('.snapshot-pill')?.textContent).toContain(
            `slice ${V1.iteration.headCommit.slice(0, 7)} → ${V2.iteration.headCommit.slice(0, 7)}`,
        );
        expect(mounted.host.textContent).toContain('You are looking at the slice between iterations');
        expect(mounted.host.textContent).toContain('read-only');
    });

    it('"To active iteration" returns the tab to the active iteration', async () => {
        const mounted = mountApp({ viewing: SLICE });
        await mounted.settle();

        const back = [...mounted.host.querySelectorAll('button')].find(
            (button) => button.textContent === 'To the active iteration',
        );
        expect(back).toBeDefined();
        act(() => {
            back?.click();
        });

        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'current' });
    });

    it('disables writes in a slice with a specific reason on the controls', async () => {
        const mounted = mountApp({ viewing: SLICE });
        await mounted.settle();

        const disabled = [...mounted.host.querySelectorAll<HTMLButtonElement>('button[disabled]')];
        expect(disabled.some((button) => button.title === 'in a slice between iterations')).toBe(true);
        expect(disabled.some((button) => button.title === 'only in the active iteration')).toBe(false);
    });

    it('shows an empty slice screen and a way back to the active iteration', async () => {
        const mounted = mountApp({ viewing: SLICE, interdiff: { ...INTERDIFF, files: [] } });
        await mounted.settle();

        expect(mounted.host.textContent).toContain(
            `No changes between iterations ${V1.iteration.headCommit.slice(0, 7)} → ${V2.iteration.headCommit.slice(0, 7)}`,
        );
        const back = [...mounted.host.querySelectorAll('button')].find(
            (button) => button.textContent === 'To the active iteration',
        );
        expect(back).toBeDefined();
    });

    it('shows the slice endpoint rejection as received, with a way back to the active iteration', async () => {
        const mounted = mountApp({ viewing: SLICE, sliceError: 'iteration 182799 is unknown to the host' });
        await mounted.settle();

        expect(mounted.host.textContent).toContain('iteration 182799 is unknown to the host');
        const back = [...mounted.host.querySelectorAll('button')].find(
            (button) => button.textContent === 'To the active iteration',
        );
        expect(back).toBeDefined();
        act(() => {
            back?.click();
        });

        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'current' });
    });

    it('explains on the route tab that a slice has no route', async () => {
        const mounted = mountApp({ viewing: SLICE, view: 'route' });
        await mounted.settle();

        expect(mounted.host.textContent).toContain('A route is not built for a slice between iterations');
        const toDiff = [...mounted.host.querySelectorAll('button')].find(
            (button) => button.textContent === 'To the full diff',
        );
        expect(toDiff).toBeDefined();
        act(() => {
            toDiff?.click();
        });
        await mounted.settle();

        expect(mounted.session.getSnapshot().view).toBe('diff');
        // The slice stays selected when switching to the diff tab.
        expect(mounted.session.getSnapshot().viewing).toEqual(SLICE);
    });

    it('explains why Overview has no cards for a slice instead of showing empty cards', async () => {
        const mounted = mountApp({ viewing: SLICE, view: 'overview' });
        await mounted.settle();

        expect(mounted.host.textContent).toContain('No overview for a slice');
        // Empty slice lenses must not look like a host response about ownership zones.
        expect(mounted.host.textContent).not.toContain('The host did not return an ownership zone');
        const toDiff = [...mounted.host.querySelectorAll('button')].find(
            (button) => button.textContent === 'To the full diff',
        );
        act(() => {
            toDiff?.click();
        });

        expect(mounted.session.getSnapshot().view).toBe('diff');
        expect(mounted.session.getSnapshot().viewing).toEqual(SLICE);
    });

    it('clears a slice with a nonexistent base and falls back to the active iteration', async () => {
        const mounted = mountApp({ viewing: { kind: 'slice', base: 'nonexistent', head: HEAD } });
        await mounted.settle();

        expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'current' });
        expect(mounted.host.textContent).not.toContain('You are looking at the slice');
    });

    describe('a slice between two previous iterations when the active iteration has moved on', () => {
        const THREE: readonly Iteration[] = [
            { ...V1.iteration, status: 'previous' },
            { ...V2.iteration, status: 'previous' },
            { ...V3.iteration, status: 'active' },
        ];

        it('opens from the URL, loads the diff through base/head and names both sides in the indicator', async () => {
            const mounted = mountApp({ viewing: SLICE, iterations: THREE });
            await mounted.settle();

            expect(mounted.session.getSnapshot().viewing).toEqual(SLICE);
            expect(mounted.calls).toContain(`${UI_ENDPOINTS.reviewDiff}?base=${BASE}&head=${HEAD}`);
            expect(mounted.host.querySelector('.snapshot-pill')?.textContent).toContain(
                `slice ${V1.iteration.headCommit.slice(0, 7)} → ${V2.iteration.headCommit.slice(0, 7)}`,
            );
            expect(mounted.host.textContent).toContain('You are looking at the slice between iterations');
        });

        it('opens from the menu in two steps: Shift+click one previous iteration, then click another', async () => {
            const mounted = mountApp({ viewing: { kind: 'diff', diffId: BASE }, iterations: THREE });
            await mounted.settle();

            act(() => {
                mounted.host.querySelector<HTMLButtonElement>('button.snapshot-pill--button')?.click();
            });
            act(() => {
                mounted.host
                    .querySelector(`.snapshot-picker__row[data-diff="${HEAD}"]`)
                    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
            });
            // Selecting the first side neither closes the menu nor changes the selection.
            expect(mounted.session.getSnapshot().viewing).toEqual({ kind: 'diff', diffId: BASE });
            act(() => {
                mounted.host
                    .querySelector(`.snapshot-picker__row[data-diff="${BASE}"]`)
                    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
            await mounted.settle();

            expect(mounted.session.getSnapshot().viewing).toEqual(SLICE);
            expect(mounted.calls).toContain(`${UI_ENDPOINTS.reviewDiff}?base=${BASE}&head=${HEAD}`);
        });
    });
});
