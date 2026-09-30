// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { FileDiff, RouteSnapshot } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { COLLAPSE_THRESHOLD } from '../diff-view/file-card.tsx';
import { createDiffViewStore } from '../diff-view/store.js';
import { PrStateProvider } from '../pr-state/context.tsx';
import type { UiPrStateStore } from '../pr-state/pr-state-store.js';
import { createUiPrStateStore } from '../pr-state/pr-state-store.js';
import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { DiffWorkspace } from './full-diff.tsx';

/**
 * Route in the full diff margins, rendered live: tree and card-header badges, a footer note
 * with computed counts, hatched strips under uncovered ranges and clicks that navigate
 * to a stop. Without a route, the reader must remain exactly as it was before routes existed.
 */

const DATA = fixtureIteration('medium');
const SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
})();
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWPORT_WIDTH = 900;
const VIEWPORT_HEIGHT = 700;

// jsdom has neither ResizeObserver nor layout. The list measures its width, so without a stub
// mounting fails before the first badge. This test observes markup, not geometry.
class NoopResizeObserver {
    observe(): void {
        // Width never changes in jsdom.
    }
    unobserve(): void {
        // See `observe`.
    }
    disconnect(): void {
        // See `observe`.
    }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;

// The virtualizer renders what fits in the viewport, but all rectangles are zero-sized in jsdom.
// Without dimensions, no tree rows or cards would reach the DOM.
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

// The virtualizer gets the scroll container size from `offsetWidth`/`offsetHeight`.
for (const [name, value] of [
    ['offsetWidth', VIEWPORT_WIDTH],
    ['offsetHeight', VIEWPORT_HEIGHT],
] as const) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
}

interface Mounted {
    readonly host: HTMLElement;
    /** Stops the view requested navigation to. */
    readonly jumps: string[];
    /** Files the view requested parsing for (in request order, with repeats). */
    readonly parsed: string[];
    /** Render again with a different diff, as on a PR update. */
    readonly rerender: (files: readonly FileDiff[]) => void;
}

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount(
    options: {
        route?: boolean;
        paths?: readonly string[];
        files?: readonly FileDiff[];
        ownStore?: boolean;
        /** Shared PR state store. Two mounts use it to share server collapse state. */
        prState?: UiPrStateStore;
        resolvedThreads?: boolean;
    } = {},
): Mounted {
    const host = document.createElement('div');
    document.body.append(host);
    // Virtualization shows only what fits in the viewport. To reach a specific file's
    // card, narrow the diff to that file. Stop anchors stay the same.
    const initialFiles =
        options.files ??
        (options.paths === undefined
            ? DATA.diff.files
            : DATA.diff.files.filter((file) => options.paths?.includes(file.path) === true));
    // `ownStore`: the view creates its own store from the diff. This checks background parsing instead of
    // models placed in the store in advance.
    const store = options.ownStore === true ? null : createDiffViewStore({ files: initialFiles });
    for (const file of store === null ? [] : initialFiles) {
        store?.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
    }
    const session = createSessionStore({
        initial: {
            view: 'diff',
            filter: 'all',
        },
    });
    const jumps: string[] = [];
    const parsed: string[] = [];
    const threadStore = createThreadStore(DATA.threads, FILE_IDS);
    const root = createRoot(host);

    // Without a provider, the palette and tree use the module's shared fallback store. The test needs its own.
    const prState = options.prState ?? createUiPrStateStore();

    const render = (files: readonly FileDiff[]): void => {
        act(() => {
            root.render(
                <PrStateProvider store={prState}>
                <DiffWorkspace
                    pr={DATA.pr}
                    diff={{ ...DATA.diff, files: [...files] }}
                    lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                    prKey="fixture-medium"
                    session={session}
                    {...(store === null ? {} : { store })}
                    threadStore={threadStore}
                    threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                    parse={(file) => {
                        parsed.push(file.fileId);
                        return Promise.resolve(parseFileDiff(toParseRequest(file)));
                    }}
                    loadContent={() => Promise.resolve(null)}
                    onSetViewed={() => Promise.resolve(0)}
                    {...(options.route === false ? {} : { routeSnapshot: SNAPSHOT })}
                    onJumpToStop={(stopId) => {
                        jumps.push(stopId);
                    }}
                />
                </PrStateProvider>,
            );
        });
    };
    render(initialFiles);
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    return { host, jumps, parsed, rerender: render };
}

/** Wait for background parsing: deferred start and resolution of `parse` promises. */
async function settleBackgroundParse(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, BACKGROUND_PARSE_DELAY + 50));
    });
}

const BACKGROUND_PARSE_DELAY = 300;

function badges(host: HTMLElement, scope: 'tree' | 'card'): HTMLElement[] {
    return [...host.querySelectorAll<HTMLElement>(`.route-badge--${scope}`)];
}

function planLabelOf(path: string): string {
    const file = DATA.diff.files.find((candidate) => candidate.path === path);
    const stop = SNAPSHOT.stops.find(
        (candidate) =>
            candidate.tier !== 'other' && candidate.anchors.some((anchor) => anchor.fileId === file?.fileId),
    );
    if (stop === undefined) {
        throw new Error(`file ${path} has no stop in the fixture snapshot`);
    }
    return String(stop.planIndex).padStart(2, '0');
}

describe('route in full diff margins', () => {
    it('shows stop badges and outside-route hatching in the tree', () => {
        const { host } = mount();
        const labels = badges(host, 'tree').map((badge) => badge.textContent);

        expect(labels.length).toBeGreaterThan(0);
        expect(labels).toContain(planLabelOf('services/orders/src/api/handlers.ts'));
        // The outside-route tree marker has no text. The reason is in its tooltip.
        expect(labels).toContain('');
        const hatched = badges(host, 'tree').filter((badge) => badge.classList.contains('route-badge--hatched'));
        expect(hatched.length).toBeGreaterThan(0);
        expect(hatched[0]?.getAttribute('title')).toContain('No route stop');
    });

    it('counts fixture lines and files in the panel footer note', () => {
        const { host } = mount();
        const footer = host.querySelector('.file-panel__footer');

        expect(footer?.textContent).toBe(
            'The hatch means the range has no route stop. 38 lines in 4 files.',
        );
    });

    it('gives the card an "explained in NN · title" badge and navigates on click', () => {
        const { host, jumps } = mount();
        const badge = badges(host, 'card')[0];

        expect(badge?.textContent).toMatch(/^explained in \d\d( \+\d)? · /);
        act(() => {
            badge?.click();
        });
        expect(jumps).toEqual([expect.stringMatching(/^s\d\d$/)]);
    });

    it('navigates to Other on a tree hatch click', () => {
        const { host, jumps } = mount();
        const hatched = badges(host, 'tree').find((badge) => badge.classList.contains('route-badge--hatched'));

        act(() => {
            hatched?.click();
        });
        const other = SNAPSHOT.stops.find((stop) => stop.tier === 'other');
        expect(jumps).toEqual([other?.id]);
    });

    it('covers an uncovered range with a hatched strip showing line numbers', () => {
        // The file is partially covered. The end of `psp-schema.ts` is those 17 lines without a stop.
        const { host } = mount({ paths: ['services/orders/src/payments/generated/psp-schema.ts'] });
        act(() => {
            host.querySelector<HTMLElement>('.file-card__collapsed--file')?.click();
        });
        const strips = [...host.querySelectorAll<HTMLElement>('.route-strip__text')].map(
            (strip) => strip.textContent,
        );

        expect(strips.length).toBeGreaterThan(0);
        for (const text of strips) {
            expect(text).toMatch(/^(removed )?lines? \d+(–\d+)? (has|have) no route stop$/);
        }
        expect(host.querySelector('.route-badge--card')?.textContent).toMatch(/^explained in /);
    });

    it('a collapsed viewed card keeps the thread below the header', () => {
        const { host } = mount({
            paths: ['services/orders/src/infra/logging.ts'],
            route: false,
            resolvedThreads: true,
        });

        expect(host.querySelector('.file-card__collapsed--file')?.textContent).toContain('viewed');
        expect(host.querySelector('.thread')?.textContent).toContain('process.env.DEBUG');
        expect(host.querySelector('.file-card__collapsed-hint')?.textContent).toBe('click to expand the lines');
    });

    it('parses files again after a diff change so the note does not get stuck on "Counting the lines…"', async () => {
        // PR update: a new diff object with the same fileId values (unchanged files keep their ids).
        // The view recreates the store, so "already parsed" must reset along with it, otherwise
        // files outside the viewport (which cards do not parse) remain without models forever.
        const fileIds = new Set(DATA.diff.files.map((file) => file.fileId));
        const { host, parsed, rerender } = mount({ ownStore: true });
        await settleBackgroundParse();
        const note = host.querySelector('.file-panel__footer')?.textContent;
        expect(note).toBe('The hatch means the range has no route stop. 38 lines in 4 files.');

        parsed.length = 0;
        rerender(DATA.diff.files);
        await settleBackgroundParse();

        expect(new Set(parsed)).toEqual(fileIds);
        expect(host.querySelector('.file-panel__footer')?.textContent).toBe(note);
    });

    it('keeps manual collapse state across remounts of the same PR', async () => {
        const path = 'services/orders/src/domain/order.ts';
        // One PR state store for two mounts, just like reloading the tab.
        // Collapse state comes from PR state, not component memory.
        const prState = createUiPrStateStore();
        const first = mount({ paths: [path], ownStore: true, route: false, prState });

        await act(async () => {
            first.host.querySelector<HTMLElement>('.file-card__name')?.click();
            await Promise.resolve();
        });
        expect(first.host.querySelector('.file-card__collapsed--file')?.textContent).toContain('collapsed by hand');
        const fileId = first.host.querySelector<HTMLElement>('.file-card')?.dataset.file ?? '';
        expect(prState.getSnapshot().diffCollapsed).toEqual({ [fileId]: true });

        const second = mount({ paths: [path], ownStore: true, route: false, prState });
        expect(second.host.querySelector('.file-card__collapsed--file')?.textContent).toContain('collapsed by hand');
    });

    it('does not collapse the card when selecting the path with the pointer', () => {
        const { host } = mount({ paths: ['services/orders/src/domain/order.ts'], route: false });
        const name = host.querySelector<HTMLElement>('.file-card__name');
        const selection = window.getSelection();
        const range = document.createRange();
        if (name === null || selection === null) {
            throw new Error('this test needs a card and the Selection API');
        }
        range.selectNodeContents(name);
        selection.removeAllRanges();
        selection.addRange(range);

        act(() => {
            name.click();
        });

        expect(host.querySelector('.file-card__collapsed--file')).toBeNull();
        selection.removeAllRanges();
    });

    it('skips parsing a collapsed card and requests it on expansion', async () => {
        const path = 'services/orders/src/payments/generated/psp-schema.ts';
        const file = DATA.diff.files.find((candidate) => candidate.path === path);
        const { host, parsed } = mount({ paths: [path], ownStore: true, route: false });

        expect(file).toBeDefined();
        expect(parsed).toEqual([]);
        expect(host.querySelector('.file-card__collapsed--file')?.textContent).toContain('generated file');

        await act(async () => {
            host.querySelector<HTMLElement>('.file-card__collapsed--file')?.click();
            await Promise.resolve();
        });

        expect(parsed).toContain(file?.fileId);
    });

    it('still requests parsing for a file collapsed due to size', async () => {
        const source = DATA.diff.files.find((file) => file.path === 'services/orders/src/domain/order.ts');
        if (source === undefined) {
            throw new Error('the medium fixture needs order.ts');
        }
        const big = { ...source, additions: COLLAPSE_THRESHOLD + 1 };
        const { parsed } = mount({ files: [big], ownStore: true, route: false });

        await act(async () => {
            await Promise.resolve();
        });

        expect(parsed).toContain(big.fileId);
    });

    it('has no route margins at all without a route: no badges, strips or note', () => {
        const { host } = mount({ route: false });

        expect(host.querySelector('.route-badge')).toBeNull();
        expect(host.querySelector('.route-strip')).toBeNull();
        expect(host.querySelector('.file-panel__footer')).toBeNull();
    });
});
