import { fixtureData } from '@sherpa/fixtures';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { ViewFrame } from './view-frames.tsx';

/**
 * The Overview discussion card is a summary, not a feed: threads outside the diff are collapsed (dogfooding #5).
 */

const DATA = fixtureData('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const THREADS = withOutsideBot();

function withOutsideBot() {
    const source = DATA.threads.find((thread) => thread.root.author.bot) ?? DATA.threads[0];
    if (source === undefined) {
        throw new Error('the test needs a thread');
    }
    return [
        ...DATA.threads,
        {
            ...source,
            id: 'overview-pr-bot',
            anchor: null,
            root: { ...source.root, id: 'overview-pr-bot-root', author: { ...source.root.author, bot: true } },
        },
    ];
}

function render(): string {
    return renderToStaticMarkup(
        <ViewFrame
            view="overview"
            prKey="fixture-medium"
            session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
            pr={DATA.pr}
            diff={DATA.diff}
            lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
            threads={THREADS}
            threadStore={createThreadStore(THREADS, FILE_IDS)}
            threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
            reviewHostAvailable
        />,
    );
}

describe('discussion in Overview', () => {
    it('does not duplicate human PR-level threads but keeps the bot thread outside the diff', () => {
        const html = render();

        expect(html).toContain('class="thread-outside__toggle"');
        expect(html).toContain('1 thread outside the diff');
        expect(html).toContain('aria-expanded="false"');
        expect(html).not.toContain('thread__body');
    });
});
