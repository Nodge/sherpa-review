// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { jumpTarget } from './scroll.js';

/**
 * Jump target levels (SPEC §2.9): section → card → row. The level matters more than the element itself:
 * it tells the caller whether the jump arrived or needs to keep looking. An intermediate level must be
 * a real scroll target: a stop whose cards are deferred by lazy rendering adds them
 * only after it has appeared on screen, and this jump brings it there.
 */

function container(markup: string): HTMLElement {
    const element = document.createElement('div');
    element.innerHTML = markup;
    return element;
}

const FULL = container(`
    <div data-stop="s01"><article data-file="f1"><div class="diff-row" data-key="a12">x</div></article></div>
    <div data-stop="s04"><article data-file="f9"></article></div>
`);

/** The stop has not appeared on screen yet: it has no cards, only the section itself. */
const LAZY = container('<div data-stop="s01"></div>');

describe('jump target', () => {
    it('keeps the stop section as the target when there is no file', () => {
        expect(jumpTarget(FULL, 's01', null, null, null)).toEqual({
            step: 'section',
            element: FULL.querySelector('[data-stop="s01"]'),
        });
    });

    it('uses the file card as a separate level when no line was requested', () => {
        expect(jumpTarget(FULL, 's01', 'f1', null, null)?.step).toBe('card');
    });

    it('a found line is the final level', () => {
        const target = jumpTarget(FULL, 's01', 'f1', 12, 'new');

        expect(target?.step).toBe('row');
        expect(target?.element.dataset.key).toBe('a12');
    });

    it('reaches at least the file when the line is outside the card slice', () => {
        expect(jumpTarget(FULL, 's01', 'f1', 999, 'new')?.step).toBe('card');
    });

    it('targets the section when the card has not rendered yet', () => {
        // This is the lazy rendering case. Without this level, the jump would stall forever:
        // cards appear only when the stop is on screen.
        expect(jumpTarget(LAZY, 's01', 'f1', 12, 'new')).toEqual({
            step: 'section',
            element: LAZY.querySelector('[data-stop="s01"]'),
        });
    });

    it('ignores another stop\'s card by looking for the file inside the stop section', () => {
        expect(jumpTarget(FULL, 's04', 'f1', null, null)?.step).toBe('section');
    });

    it('returns no target when the section is absent, so the caller can distinguish it', () => {
        expect(jumpTarget(FULL, 'no-such-stop', null, null, null)).toBeNull();
    });
});
