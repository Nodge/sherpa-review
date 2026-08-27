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

function render(): string {
    return renderToStaticMarkup(
        <ViewFrame
            view="overview"
            prKey="fixture-medium"
            session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
            pr={DATA.pr}
            diff={DATA.diff}
            lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
            threads={DATA.threads}
            threadStore={createThreadStore(DATA.threads, FILE_IDS)}
            threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
            reviewHostAvailable
        />,
    );
}

describe('discussion in Overview', () => {
    it('collapses threads outside the diff and keeps the button visible', () => {
        const html = render();

        expect(html).toContain('class="thread-outside__toggle"');
        expect(html).toContain('outside the diff');
        expect(html).toContain('aria-expanded="false"');
        // Collapsed means no thread bodies appear in the markup.
        expect(html).not.toContain('thread__body');
    });
});
