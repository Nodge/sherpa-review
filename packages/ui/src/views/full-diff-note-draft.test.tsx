// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { AgentNote, ChatAnchor } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { createDiffViewStore } from '../diff-view/store.js';
import { noteDraftText } from '../notes/note-draft.js';
import { createSessionStore } from '../session/session-store.js';
import { createT } from '../i18n/index.js';
import { SettingsProvider } from '../settings/context.tsx';
import { createUiSettingsStore } from '../settings/settings-store.js';
import { createThreadStore } from '../threads/store.js';
import { DiffWorkspace } from './full-diff.tsx';

/**
 * "Turn into a comment draft" on an agent note: opens the composer at the same range with a quote,
 * keeps the note in place, and scrolls the open composer into view and focuses it.
 */

const DATA = fixtureIteration('medium');
const FILE = (() => {
    const file = DATA.diff.files.find((candidate) => candidate.path === 'services/orders/src/domain/edit-window.ts');
    if (file === undefined) {
        throw new Error('the medium fixture needs edit-window.ts');
    }
    return file;
})();
const NOTE_ANCHOR: ChatAnchor = { diffId: DATA.diff.diffId, fileId: FILE.fileId, path: FILE.path, side: 'new', start: 6, end: 8 };
const NOTE: AgentNote = {
    id: 7,
    exchangeId: 70,
    anchor: NOTE_ANCHOR,
    text: 'First line of the answer.\n\nSecond line of the answer.\n',
    lostAnchor: false,
    origin: { commit: 'abcdef1', anchor: NOTE_ANCHOR },
    createdAt: '2026-09-01T10:00:00.000Z',
};
const COMPOSER_KEY = `new:${FILE.fileId}:new:6`;

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
    window.localStorage.clear();
});

function mount() {
    // Deterministic editor layout: markdown uses a plain textarea instead of ProseMirror.
    const settings = createUiSettingsStore({ initial: { composerLayout: 'markdown' } });
    const host = document.createElement('div');
    document.body.append(host);
    const files = [FILE];
    const store = createDiffViewStore({ files });
    store.setModel(FILE.fileId, parseFileDiff(toParseRequest(FILE)));
    const threadStore = createThreadStore([], new Set([FILE.fileId]));
    const session = createSessionStore({
        initial: { view: 'diff', filter: 'all' },
    });
    const root = createRoot(host);
    act(() => {
        root.render(
            <SettingsProvider store={settings}>
                <DiffWorkspace
                    pr={DATA.pr}
                    diff={{ ...DATA.diff, files }}
                    lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
                    prKey="fixture-medium"
                    session={session}
                    store={store}
                    threadStore={threadStore}
                    threadNow={Date.parse('2026-09-01T12:00:00.000Z')}
                    parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                    loadContent={() => Promise.resolve(null)}
                    onSetViewed={() => Promise.resolve(0)}
                    notes={[NOTE]}
                />
            </SettingsProvider>,
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
        settle: async () => {
            for (let step = 0; step < 8; step += 1) {
                await act(async () => {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                });
            }
        },
    };
}

function draftButton(host: HTMLElement): HTMLButtonElement {
    const button = [...host.querySelectorAll<HTMLButtonElement>('.agent-note__actions button')].find(
        (candidate) => candidate.textContent === 'Turn into a comment draft',
    );
    if (button === undefined) {
        throw new Error('the expanded note has no "Turn into a comment draft" action');
    }
    return button;
}

describe('comment draft from an agent note', () => {
    it('opens the composer at the note anchor with a quote and leaves the note intact', async () => {
        const view = mount();
        await view.settle();

        act(() => {
            view.host.querySelector<HTMLButtonElement>('[data-note="7"]')?.click();
        });
        act(() => {
            draftButton(view.host).click();
        });

        const composer = view.threadStore.getComposer(COMPOSER_KEY);
        expect(composer?.anchor).toEqual({
            fileId: FILE.fileId,
            path: FILE.path,
            position: { side: 'new', line: 6, size: 3 },
        });
        expect(composer?.text).toBe(noteDraftText(NOTE, createT('en')));
        // The draft is unsaved. It goes to the host only on explicit save.
        expect(composer?.commentId).toBeNull();
        expect(composer?.status).toBe('idle');
        expect(view.host.querySelectorAll('[data-note="7"]')).toHaveLength(1);
        expect(view.store.getSnapshot().selection).toBeNull();
    });

    it('scrolls the open composer into view and focuses the field', async () => {
        const view = mount();
        await view.settle();
        act(() => {
            view.host.querySelector<HTMLButtonElement>('[data-note="7"]')?.click();
        });
        scrollIntoView.mockClear();

        act(() => {
            draftButton(view.host).click();
        });
        await view.settle();

        const node = view.host.querySelector<HTMLElement>(`[data-composer-key="${COMPOSER_KEY}"]`);
        expect(node).not.toBeNull();
        expect(scrollIntoView).toHaveBeenCalled();
        expect(node?.contains(document.activeElement)).toBe(true);
    });

    it('does not overwrite text the reviewer typed when the action repeats', async () => {
        const view = mount();
        await view.settle();
        act(() => {
            view.host.querySelector<HTMLButtonElement>('[data-note="7"]')?.click();
        });
        act(() => {
            draftButton(view.host).click();
        });
        act(() => {
            view.threadStore.updateComposer(COMPOSER_KEY, { text: 'my comment' });
        });

        act(() => {
            draftButton(view.host).click();
        });

        expect(view.threadStore.getComposer(COMPOSER_KEY)?.text).toBe('my comment');
    });
});
