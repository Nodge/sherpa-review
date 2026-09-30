// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { FileContent, FileDiff } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { findLineRow } from '../diff-view/line-target.js';
import { createDiffViewStore } from '../diff-view/store.js';
import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { DiffWorkspace } from './full-diff.tsx';

/**
 * Line comment in the full diff: the selection moves into the composer anchor and ends
 * there, otherwise the line pencil stays visible outside hover and the next comment
 * receives the previous range.
 */

const DATA = fixtureIteration('medium');
const FILE = (() => {
    const file = DATA.diff.files.find((candidate) => candidate.path === 'services/orders/src/domain/edit-window.ts');
    if (file === undefined) {
        throw new Error('the medium fixture needs edit-window.ts');
    }
    return file;
})();
const NAV_FILE: FileDiff = {
    ...FILE,
    fileId: 'navigation-context',
    path: 'src/navigation-context.ts',
    additions: 1,
    deletions: 1,
    patch: ['@@ -10,2 +10,2 @@', '-old value', '+new value', ' tail'].join('\n'),
};
const NAV_LINES = Array.from({ length: 20 }, (_, index) => `line-${String(index + 1)}`);
const NAV_CONTENT: FileContent = { oldText: NAV_LINES.join('\n'), newText: NAV_LINES.join('\n') };

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
const scrollIntoView = vi.fn();
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    scrollIntoView.mockClear();
});

function mount(options: {
    readonly initialSelectionTarget?: { readonly fileId: string; readonly side: 'old' | 'new'; readonly start: number };
    readonly loadContent?: (fileId: string) => Promise<FileContent | null>;
    readonly file?: FileDiff;
} = {}) {
    const host = document.createElement('div');
    document.body.append(host);
    const file = options.file ?? FILE;
    const files = [file];
    const store = createDiffViewStore({ files });
    store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
    const threadStore = createThreadStore([], new Set([file.fileId]));
    const session = createSessionStore({
        initial: { view: 'diff', filter: 'all' },
    });
    const root = createRoot(host);
    let selectionNavigationRequest = 0;
    const render = (): void => {
        root.render(
            <DiffWorkspace
                pr={DATA.pr}
                diff={{ ...DATA.diff, files }}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                prKey="fixture-medium"
                session={session}
                store={store}
                threadStore={threadStore}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={options.loadContent ?? (() => Promise.resolve(null))}
                onSetViewed={() => Promise.resolve(0)}
                initialSelectionTarget={options.initialSelectionTarget ?? null}
                selectionNavigationRequest={selectionNavigationRequest}
            />,
        );
    };
    act(render);
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return {
        host,
        store,
        threadStore,
        repeatSelectionNavigation: () => {
            selectionNavigationRequest += 1;
            act(render);
        },
        settle: async () => {
            for (let step = 0; step < 8; step += 1) {
                await act(async () => {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                });
            }
        },
    };
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

describe('full diff line navigation', () => {
    it('navigates to the same anchor again when the request counter changes', async () => {
        const view = mount({
            initialSelectionTarget: { fileId: FILE.fileId, side: 'new', start: 6 },
        });
        await view.settle();
        scrollIntoView.mockClear();

        view.repeatSelectionNavigation();
        await view.settle();

        expect(scrollIntoView).toHaveBeenCalled();
    });

    it('expands context before looking for the line in the DOM', async () => {
        const raw = parseFileDiff(toParseRequest(NAV_FILE));
        if (raw.content.kind !== 'text') {
            throw new Error('the test needs a text model');
        }
        const gap = raw.content.blocks.find((block) => block.kind === 'gap');
        if (gap?.kind !== 'gap') {
            throw new Error('the test needs hidden context');
        }
        const target = gap.newStart;
        const view = mount({
            file: NAV_FILE,
            initialSelectionTarget: { fileId: NAV_FILE.fileId, side: 'new', start: target },
            loadContent: () => Promise.resolve(NAV_CONTENT),
        });

        expect(findLineRow(view.host, 'new', target)).toBeNull();
        await view.settle();

        expect(view.store.getSnapshot().expansion.get(NAV_FILE.fileId)?.size).toBeGreaterThan(0);
        expect(findLineRow(view.host, 'new', target)).not.toBeNull();
    });
});

describe('comments in Markdown and code', () => {
    it('maps selected words to the source range and keeps the composer when switching views', () => {
        const file: FileDiff = {
            ...FILE,
            fileId: 'markdown',
            path: 'docs/review.md',
            changeType: 'add',
            additions: 4,
            deletions: 0,
            patch: '@@ -0,0 +1,4 @@\n+# Document\n+\n+First **sentence**.\n+Second sentence.',
        };
        const view = mount({ file });
        const button = (text: string) => {
            const found = [...view.host.querySelectorAll<HTMLButtonElement>('button')].find(
                (candidate) => candidate.textContent.trim() === text,
            );
            if (found === undefined) {
                throw new Error(`no button ${text}`);
            }
            return found;
        };

        act(() => {
            button('Markdown').click();
        });
        const first = view.host.querySelector('strong')?.firstChild;
        const last = view.host.querySelector('[data-source-line="4"]')?.firstChild;
        if (first === null || first === undefined || last === null || last === undefined) {
            throw new Error('no document');
        }
        const range = document.createRange();
        range.setStart(first, 0);
        range.setEnd(last, 6);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        act(() => {
            view.host.querySelector('.markdown-review')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        });
        expect(view.store.getSnapshot().selection).toMatchObject({
            fileId: 'markdown',
            side: 'new',
            anchor: 'a3',
            focus: 'a4',
        });
        expect(view.store.getSnapshot().selection?.selectedText).toContain('sentence');

        act(() => {
            button('Comment').click();
        });
        expect(view.threadStore.getComposer('new:markdown:new:3')?.anchor?.position).toEqual({
            side: 'new',
            line: 3,
            size: 2,
        });
        expect(view.host.querySelectorAll('.thread-composer')).toHaveLength(1);

        act(() => {
            button('Code').click();
        });
        expect(view.host.querySelectorAll('.thread-composer')).toHaveLength(1);
        act(() => {
            button('Markdown').click();
        });
        expect(view.host.querySelectorAll('.thread-composer')).toHaveLength(1);
    });
});
