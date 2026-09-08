import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CHAT_PANEL_STATES } from './chat-panel-states.tsx';

describe('chat panel gallery', () => {
    it('registers and renders 5 panel states and history', () => {
        expect(CHAT_PANEL_STATES.map((state) => state.id)).toEqual([
            'chat-empty',
            'chat-queued',
            'chat-answering',
            'chat-failed',
            'chat-disconnected',
            'chat-history',
        ]);

        for (const state of CHAT_PANEL_STATES) {
            expect(() => renderToStaticMarkup(<>{state.render()}</>)).not.toThrow();
        }
    });
});
