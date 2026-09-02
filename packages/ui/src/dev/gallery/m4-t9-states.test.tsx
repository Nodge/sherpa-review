import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { M4_T9_STATES } from './m4-t9-states.tsx';

function markup(id: string): string {
    const state = M4_T9_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('M4-T9 gallery', () => {
    it('registers exactly the ids defined by the milestone task breakdown', () => {
        expect(M4_T9_STATES.map((state) => state.id)).toEqual([
            'iterations-snapshot-picker',
            'iterations-old-snapshot-readonly',
            'iterations-snapshot-gone-readonly',
            'iterations-overview-snapshots-card',
        ]);
    });

    it('the picker menu lists snapshots newest first and an iteration without a route', () => {
        const html = markup('iterations-snapshot-picker');

        expect(html).toContain('Snapshots');
        expect(html).toContain('Iterations without a route');
        expect(html).toContain('9f3c1ab');
        expect(html).toContain('5c1d0aa');
        expect(html).toContain('commit no longer in the PR');
        expect(html).toContain('a71d4e2 · active iteration · no route');
        // The row shows the snapshot model. The tooltip shows its full provenance.
        expect(html).toContain('5c1d0aa · 6 h ago · opus-5 · stale');
        expect(html).toContain('claude-code · opus-5 · 5c1d0aa8b7e6f4302d9c8b7a6f5e4d3c2b1a0999');
        // The current snapshot is marked even without a URL parameter.
        expect(html).toContain('data-snapshot="route-medium-9f3c1ab" class="snapshot-picker__row is-cursor"');
        expect(html).not.toContain('read-only');
    });

    it('previous snapshot: read-only banner, stale pill and disabled viewed marks', () => {
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

        expect(html).toContain('read-only · commit no longer in the PR');
        expect(html).toContain('snapshot b0d3f77 · commit no longer in the PR');
    });

    it('the Snapshots card in Overview shows provenance for every snapshot', () => {
        const html = markup('iterations-overview-snapshots-card');

        expect(html).toContain('Snapshots');
        // The row has the short commit (README §13), the tooltip has the full hash.
        expect(html).toContain('claude-code · claude-opus-5 · 9f3c1ab<');
        expect(html).toContain('title="claude-code · claude-opus-5 · 9f3c1ab6d4e2705c8a1b3f9d6e4c2a08b7d5f316"');
        expect(html).toContain('9f3c1ab · 1 h ago · claude-opus-5 · current');
    });
});
