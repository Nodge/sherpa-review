import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { M3_T7_STATES } from './m3-t7-states.tsx';

describe('M3-T7 gallery', () => {
    it('registers and renders a note, a stack and both summary states', () => {
        expect(M3_T7_STATES.map((state) => state.id)).toEqual([
            'agent-note-collapsed',
            'agent-note-expanded',
            'agent-note-stack',
            'agent-note-stack-summary',
            'agent-note-stack-open',
        ]);

        for (const state of M3_T7_STATES) {
            expect(() => renderToStaticMarkup(<>{state.render()}</>)).not.toThrow();
        }
    });
});
