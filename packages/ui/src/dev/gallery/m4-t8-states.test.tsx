import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createT } from '../../i18n/index.js';
import { CHANGE_CHIP_LABEL } from '../../views/route/route-toolbar.tsx';
import { M4_T8_STATES } from './m4-t8-states.tsx';

function markup(id: string): string {
    const state = M4_T8_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('M4-T8 gallery', () => {
    it('registers exactly the ids defined by the milestone task breakdown', () => {
        expect(M4_T8_STATES.map((state) => state.id)).toEqual([
            'iterations-stale-banner',
            'iterations-second-pass-banner',
            'iterations-second-pass-zero-carry',
            'iterations-filter-new',
            'iterations-stop-changed',
            'iterations-stop-new',
            'iterations-why-changed',
        ]);
    });

    it('the stale banner names both commits, the iteration count and affected stops', () => {
        const html = markup('iterations-stale-banner');

        expect(html).toContain('The route was built for');
        expect(html).toContain('9f3c1ab');
        expect(html).toContain('a71d4e2');
        expect(html).toContain('2 new iterations');
        expect(html).toContain('stops 02, 03 and 06 are affected');
        expect(html).toContain('Rebuild the route');
    });

    it('the second pass banner shows progress carryover and offers a filter', () => {
        const html = markup('iterations-second-pass-banner');

        expect(html).toContain('The route was rebuilt for');
        expect(html).toContain('3 of 6 stops stayed viewed.');
        expect(html).toContain('3 stops have changed; comments on changed ranges');
        expect(html).toContain('What is new since the last pass');
    });

    it('zero carryover states the reason and does not claim nothing changed', () => {
        const html = markup('iterations-second-pass-zero-carry');

        expect(html).toContain(
            'There were viewed marks from the previous pass, but no stop stayed fully viewed.',
        );
        expect(html).toContain('3 stops have changed;');
        expect(html).not.toContain('No changes in the stops');
    });

    it('the what is new filter leaves 3 stops and shows a chip', () => {
        const html = markup('iterations-filter-new');

        expect(html).toContain(createT('ru')(CHANGE_CHIP_LABEL));
        expect([...html.matchAll(/data-stop="/g)]).toHaveLength(3);
        // The plan fixes stop numbers, so the denominator still includes every slot.
        expect(html).toContain('02 / 7');
    });

    it('classification badges are visible without the filter', () => {
        expect(markup('iterations-stop-changed')).toContain('changed');
        expect(markup('iterations-stop-new')).toContain('new');
    });

    it('the why this stop changed block has a label and a thread link', () => {
        const html = markup('iterations-why-changed');

        expect(html).toContain('why this stop changed');
        expect(html).toContain('thread at line 33');
    });
});
