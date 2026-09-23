import { comment, fixtureIteration, human, thread } from '@sherpa/fixtures';
import type { Thread } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ThreadsCollapse } from '../diff-view/file-card.tsx';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { useCardThreads, useThreadsCollapse } from './card-threads.tsx';
import type { IterationLayout } from './model.js';
import { createThreadStore } from './store.js';
import type { ThreadStore } from './store.js';
import { openFileComposer, openReply } from './thread-list.tsx';

/**
 * Where a file card places a thread pinned to a previous iteration: in the active
 * iteration, its outdated anchor moves it below the header. In its pinned iteration it sits by the lines.
 */

const V1 = fixtureIteration('medium', 0);
const V2 = fixtureIteration('medium', 1);
const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const PATH = 'services/orders/src/api/handlers.ts';

const OUTDATED: Thread = (() => {
    const thread = V2.threads.find((candidate) => candidate.outdated && candidate.anchor?.path === PATH);
    if (thread === undefined) {
        throw new Error('the medium fixture needs an outdated thread on handlers.ts');
    }
    return thread;
})();

const ACTIONS = {
    transport: {
        save: () => Promise.reject(new Error('this test does not save')),
        update: () => Promise.reject(new Error('this test does not save')),
        delete: () => Promise.reject(new Error('this test does not save')),
    },
    resolve: () => Promise.resolve(true),
};

function fileOf(iteration: typeof V1, path: string) {
    const file = iteration.diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`iteration has no ${path}`);
    }
    return file;
}

function underHeader(iteration: typeof V1, layout: IterationLayout | null): string {
    const file = fileOf(iteration, PATH);
    const model = parseFileDiff(toParseRequest(file));
    const store = createThreadStore([OUTDATED], new Set([file.fileId]), layout);

    function Harness() {
        const { threadsUnderHeader } = useCardThreads({
            model,
            rowsShown: true,
            threads: [OUTDATED],
            composers: [],
            store,
            actions: ACTIONS,
            now: NOW,
            onFocusThread: () => undefined,
        });
        return <div>{threadsUnderHeader}</div>;
    }

    return renderToStaticMarkup(<Harness />);
}

const V1_LAYOUT: IterationLayout = {
    diffId: V1.diff.diffId,
    fileIdByPath: new Map(V1.diff.files.map((file) => [file.path, file.fileId])),
};

describe('thread placement in a file card', () => {
    it('moves an outdated thread below the file header in the active iteration', () => {
        expect(underHeader(V2, null)).toContain(`thread-${OUTDATED.id}`);
    });

    it('places the same thread by the lines in its pinned iteration, without showing it below the header', () => {
        expect(underHeader(V1, V1_LAYOUT)).not.toContain(`thread-${OUTDATED.id}`);
    });

    it('places the thread below the header again when its pin points to another iteration', () => {
        const alien: IterationLayout = { ...V1_LAYOUT, diffId: 'another-iteration' };

        expect(underHeader(V1, alien)).toContain(`thread-${OUTDATED.id}`);
    });

    /** An image comment has an anchor without a line and goes in the same place. */
    it('places a composer with an anchor without a line below the header, away from the lines', () => {
        const file = fileOf(V2, PATH);
        const store = createThreadStore([], new Set([file.fileId]));
        openFileComposer(store, file.fileId, file.path, false);
        const composer = store.getComposersSnapshot().byFile.get(file.fileId) ?? [];

        function Harness() {
            const { threadsUnderHeader, renderAfterLine } = useCardThreads({
                model: parseFileDiff(toParseRequest(file)),
                rowsShown: true,
                threads: [],
                composers: composer,
                store,
                actions: ACTIONS,
                now: NOW,
                onFocusThread: () => undefined,
            });
            return (
                <div>
                    <div data-slot="header">{threadsUnderHeader}</div>
                    <div data-slot="line">{renderAfterLine('new', 1)}</div>
                </div>
            );
        }

        const html = renderToStaticMarkup(<Harness />);
        const header = html.slice(html.indexOf('data-slot="header"'), html.indexOf('data-slot="line"'));

        expect(composer).toHaveLength(1);
        expect(composer[0]?.anchor?.position).toBeNull();
        expect(header).toContain('thread-composer');
        expect(header).toContain('A remark on the whole file');
        expect(html.slice(html.indexOf('data-slot="line"'))).not.toContain('thread-composer');
    });
});

const FILE = fileOf(V1, PATH);
const MODEL = parseFileDiff(toParseRequest(FILE));
const LINE = 48;

function lineThread(id: string, line: number, author = human('kai', 'Kai Kennedy')): Thread {
    return thread({
        id,
        anchor: { fileId: FILE.fileId, path: FILE.path, position: { side: 'new', line, size: 1 } },
        root: comment({ id: `${id}-root`, author, body: 'a question about the line', createdAt: '2026-08-24T10:00:00.000Z' }),
    });
}

describe('thread marker at the card edge', () => {
    function markerHtml(threads: readonly Thread[], line = LINE): string {
        const store = createThreadStore(threads, new Set([FILE.fileId]));
        store.setThreadsOpen(
            threads.map((item) => item.id),
            false,
        );

        function Harness() {
            const { renderLineMarker, renderAfterLine, lineThreadIds } = useCardThreads({
                model: MODEL,
                rowsShown: true,
                threads,
                composers: [],
                store,
                actions: ACTIONS,
                now: NOW,
                onFocusThread: () => undefined,
            });
            return (
                <div data-ids={lineThreadIds.join(',')}>
                    <div data-slot="marker">{renderLineMarker([{ side: 'new', line }])}</div>
                    <div data-slot="line">{renderAfterLine('new', line)}</div>
                </div>
            );
        }

        return renderToStaticMarkup(<Harness />);
    }

    it('places the marker at its line without adding it to other lines', () => {
        const html = markerHtml([lineThread('m1', LINE)]);
        const marker = html.slice(html.indexOf('data-slot="marker"'), html.indexOf('data-slot="line"'));

        expect(marker).toContain('thread-marker');
        expect(marker).toContain('aria-expanded="false"');
        expect(marker).toContain('Раскрыть: Kai Kennedy · вопрос по строке');
        expect(markerHtml([lineThread('m1', LINE)], LINE + 1)).not.toContain('thread-marker');
    });

    it('a collapsed thread takes up no rows, leaving the space below the line empty', () => {
        const html = markerHtml([lineThread('m1', LINE)]);

        expect(html.slice(html.indexOf('data-slot="line"'))).not.toContain('thread-list');
    });

    it('combines several threads on one line into a single marker with a total count', () => {
        const html = markerHtml([lineThread('m1', LINE), lineThread('m2', LINE, human('ada', 'Ada Ortiz'))]);
        const marker = html.slice(html.indexOf('data-slot="marker"'), html.indexOf('data-slot="line"'));

        expect([...marker.matchAll(/class="ctl thread-marker/g)]).toHaveLength(1);
        expect(marker).toContain('>2<');
        // Avatar of the line's first author.
        expect(marker).toContain('>KK<');
    });
});

describe('"collapse all" in the card header', () => {
    /** Read the hook from a fresh render: the button label must follow the store. */
    function collapseOf(store: ThreadStore, ids: readonly string[]): ThreadsCollapse | null {
        let captured: ThreadsCollapse | null = null;

        function Harness() {
            captured = useThreadsCollapse(store, ids);
            return null;
        }

        renderToStaticMarkup(<Harness />);
        return captured;
    }

    it('has no button while there is only one inline thread', () => {
        const single = lineThread('one', LINE);
        const store = createThreadStore([single], new Set([FILE.fileId]));

        expect(collapseOf(store, [single.id])).toBeNull();
    });

    it('does not collapse a thread with an open composer or keep the label at "collapse all" for it', () => {
        const typing = lineThread('c1', LINE);
        const plain = lineThread('c2', LINE + 1);
        const store = createThreadStore([typing, plain], new Set([FILE.fileId]));
        const ids = [typing.id, plain.id];

        expect(collapseOf(store, ids)?.canCollapse).toBe(true);

        openReply(store, typing, false);
        collapseOf(store, ids)?.onToggle();
        expect(store.isThreadOpen(typing.id)).toBe(true);
        expect(store.isThreadOpen(plain.id)).toBe(false);

        // Nothing else to collapse: the button offers to expand again, and does.
        const next = collapseOf(store, ids);
        expect(next?.canCollapse).toBe(false);
        next?.onToggle();
        expect(store.isThreadOpen(plain.id)).toBe(true);
    });
});
