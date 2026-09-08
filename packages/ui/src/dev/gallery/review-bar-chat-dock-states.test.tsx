import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { REVIEW_BAR_CHAT_DOCK_STATES } from './review-bar-chat-dock-states.tsx';

function markup(id: string): string {
    const state = REVIEW_BAR_CHAT_DOCK_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('action bar gallery next to chat', () => {
    it('registers both action-bar-and-chat frames', () => {
        expect(REVIEW_BAR_CHAT_DOCK_STATES.map((state) => state.id)).toEqual([
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
