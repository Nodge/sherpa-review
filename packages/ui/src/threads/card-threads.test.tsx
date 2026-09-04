import { fixtureIteration } from '@sherpa/fixtures';
import type { Thread } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { useCardThreads } from './card-threads.tsx';
import type { IterationLayout } from './model.js';
import { createThreadStore } from './store.js';
import { openFileComposer } from './thread-list.tsx';

/**
 * Where a file card puts a thread pinned to a previous iteration (M4-T10). In the active
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

    /** M5-T24: an image comment uses an anchor without a line and goes in the same place. */
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
        expect(header).toContain('комментарий к файлу · handlers.ts');
        expect(html.slice(html.indexOf('data-slot="line"'))).not.toContain('thread-composer');
    });
});
