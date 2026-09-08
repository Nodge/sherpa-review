import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AGENT_NOTE_DRAFT_STATES } from './agent-note-draft-states.tsx';

describe('note draft gallery', () => {
    it('registers and renders a comment draft from a note', () => {
        expect(AGENT_NOTE_DRAFT_STATES.map((state) => state.id)).toEqual(['agent-note-draft']);

        for (const state of AGENT_NOTE_DRAFT_STATES) {
            const markup = renderToStaticMarkup(<>{state.render()}</>);
            expect(markup).toContain('Quoted from the agent’s answer:');
            expect(markup).toContain('data-note="41"');
        }
    });
});
