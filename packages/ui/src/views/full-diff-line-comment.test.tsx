// @vitest-environment jsdom
import { fixtureData } from '@sherpa/fixtures';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { createDiffViewStore } from '../diff-view/store.js';
import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { DiffWorkspace } from './full-diff.tsx';

/**
 * Line comment in the full diff: the selection moves into the composer anchor and ends
 * there, otherwise the line pencil stays visible outside hover and the next comment
 * receives the previous range.
 */

const DATA = fixtureData('medium');
const FILE = (() => {
    const file = DATA.diff.files.find((candidate) => candidate.path === 'services/orders/src/domain/edit-window.ts');
    if (file === undefined) {
        throw new Error('the medium fixture needs edit-window.ts');
    }
    return file;
})();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWPORT_WIDTH = 900;
const VIEWPORT_HEIGHT = 700;

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

// All rectangles are zero-sized in jsdom. Without dimensions, the virtualizer renders no rows.
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

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount() {
    const host = document.createElement('div');
    document.body.append(host);
    const files = [FILE];
    const store = createDiffViewStore({ files, storage: null });
    store.setModel(FILE.fileId, parseFileDiff(toParseRequest(FILE)));
    const threadStore = createThreadStore([], new Set([FILE.fileId]));
    const session = createSessionStore({
        initial: { view: 'diff', filter: 'all', threadsShow: { people: true, bots: true, resolved: false } },
    });
    const root = createRoot(host);
    act(() => {
        root.render(
            <DiffWorkspace
                pr={DATA.pr}
                diff={{ ...DATA.diff, files }}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
                prKey="fixture-medium"
                session={session}
                store={store}
                threadStore={threadStore}
                collapsedStorage={null}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={() => Promise.resolve(null)}
                onSetViewed={() => Promise.resolve(0)}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { host, store, threadStore };
}

function pencil(host: HTMLElement, line: number): HTMLButtonElement {
    const button = host.querySelector<HTMLButtonElement>(`[aria-label="Comment on line ${String(line)}"]`);
    if (button === null) {
        throw new Error(`no pencil for line ${String(line)}`);
    }
    return button;
}

describe('comment from a full diff line', () => {
    it('moves the selected range into the anchor and clears the selection', () => {
        const { host, store, threadStore } = mount();
        act(() => {
            store.startSelection(FILE.fileId, 'a6');
            store.extendSelection(FILE.fileId, 'a8');
        });
        expect(pencil(host, 6).classList.contains('is-selection-start')).toBe(true);

        act(() => {
            pencil(host, 6).click();
        });

        expect(threadStore.getComposer(`new:${FILE.fileId}:new:6`)?.anchor?.position).toEqual({
            side: 'new',
            line: 6,
            size: 3,
        });
        expect(store.getSnapshot().selection).toBeNull();
        expect(pencil(host, 6).classList.contains('is-selection-start')).toBe(false);
    });

    it('comments on one line without a selection and leaves no selection behind', () => {
        const { host, store, threadStore } = mount();

        act(() => {
            pencil(host, 6).click();
        });

        expect(threadStore.getComposer(`new:${FILE.fileId}:new:6`)?.anchor?.position).toEqual({
            side: 'new',
            line: 6,
            size: 1,
        });
        expect(store.getSnapshot().selection).toBeNull();
    });
});
