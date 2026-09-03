import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { M5_T22_STATES } from './m5-t22-states.tsx';

function markup(id: string): string {
    const state = M5_T22_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('M5-T22 gallery', () => {
    it('registers both action-bar-and-chat frames', () => {
        expect(M5_T22_STATES.map((state) => state.id)).toEqual([
            'review-bar-chat-docked',
            'review-bar-chat-overlay',
        ]);
    });

    it('keeps the action bar and chat without a scrim in the docked state', () => {
        const html = markup('review-bar-chat-docked');

        expect(html).toContain('review-action-bar');
        expect(html).toContain('gallery-dock-chat');
        expect(html).not.toContain('gallery-dock-scrim');
    });

    it('adds a scrim above the bar in the overlay state', () => {
        const html = markup('review-bar-chat-overlay');

        expect(html).toContain('gallery-dock-scrim');
        expect(html).toContain('gallery-dock-chat--overlay');
        expect(html).toContain('review-action-bar');
    });
});
