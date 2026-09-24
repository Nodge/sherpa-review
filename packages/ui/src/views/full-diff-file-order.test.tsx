// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { PrDiff } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchReviewDiff } from '../api.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { createDiffViewStore } from '../diff-view/store.js';
import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { DiffWorkspace } from './full-diff.tsx';

/**
 * One file order: the left tree and right cards follow the same order even though the host returns files
 * in its own order. The diff follows the same path as in the app, through `fetchReviewDiff`.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The virtualizer renders nothing in jsdom without layout. Here it returns all rows at once.
vi.mock('@tanstack/react-virtual', () => ({
    defaultRangeExtractor: () => [],
    useVirtualizer: ({ count }: { count: number }) => ({
        getTotalSize: () => count * 26,
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                key: index,
                start: index * 26,
                size: 26,
                end: (index + 1) * 26,
                lane: 0,
            })),
        scrollToIndex: () => undefined,
        measureElement: () => undefined,
        measure: () => undefined,
        scrollOffset: 0,
        options: { scrollMargin: 0 },
    }),
}));

class NoopResizeObserver {
    observe(): void {
        // jsdom has no layout.
    }
    unobserve(): void {
        // See `observe`.
    }
    disconnect(): void {
        // See `observe`.
    }
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;

const DATA = fixtureIteration('medium');

const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

async function fetchedDiff(hostDiff: PrDiff): Promise<PrDiff> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        expect(url.split('?')[0]).toBe(UI_ENDPOINTS.reviewDiff);
        return Promise.resolve(
            new Response(JSON.stringify({ diff: hostDiff }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
    };
    try {
        return await fetchReviewDiff('token');
    } finally {
        globalThis.fetch = originalFetch;
    }
}

function mount(diff: PrDiff): HTMLElement {
    const store = createDiffViewStore({ files: diff.files });
    for (const file of diff.files) {
        store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <DiffWorkspace
                pr={DATA.pr}
                diff={diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
                prKey="fixture-medium"
                session={createSessionStore({ initial: { view: 'diff', filter: 'all' } })}
                store={store}
                threadStore={createThreadStore([], new Set(diff.files.map((file) => file.fileId)))}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
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
    return host;
}

const TREE_FILE_ROW = 'tree-row-' + encodeURIComponent('file:');

describe('full diff file order', () => {
    it('orders cards like the tree instead of the host', async () => {
        const diff = await fetchedDiff(DATA.diff);
        const host = mount(diff);
        const pathById = new Map(diff.files.map((file) => [file.fileId, file.path]));

        const treePaths = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')]
            .filter((row) => row.id.startsWith(TREE_FILE_ROW))
            .map((row) => decodeURIComponent(row.id.slice('tree-row-'.length)).slice('file:'.length));
        const cardPaths = [...host.querySelectorAll<HTMLElement>('article.file-card[data-file]')].map(
            (card) => pathById.get(card.dataset.file ?? '') ?? '',
        );

        // The fixture deliberately follows host order. Without converting to tree order, the test would check nothing.
        expect(DATA.diff.files.map((file) => file.path)).not.toEqual(treePaths);
        expect(treePaths).toHaveLength(DATA.diff.files.length);
        expect(cardPaths).toEqual(treePaths);
        expect(diff.files.map((file) => file.path)).toEqual(treePaths);
    });
});
