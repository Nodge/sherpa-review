import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { UiRouteState } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { ViewFrame } from './view-frames.tsx';

/**
 * Overview and the Route tab during generation (docs/design/README.md §6–7, docs/design/SPEC-elements.md §4.1): what the
 * Summary card shows and whether a generation card appears in the right rail.
 */

const DATA = fixtureIteration('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));

function state(name: 'medium' | 'small', phase: 'none' | 'reading' | 'filling' | 'ready' | 'failed'): UiRouteState {
    const fixture = routeFixtures(name)?.states[phase] ?? null;
    if (fixture === null) {
        throw new Error(`fixture ${name} needs state ${phase}`);
    }
    return fixture;
}

function render(view: 'overview' | 'route', route: UiRouteState | null): string {
    return renderToStaticMarkup(
        <ViewFrame
            view={view}
            prKey="fixture-medium"
            session={createSessionStore({ initial: { view, filter: 'all' } })}
            diff={DATA.diff}
            lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
            threads={DATA.threads}
            threadStore={createThreadStore(DATA.threads, FILE_IDS)}
            threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
            reviewHostAvailable
            generation={{ route }}
        />,
    );
}

describe('Overview during generation', () => {
    it('phase A: shows a skeleton instead of Summary and a reading card in the rail', () => {
        const html = render('overview', state('medium', 'reading'));

        expect(html).toContain('summary-skeleton');
        expect(html).toContain('Reading the diff, planning the route');
        expect(html).toContain('Reading the whole diff · 21 files');
        // No caret: the summary arrives in full with the skeleton.
        expect(html).not.toContain('caret');
    });

    it('phase B: shows the full summary with provenance and a filling card', () => {
        const html = render('overview', state('medium', 'filling'));

        expect(html).not.toContain('summary-skeleton');
        expect(html).toContain('The PR introduces a 30-minute edit window');
        expect(html).toContain('claude-code · claude-opus-5 · ');
        expect(html).toContain('4 of 7 ready');
        // Summary and plan slots use the route profile: backticks become monospace code.
        expect(html).toContain('<code class="md-code">EditWindow</code>');
        expect(html).toContain('<code class="md-code">README.md</code>');
        expect(html).not.toContain('`');
    });

    it('failure: Summary says the description is missing, with a red card alongside', () => {
        const html = render('overview', state('medium', 'failed'));

        expect(html).toContain('Summary unavailable.');
        expect(html).toContain('gen-failed--compact');
    });

    it('keeps the invitation without a generation card when generation has not run', () => {
        const html = render('overview', state('medium', 'none'));

        expect(html).toContain('No route yet.');
        expect(html).not.toContain('gen-card');
    });

    it('small PR: Summary explains why there is no route instead of inviting the reviewer to run the skill', () => {
        const html = render('overview', state('small', 'none'));

        expect(html).toContain('Small PR — no route needed.');
        expect(html).not.toContain('Run the skill');
        expect(html).not.toContain('gen-card');
    });

    it('has no snapshot card even after the route is ready', () => {
        const html = render('overview', state('medium', 'ready'));

        expect(html).not.toContain('Snapshots');
        expect(html).not.toContain('No snapshots yet');
    });
});

describe('Route tab without a route', () => {
    it('explains the threshold for a small PR and opens the reader while the tab stays available', () => {
        const html = render('route', state('small', 'none'));

        expect(html).toContain('Small PR — no route needed');
        expect(html).toContain('Read the full diff');
        expect(html).not.toContain('No route for this PR yet');
    });

    it('keeps the invitation to run the skill for a normal PR without a route', () => {
        const html = render('route', state('medium', 'none'));

        expect(html).toContain('No route for this PR yet');
    });

    it('shows the invitation instead of a blank screen before route state arrives', () => {
        expect(render('route', null)).toContain('No route for this PR yet');
    });
});
