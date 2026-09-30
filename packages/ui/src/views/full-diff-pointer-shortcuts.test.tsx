// @vitest-environment jsdom
import { fileContentOf, fixtureIteration } from '@sherpa/fixtures';
import type { Thread } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { hunkContextRequests } from '../diff-view/hunk-expansion.js';
import { lineAt } from '../diff-view/line-target.js';
import { lineKey } from '../diff-view/selection.js';
import { createDiffViewStore } from '../diff-view/store.js';
import { createSessionStore } from '../session/session-store.js';
import { ShortcutsProvider } from '../shortcuts/context.tsx';
import type { PointerTarget } from '../shortcuts/pointer-target.js';
import type { ShortcutRegistry } from '../shortcuts/registry.js';
import { createShortcutRegistry } from '../shortcuts/registry.js';
import { createThreadStore } from '../threads/store.js';
import { DiffWorkspace } from './full-diff.tsx';

/**
 * Full diff shortcuts for the target under the pointer (docs/design/SPEC-elements.md §5): nothing is focused, the pointer
 * simply rests over a line, file card or thread. The pointer monitor is mocked because `elementFromPoint`
 * is absent in jsdom. The "mouse or focus" rule is checked through what the monitor returns to the view.
 */

const DATA = fixtureIteration('medium');
const FILE = (() => {
    const file = DATA.diff.files.find((candidate) => candidate.path === 'services/orders/src/domain/edit-window.ts');
    if (file === undefined) {
        throw new Error('the medium fixture needs edit-window.ts');
    }
    return file;
})();
const SECOND_FILE = (() => {
    const file = DATA.diff.files.find((candidate) => candidate.path === 'services/orders/src/domain/order.ts');
    if (file === undefined) {
        throw new Error('the medium fixture needs order.ts');
    }
    return file;
})();
const THREAD: Thread = (() => {
    const thread = DATA.threads.find((candidate) => candidate.anchor?.fileId === FILE.fileId);
    if (thread === undefined) {
        throw new Error('the medium fixture needs a thread on edit-window.ts');
    }
    return thread;
})();

/** Key of a line in the second file with context to expand. The adjacent gap makes `e` available. */
const GAP_ROW_KEY = (() => {
    const model = parseFileDiff(toParseRequest(SECOND_FILE));
    if (model.content.kind !== 'text') {
        throw new Error('the test needs a text model');
    }
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            const side = line.newLine === null ? 'old' : 'new';
            const number = side === 'new' ? line.newLine : line.oldLine;
            const key = lineKey(line);
            if (number !== null && key !== null && hunkContextRequests(model, side, number).length > 0) {
                return key;
            }
        }
    }
    throw new Error('the fixture needs a hunk line beside a gap');
})();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWPORT_WIDTH = 900;
const VIEWPORT_HEIGHT = 700;

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {
        // Width never changes in jsdom.
    }
    unobserve(): void {
        // See `observe`.
    }
    disconnect(): void {
        // See `observe`.
    }
};

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
/** Scroll destinations. This list shows whether line navigation found its target. */
const scrolled: HTMLElement[] = [];
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: function record(this: HTMLElement): void {
        scrolled.push(this);
    },
});

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    scrolled.length = 0;
});

interface MountOptions {
    /** Line navigation anchor (deep link, palette, jump from route). */
    readonly selectionTarget?: { readonly fileId: string; readonly side: 'old' | 'new'; readonly start: number };
}

function mount(options: MountOptions = {}) {
    const host = document.createElement('div');
    document.body.append(host);
    const files = [FILE, SECOND_FILE];
    const store = createDiffViewStore({ files });
    for (const file of files) {
        store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
    }
    const threads = DATA.threads.filter((thread) => thread.anchor?.fileId === FILE.fileId);
    const threadStore = createThreadStore(threads, new Set(files.map((file) => file.fileId)));
    const session = createSessionStore({ initial: { view: 'diff', filter: 'all' } });
    const registry = createShortcutRegistry();
    registry.setActiveScope('full-diff');
    // Pointer monitor: the test specifies what is under the mouse. `null` means the mouse was not the latest signal.
    let hovered: Element | null = null;
    const pointer: PointerTarget = {
        hovered: () => hovered,
        target: (selector) => hovered?.closest(selector) ?? document.activeElement?.closest(selector) ?? null,
        dispose: () => undefined,
    };
    const viewedWrites: { fileId: string; viewed: boolean }[] = [];
    const root = createRoot(host);
    act(() => {
        root.render(
            <ShortcutsProvider registry={registry} pointer={pointer}>
                <DiffWorkspace
                    pr={DATA.pr}
                    diff={{ ...DATA.diff, files }}
                    lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                    prKey="fixture-medium"
                    session={session}
                    store={store}
                    threadStore={threadStore}
                    threads={threads}
                    threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                    parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                    loadContent={(fileId) => {
                        const file = files.find((candidate) => candidate.fileId === fileId);
                        return Promise.resolve(file === undefined ? null : fileContentOf(file));
                    }}
                    initialSelectionTarget={options.selectionTarget ?? null}
                    onSetViewed={(fileId, viewed) => {
                        viewedWrites.push({ fileId, viewed });
                        return Promise.resolve(viewedWrites.length);
                    }}
                />
            </ShortcutsProvider>,
        );
    });
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
        viewedWrites,
        hover: (element: Element | null) => {
            hovered = element;
        },
        press: (key: string) => {
            press(registry, key);
        },
        settle: async () => {
            for (let step = 0; step < 6; step += 1) {
                await act(async () => {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                });
            }
        },
    };
}

/** Send the keypress through the registry, exactly as the page's only listener does. */
function press(registry: ShortcutRegistry, key: string): void {
    act(() => {
        registry.handle({
            key,
            code: `Key${key.toUpperCase()}`,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            altKey: false,
            target: document.body,
            preventDefault: () => undefined,
        });
    });
}

function element(host: HTMLElement, selector: string): HTMLElement {
    const found = host.querySelector<HTMLElement>(selector);
    if (found === null) {
        throw new Error(`no ${selector} in the markup`);
    }
    return found;
}

/** The list card itself. Tree rows also carry `data-file` and appear earlier in the markup. */
function card(host: HTMLElement, fileId: string): HTMLElement {
    return element(host, `.file-card[data-file="${CSS.escape(fileId)}"]`);
}

describe('full diff shortcuts for the target under the pointer', () => {
    it('opens the composer on the unfocused line under the pointer with c', () => {
        const view = mount();
        view.hover(element(view.host, `.file-card[data-file="${CSS.escape(FILE.fileId)}"] [data-key="a6"]`));

        view.press('c');

        expect(document.activeElement).toBe(document.body);
        expect(view.threadStore.getComposer(`new:${FILE.fileId}:new:6`)?.anchor?.position).toEqual({
            side: 'new',
            line: 6,
            size: 1,
        });
    });

    it('opens a reply in the thread under the pointer with r', () => {
        const view = mount();
        view.hover(element(view.host, `[data-thread-id="${CSS.escape(THREAD.id)}"] .thread__row`));

        view.press('r');

        expect(view.threadStore.getComposer(`reply:${THREAD.id}`)?.threadId).toBe(THREAD.id);
    });

    it('requests context expansion for the hunk under the pointer with e', async () => {
        const view = mount();
        view.hover(
            element(view.host, `.file-card[data-file="${CSS.escape(SECOND_FILE.fileId)}"] [data-key="${GAP_ROW_KEY}"]`),
        );

        view.press('e');
        await view.settle();

        expect(view.store.getSnapshot().expansion.get(SECOND_FILE.fileId)?.size).toBeGreaterThan(0);
    });

    it('marks the file of the card under the pointer with v', async () => {
        const view = mount();
        view.hover(card(view.host, SECOND_FILE.fileId));

        view.press('v');
        await view.settle();

        expect(view.viewedWrites).toEqual([{ fileId: SECOND_FILE.fileId, viewed: true }]);
        expect(view.store.getSnapshot().readState.get(SECOND_FILE.fileId)?.state).toBe('read');
    });

    it('marks the file of the tree row under the pointer with v', async () => {
        const view = mount();
        const row = [...view.host.querySelectorAll<HTMLElement>('.file-tree__row--file')].find(
            (candidate) => candidate.dataset.file === SECOND_FILE.fileId,
        );
        if (row === undefined) {
            throw new Error('no row for the second file in the tree');
        }
        view.hover(row);

        view.press('v');
        await view.settle();

        expect(view.viewedWrites).toEqual([{ fileId: SECOND_FILE.fileId, viewed: true }]);
    });

    it('uses the focused target when focus is more recent than pointer input', () => {
        const view = mount();
        const focused = element(view.host, `.file-card[data-file="${CSS.escape(FILE.fileId)}"] [data-key="a7"]`);
        act(() => {
            focused.focus();
        });
        // The mouse has not moved since focus changed, so the pointer monitor gives no target under the cursor.
        view.hover(null);

        view.press('c');

        expect(view.threadStore.getComposer(`new:${FILE.fileId}:new:7`)?.anchor?.position?.line).toBe(7);
        expect(view.threadStore.getComposer(`new:${FILE.fileId}:new:6`)).toBeNull();
    });
});

describe('line navigation when the tree carries the same data-file', () => {
    it('reaches the card line instead of stopping at the tree row', async () => {
        const view = mount({ selectionTarget: { fileId: FILE.fileId, side: 'new', start: 6 } });
        await view.settle();

        const target = scrolled.find((node) => node.closest('.file-card') !== null);
        expect(target).toBeDefined();
        expect(lineAt(target)).toEqual({ fileId: FILE.fileId, side: 'new', line: 6 });
    });
});
