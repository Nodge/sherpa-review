import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { M3_T8_STATES } from './m3-t8-states.tsx';

describe('M3-T8 gallery', () => {
    it('registers and renders a comment draft from a note', () => {
        expect(M3_T8_STATES.map((state) => state.id)).toEqual(['agent-note-draft']);

        for (const state of M3_T8_STATES) {
            const markup = renderToStaticMarkup(<>{state.render()}</>);
            expect(markup).toContain('Quoted from the agent’s answer:');
            expect(markup).toContain('data-note="41"');
        }
    });
});
