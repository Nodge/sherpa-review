// @vitest-environment jsdom
import { fixtureInterdiff, fixtureIteration } from '@sherpa/fixtures';
import type { UiChatAskAnchor } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { lineKey } from '../diff-view/selection.js';
import { createDiffViewStore } from '../diff-view/store.js';
import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { DiffWorkspace } from './full-diff.tsx';

/**
 * Inter-iteration slice in the reader: slice files have `fileId` values from another
 * namespace, so an agent question cannot attach to them through either the popover button or the anchor in the chat
 * composer.
 */

const V2 = fixtureIteration('medium', 1);
const SLICE = fixtureInterdiff('medium', 0, 1);
const FILE = (() => {
    const file = SLICE.files[0];
    if (file === undefined) {
        throw new Error('the medium interdiff needs at least one file');
    }
    return file;
})();
const MODEL = parseFileDiff(toParseRequest(FILE));
const ADDED_LINE = addedLineKey(MODEL);
const SLICE_COMMITS = {
    baseCommit: fixtureIteration('medium', 0).iteration.headCommit,
    headCommit: V2.iteration.headCommit,
};

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

const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

function mount(slice: boolean) {
    const host = document.createElement('div');
    document.body.append(host);
    const files = [FILE];
    const store = createDiffViewStore({ files });
    store.setModel(FILE.fileId, MODEL);
    const threadStore = createThreadStore([], new Set([FILE.fileId]));
    const session = createSessionStore({ initial: { view: 'diff', filter: 'all' } });
    const onSelectionAnchorChange = vi.fn<(anchor: UiChatAskAnchor | null) => void>();
    const root = createRoot(host);
    act(() => {
        root.render(
            <DiffWorkspace
                pr={V2.pr}
                diff={{ ...SLICE, files }}
                lenses={{ ownership: null, extra: [] }}
                prKey="fixture-medium"
                session={session}
                store={store}
                threadStore={threadStore}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                slice={slice ? SLICE_COMMITS : null}
                agentConnected
                onAskSelection={() => undefined}
                onSelectionAnchorChange={onSelectionAnchorChange}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={() => Promise.resolve(null)}
                onSetViewed={() => Promise.resolve(0)}
            />,
        );
    });
    cleanups.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { host, store, onSelectionAnchorChange };
}

/** First added line in the file. It has an unambiguous side, so a question anchor can be built. */
function addedLineKey(model: DiffFileModel): string {
    if (model.content.kind === 'text') {
        for (const block of model.content.blocks) {
            if (block.kind !== 'hunk') {
                continue;
            }
            for (const line of block.lines) {
                const key = line.kind === 'add' ? lineKey(line) : null;
                if (key !== null) {
                    return key;
                }
            }
        }
    }
    throw new Error('the interdiff file has no added lines');
}

function askButton(host: HTMLElement): HTMLButtonElement {
    const button = [...host.querySelectorAll<HTMLButtonElement>('.selection-popover__button')].find(
        (candidate) => candidate.textContent === 'Ask the agent',
    );
    if (button === undefined) {
        throw new Error('the selection popover has no question button');
    }
    return button;
}

describe('selection in an inter-iteration slice', () => {
    it('disables the agent question with a reason and does not send the anchor to chat', () => {
        const view = mount(true);
        act(() => {
            view.store.startSelection(FILE.fileId, ADDED_LINE);
        });

        const ask = askButton(view.host);
        expect(ask.disabled).toBe(true);
        expect(ask.title).toBe('a question in a slice cannot be tied to a file — ask in the active iteration');
        expect(view.onSelectionAnchorChange.mock.calls.some(([anchor]) => anchor !== null)).toBe(false);
    });

    it('allows a question outside a slice and sends the anchor to the chat composer', () => {
        const view = mount(false);
        act(() => {
            view.store.startSelection(FILE.fileId, ADDED_LINE);
        });

        expect(askButton(view.host).disabled).toBe(false);
        expect(view.onSelectionAnchorChange.mock.calls.some(([anchor]) => anchor !== null)).toBe(true);
    });
});
