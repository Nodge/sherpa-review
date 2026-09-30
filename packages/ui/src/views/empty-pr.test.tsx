import { fixtureIteration } from '@sherpa/fixtures';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LocaleProvider } from '../i18n/index.js';
import { reviewProgressSummary } from '../progress/summary.js';
import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { EmptyPrNotice } from './full-diff.tsx';
import { ViewFrame } from './view-frames.tsx';

/** Empty PR (docs/design/SPEC-elements.md §4.1): "Nothing to review", no Overview cards, ship remains available. */

const DATA = fixtureIteration('medium');
const EMPTY_DIFF = { ...DATA.diff, files: [] };

function overview(locale: 'ru' | 'en'): string {
    return renderToStaticMarkup(
        <LocaleProvider locale={locale}>
            <ViewFrame
                view="overview"
                prKey="fixture-empty"
                session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
                pr={DATA.pr}
                diff={EMPTY_DIFF}
                lenses={{ ownership: null, extra: [], ownershipSource: null }}
                threads={[]}
                threadStore={createThreadStore([], new Set())}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                reviewHostAvailable
            />
        </LocaleProvider>,
    );
}

describe('empty PR', () => {
    it('shows a notice in the full diff instead of an empty file list', () => {
        const html = renderToStaticMarkup(<EmptyPrNotice />);

        expect(html).toContain('Nothing to review');
        expect(html).toContain('This PR has no changes against the base.');
        // There is no way out to offer here, no active iteration or filter to switch to.
        expect(html).not.toContain('<button');
    });

    it('uses the exact English text from docs/design/SPEC-elements.md §4.1', () => {
        const html = renderToStaticMarkup(
            <LocaleProvider locale="en">
                <EmptyPrNotice />
            </LocaleProvider>,
        );

        expect(html).toContain('Nothing to review');
        expect(html).toContain('This PR has no changes against the base.');
    });

    it('shows the same notice on Overview instead of cards whose empty state would mislead', () => {
        const html = overview('en');

        expect(html).toContain('Nothing to review');
        expect(html).toContain('This PR has no changes against the base.');
        expect(html).not.toContain('ownership-card');
        expect(html).not.toContain('overview__grid');
        expect(overview('en')).toContain('Nothing to review');
    });

    it('keeps ship available in the action panel with nothing unviewed and 100% progress', () => {
        expect(reviewProgressSummary([], new Map())).toMatchObject({
            filesSeen: 0,
            filesTotal: 0,
            percentSeen: 100,
        });
    });
});
