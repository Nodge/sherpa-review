// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import type { DiffViewStore } from '../../diff-view/store.js';
import { createSessionStore } from '../../session/session-store.js';
import type { SessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import type { ThreadStore } from '../../threads/store.js';
import { openReply } from '../../threads/thread-list.tsx';
import { RouteWorkspace } from './route-workspace.tsx';

/**
 * Remove a distant stop diff column from the DOM. jsdom has neither layout nor
 * observers, so both are mocked: `IntersectionObserver` lets the test trigger hysteresis
 * boundaries manually, and the column `offsetHeight` supplies a nonzero height for the placeholder.
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

/**
 * File card height. jsdom reports zero sizes, but the placeholder needs a real one.
 * The column is measured as a count of cards, so the placeholder height reveals
 * both the number of cards in the stop and whether it was measured again at all.
 */
let cardHeight = 100;

/** Column height, matching what the browser would measure from the rendered cards. */
function columnHeight(cards: number): string {
    return `${String(cards * cardHeight)}px`;
}

/** First stop in the plan. Its column is never removed. */
const FIRST_STOP = 's01';
/** A stop with seven files, four in the My files lens and one with a thread. */
const WIDE_STOP = 's03';
/** Thread in a `WIDE_STOP` file, used to test the reply that keeps the column mounted. */
const WIDE_STOP_THREAD = '4820242';
const WIDE_STOP_FILES = 7;
/** Number of `WIDE_STOP` files remaining under the My files lens. */
const WIDE_STOP_MINE_FILES = 4;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeObserver {
    readonly rootMargin: string;
    readonly callback: IntersectionObserverCallback;
    readonly elements: Set<Element>;
}

const observers: FakeObserver[] = [];

class FakeIntersectionObserver {
    private readonly record: FakeObserver;

    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.record = { rootMargin: options?.rootMargin ?? '0px', callback, elements: new Set() };
        observers.push(this.record);
    }

    observe(element: Element): void {
        this.record.elements.add(element);
    }

    unobserve(element: Element): void {
        this.record.elements.delete(element);
    }

    disconnect(): void {
        const index = observers.indexOf(this.record);
        if (index >= 0) {
            observers.splice(index, 1);
        }
    }
}

/** Toolbar and diff column observers only need a stub because jsdom has no layout. */
class FakeResizeObserver {
    observe(): void {
        // jsdom has no layout, so there is nothing to observe.
    }
    unobserve(): void {
        // jsdom has no layout, so there is nothing to observe.
    }
    disconnect(): void {
        // jsdom has no layout, so there is nothing to observe.
    }
}

beforeEach(() => {
    observers.length = 0;
    cardHeight = 100;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIntersectionObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        get(this: HTMLElement) {
            return this.classList.contains('route-stop__diff')
                ? this.querySelectorAll('.file-card').length * cardHeight
                : 0;
        },
    });
});

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

/** Tell the observer with this boundary whether the stop section intersects it. */
function report(section: Element, rootMargin: string, isIntersecting: boolean): void {
    for (const observer of [...observers]) {
        if (observer.rootMargin !== rootMargin || !observer.elements.has(section)) {
            continue;
        }
        observer.callback(
            [{ isIntersecting, target: section } as unknown as IntersectionObserverEntry],
            observer as unknown as IntersectionObserver,
        );
    }
}

/** The stop appeared on screen and moved past the far boundary, as it does during a route pass. */
function passBy(section: Element): void {
    act(() => {
        report(section, '800px', true);
        report(section, '1200px', true);
    });
    act(() => {
        report(section, '2500px', false);
    });
}

function sections(host: HTMLElement): HTMLElement[] {
    return [...host.querySelectorAll<HTMLElement>('[data-stop]')];
}

function section(host: HTMLElement, stopId: string): HTMLElement {
    const found = host.querySelector<HTMLElement>(`[data-stop="${stopId}"]`);
    if (found === null) {
        throw new Error(`the route view did not render stop ${stopId}`);
    }
    return found;
}

function placeholder(section: HTMLElement): HTMLElement | null {
    return section.querySelector<HTMLElement>('.route-stop__placeholder');
}

interface MountResult {
    readonly host: HTMLElement;
    readonly store: DiffViewStore;
    readonly session: SessionStore;
    readonly threadStore: ThreadStore;
}

/** `parsed: false` means no parsed models. Cards show parsing skeletons. */
function mount({ parsed = true }: { readonly parsed?: boolean } = {}): MountResult {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createDiffViewStore({ files: DATA.diff.files });
    if (parsed) {
        for (const file of DATA.diff.files) {
            store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
    }
    const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
    const threadStore = createThreadStore(DATA.threads, FILE_IDS);
    const root = createRoot(host);

    act(() => {
        root.render(
            <RouteWorkspace
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: [...DATA.extraLenses], ownershipSource: 'CODEOWNERS' }}
                snapshot={SNAPSHOT}
                session={session}
                store={store}
                threadStore={threadStore}
                progressLoaded
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                parse={
                    parsed
                        ? (file) => Promise.resolve(parseFileDiff(toParseRequest(file)))
                        : // Parsing never finishes, so the cards never get a model.
                          () => new Promise(() => undefined)
                }
                loadContent={() => Promise.resolve(null)}
                onSetViewed={() => Promise.resolve(0)}
                onSetStopViewed={() => Promise.resolve(0)}
                onSetStopFileViewed={() => Promise.resolve(0)}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { host, store, session, threadStore };
}

describe('offscreen stop diff column', () => {
    it('leaves the DOM but keeps the section and a placeholder at the measured height', () => {
        const { host } = mount();
        const wide = section(host, WIDE_STOP);
        const stopCount = sections(host).length;

        act(() => {
            report(wide, '800px', true);
        });
        const cards = wide.querySelectorAll('.file-card').length;
        expect(cards).toBeGreaterThan(0);
        act(() => {
            report(wide, '2500px', false);
        });

        expect(placeholder(wide)?.style.height).toBe(columnHeight(cards));
        expect(wide.querySelectorAll('.file-card')).toHaveLength(0);
        // Sections remain. Jumps, top stop selection and e2e depend on them.
        expect(sections(host)).toHaveLength(stopCount);
        expect(wide.querySelector('.route-stop__side')).not.toBeNull();

        act(() => {
            report(wide, '1200px', true);
        });
        expect(placeholder(wide)).toBeNull();
        expect(wide.querySelectorAll('.file-card').length).toBeGreaterThan(0);
    });

    it('keeps the first stop mounted even far offscreen', () => {
        const { host } = mount();
        const first = section(host, FIRST_STOP);
        const cards = first.querySelectorAll('.file-card').length;
        expect(cards).toBeGreaterThan(0);

        passBy(first);

        expect(placeholder(first)).toBeNull();
        expect(first.querySelectorAll('.file-card')).toHaveLength(cards);
    });

    it('keeps a stop that has never been on screen because there is nothing to measure', () => {
        const { host } = mount();
        const wide = section(host, WIDE_STOP);

        // It has never been on screen, so only the first cards in the list have rendered (`lazyCards`),
        // and their height says nothing about the full column height.
        act(() => {
            report(wide, '2500px', false);
        });

        expect(placeholder(wide)).toBeNull();
    });

    it('does not measure the column until the stop files are parsed', () => {
        const { host, store } = mount({ parsed: false });
        const wide = section(host, WIDE_STOP);

        passBy(wide);
        // Do not cache parsing skeleton heights, or the placeholder could be off by an entire card.
        expect(placeholder(wide)).toBeNull();

        act(() => {
            for (const file of DATA.diff.files) {
                store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
            }
        });

        // Parsing has finished. Height is measured from real cards, so the column can be removed.
        expect(placeholder(wide)?.style.height).toBe(columnHeight(WIDE_STOP_FILES));
    });

    it('an open thread reply keeps its stop column mounted', () => {
        const { host, threadStore } = mount();
        const wide = section(host, WIDE_STOP);
        passBy(wide);
        expect(placeholder(wide)).not.toBeNull();

        const thread = threadStore.getSnapshot().threads.find((item) => item.id === WIDE_STOP_THREAD);
        if (thread === undefined) {
            throw new Error(`the medium fixture needs thread ${WIDE_STOP_THREAD}`);
        }
        act(() => {
            // The reply has no anchor. The file is in use through the thread, not the line layout.
            openReply(threadStore, thread, false);
        });

        expect(placeholder(wide)).toBeNull();
        expect(wide.querySelectorAll('.file-card').length).toBeGreaterThan(0);
    });

    it('a lens change remounts a stop column whose file set changed', () => {
        const { host, session } = mount();
        const wide = section(host, WIDE_STOP);
        passBy(wide);
        expect(placeholder(wide)).not.toBeNull();

        expect(placeholder(wide)?.style.height).toBe(columnHeight(WIDE_STOP_FILES));

        act(() => {
            // My files leaves 4 of the 7 files in this stop, so the old height would be wrong.
            session.setFilter('mine');
        });

        // The column remounted, measured its new file set and unmounted again.
        expect(placeholder(wide)?.style.height).toBe(columnHeight(WIDE_STOP_MINE_FILES));
    });

    it('collapsing a card in one stop does not remount columns in other stops', () => {
        const { host, store } = mount();
        const wide = section(host, WIDE_STOP);
        passBy(wide);
        const height = placeholder(wide)?.style.height;
        expect(height).toBe(columnHeight(WIDE_STOP_FILES));

        // Remeasurement would change the height because cards have grown while the stop was unmounted.
        cardHeight = 200;
        const first = section(host, FIRST_STOP);
        const fileId = first.querySelector<HTMLElement>('.file-card[data-file]')?.dataset.file;
        if (fileId === undefined) {
            throw new Error('the first stop needs a file card');
        }
        act(() => {
            store.toggleFileCollapse(fileId);
        });

        // The layout key uses only this stop's files, so collapsing a card elsewhere does not affect it.
        expect(placeholder(wide)?.style.height).toBe(height);
    });
});
