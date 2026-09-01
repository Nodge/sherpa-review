import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { M3_T6_STATES } from './m3-t6-states.tsx';

describe('M3-T6 gallery', () => {
    it('registers and renders 5 panel states and history', () => {
        expect(M3_T6_STATES.map((state) => state.id)).toEqual([
            'chat-empty',
            'chat-queued',
            'chat-answering',
            'chat-failed',
            'chat-disconnected',
            'chat-history',
        ]);

        for (const state of M3_T6_STATES) {
            expect(() => renderToStaticMarkup(<>{state.render()}</>)).not.toThrow();
        }
    });
});
