// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteWorkspace } from './route-workspace.tsx';

/**
 * The "what is new" filter is enabled outside the view (the second pass banner button), so the test mounts
 * the live view in jsdom: the top stop that the filter would hide must stay on screen,
 * just as it does when the file filter changes (docs/design/SPEC-elements.md §2.7).
 *
 * jsdom has no rectangles, so measurements are mocked to make the first section
 * in the markup the top stop. The filter must keep that section in view.
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
const KEPT_NOTE = 'kept in view — outside the current filter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
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

function rect(top: number, bottom: number): DOMRect {
    return {
        top,
        bottom,
        left: 0,
        right: 0,
        width: 0,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({}),
    };
}

beforeEach(() => {
    // Stop sections are the only elements with height, so the anchor falls on the first one.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function stubbed(this: Element): DOMRect {
        return this instanceof HTMLElement && this.dataset.stop !== undefined ? rect(0, 100) : rect(0, 0);
    });
});

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    vi.restoreAllMocks();
});

/** Classify all stops except one, which becomes the top stop outside the filter. */
function snapshotChangedExcept(stopId: string): RouteSnapshot {
    return {
        ...SNAPSHOT,
        previousSnapshotId: 'route-medium-9f3c1ab',
        carried: { kept: 4, total: 7, zeroReason: null },
        stops: SNAPSHOT.stops.map((stop) =>
            stop.id === stopId ? stop : { ...stop, change: { kind: 'changed', reason: null, threadIds: [] } },
        ),
    };
}

function mount(snapshot: RouteSnapshot) {
    const host = document.createElement('div');
    document.body.append(host);
    const store = createDiffViewStore({ files: DATA.diff.files });
    for (const file of DATA.diff.files) {
        store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
    }
    const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
    const root = createRoot(host);
    act(() => {
        root.render(
            <RouteWorkspace
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
                snapshot={snapshot}
                session={session}
                store={store}
                threadStore={createThreadStore(DATA.threads, FILE_IDS)}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
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
    return { host, session };
}

/** The first stop section in the markup, at the top of the viewport in the mocked measurements. */
function topStopId(host: HTMLElement): string {
    const section = host.querySelector<HTMLElement>('[data-stop]');
    if (section?.dataset.stop === undefined) {
        throw new Error('the route view rendered no stops');
    }
    return section.dataset.stop;
}

function stopIds(host: HTMLElement): string[] {
    return [...host.querySelectorAll<HTMLElement>('[data-stop]')].map((section) => section.dataset.stop ?? '');
}

describe('the "what is new" filter and the stop kept in view', () => {
    it('keeps the unchanged top stop on screen with a note', () => {
        const first = topStopId(mount(SNAPSHOT).host);
        const { host, session } = mount(snapshotChangedExcept(first));

        expect(topStopId(host)).toBe(first);

        act(() => {
            session.setRouteFilter('new');
        });

        expect(stopIds(host)).toContain(first);
        expect(host.textContent).toContain(KEPT_NOTE);
    });

    it('the changed top stop passes the filter, so there is nothing to keep', () => {
        // All stops have a classification. The empty id matches none of them.
        const { host, session } = mount(snapshotChangedExcept(''));

        act(() => {
            session.setRouteFilter('new');
        });

        expect(host.textContent).not.toContain(KEPT_NOTE);
    });

    it('removes the note on returning to the full route', () => {
        const first = topStopId(mount(SNAPSHOT).host);
        const { host, session } = mount(snapshotChangedExcept(first));

        act(() => {
            session.setRouteFilter('new');
        });
        act(() => {
            session.setRouteFilter('all');
        });

        expect(host.textContent).not.toContain(KEPT_NOTE);
    });
});
