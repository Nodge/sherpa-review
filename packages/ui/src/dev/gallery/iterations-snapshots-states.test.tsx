import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ITERATION_SNAPSHOT_STATES } from './iterations-snapshots-states.tsx';

function markup(id: string): string {
    const state = ITERATION_SNAPSHOT_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('iteration snapshots gallery', () => {
    it('registers exactly the ids declared in the file', () => {
        expect(ITERATION_SNAPSHOT_STATES.map((state) => state.id)).toEqual([
            'iterations-snapshot-picker',
            'iterations-old-snapshot-readonly',
            'iterations-snapshot-gone-readonly',
            'iterations-snapshot-gone-readonly-local',
            'iterations-overview-snapshots-card',
            'iterations-picker-local-host',
        ]);
    });

    it('the picker menu starts with the active iteration, followed by snapshots', () => {
        const html = markup('iterations-snapshot-picker');

        expect(html).toContain('Snapshots and iterations');
        expect(html).toContain('9f3c1ab');
        expect(html).toContain('5c1d0aa');
        expect(html).toContain('commit no longer in the PR');
        expect(html).toContain('a71d4e2 · active iteration · no route');
        // The active iteration row is above snapshots from previous passes.
        expect(html.indexOf('a71d4e2 · active iteration')).toBeLessThan(html.indexOf('5c1d0aa · 6 hr. ago'));
        // The row shows the snapshot model. The tooltip shows its full provenance.
        expect(html).toContain('5c1d0aa · 6 hr. ago · opus-5 · stale');
        expect(html).toContain('claude-code · opus-5 · 5c1d0aa8b7e6f4302d9c8b7a6f5e4d3c2b1a0999');
        // The current snapshot is marked even without a URL parameter.
        expect(html).toContain('data-snapshot="route-medium-9f3c1ab" class="snapshot-picker__row is-cursor"');
        expect(html).not.toContain('read-only');
    });

    it('previous snapshot: read-only banner, stale indicator and disabled marks', () => {
        const html = markup('iterations-old-snapshot-readonly');

        expect(html).toContain('You are looking at snapshot');
        expect(html).toContain('read-only');
        expect(html).toContain('To the current one');
        expect(html).toContain('snapshot 5c1d0aa · stale');
        expect(html).toContain('title="only in the active iteration"');
        expect(html).toContain('disabled=""');
    });

    it('a snapshot of a removed commit adds the missing commit to the banner', () => {
        const html = markup('iterations-snapshot-gone-readonly');

        expect(html).toContain('read-only · the commit is no longer in the PR');
        expect(html).toContain('snapshot b0d3f77 · commit no longer in the PR');
    });

    it('local review: a removed iteration in the read-only banner refers to tree history rather than the PR', () => {
        const html = markup('iterations-snapshot-gone-readonly-local');

        expect(html).toContain('read-only · no longer in the tree history');
        expect(html).toContain('snapshot b0d3f77 · no longer in the tree history');
        expect(html).not.toContain('no longer in the PR');
    });

    it('local review: rows differ by the commit suffix, and a removed iteration uses its own wording', () => {
        const html = markup('iterations-picker-local-host');

        expect(html).toContain('6630996…8f90 · active iteration · no route');
        expect(html).toContain('6630996…7a8b');
        expect(html).toContain('6630996…3c4d');
        expect(html).toContain('no longer in the tree history');
        expect(html).not.toContain('no longer in the PR');
    });

    it('the Snapshots card in Overview shows provenance for every snapshot', () => {
        const html = markup('iterations-overview-snapshots-card');

        expect(html).toContain('Snapshots');
        // The row shows a short commit (docs/design/README.md §13). The tooltip shows the full one.
        expect(html).toContain('claude-code · claude-opus-5 · 9f3c1ab<');
        expect(html).toContain('title="claude-code · claude-opus-5 · 9f3c1ab6d4e2705c8a1b3f9d6e4c2a08b7d5f316"');
        expect(html).toContain('9f3c1ab · 1 hr. ago · claude-opus-5 · current');
    });
});
