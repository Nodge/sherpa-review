import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { M5_T5_STATES } from './m5-t5-states.tsx';

function markup(id: string): string {
    const state = M5_T5_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('M5-T5 gallery', () => {
    it('registers the shortcuts sheet in three scopes', () => {
        expect(M5_T5_STATES.map((state) => state.id)).toEqual([
            'cheatsheet-overview',
            'cheatsheet-route',
            'cheatsheet-full-diff',
        ]);
    });

    it('shows only global commands on Overview', () => {
        const html = markup('cheatsheet-overview');

        expect(html).toContain('⌘K');
        expect(html).toContain('G then O');
        expect(html).not.toContain('Next stop');
        expect(html).not.toContain('Next file');
        // No empty sections: "Comments" commands only exist within a view.
        expect(html).not.toContain('Comments');
    });

    it('shows stops on Route without full diff files', () => {
        const html = markup('cheatsheet-route');

        expect(html).toContain('Next stop');
        expect(html).toContain('Filter «what is new since the last visit»');
        expect(html).toContain('Comments');
        expect(html).not.toContain('Next file');
    });

    it('shows files on Full diff without stops', () => {
        const html = markup('cheatsheet-full-diff');

        expect(html).toContain('Next file');
        expect(html).toContain('Mark the file viewed');
        expect(html).not.toContain('Next stop');
    });

    it('puts ⌘K first in "Navigation" in all scopes', () => {
        for (const id of M5_T5_STATES.map((state) => state.id)) {
            const html = markup(id);
            expect(html.indexOf('⌘K')).toBeLessThan(html.indexOf('View «Overview»'));
        }
    });
});
