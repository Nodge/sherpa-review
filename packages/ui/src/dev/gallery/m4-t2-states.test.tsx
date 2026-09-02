import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { M4_T2_STATES } from './m4-t2-states.tsx';

describe('M4-T2 gallery', () => {
    it('registers and renders 10 placeholders in the "Iterations" group', () => {
        expect(M4_T2_STATES.map((state) => state.id)).toEqual([
            'iterations-stale-banner',
            'iterations-second-pass-banner',
            'iterations-filter-new',
            'iterations-stop-changed',
            'iterations-stop-new',
            'iterations-why-changed',
            'iterations-snapshot-picker',
            'iterations-old-snapshot-readonly',
            'iterations-thread-pinned',
            'iterations-notes-lost',
        ]);

        for (const state of M4_T2_STATES) {
            expect(() => renderToStaticMarkup(<>{state.render()}</>), state.id).not.toThrow();
        }
    });
});
