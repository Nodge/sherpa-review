import { describe, expect, it } from 'vitest';

import { clampParagraph } from './paragraph.js';

describe('stop paragraph clamping', () => {
    it('keeps the full text up to four sentences', () => {
        const text = 'First. Second. Third. Fourth.';

        expect(clampParagraph(text)).toEqual({ head: text, rest: '' });
    });

    it('puts the fifth sentence under "more" and joining restores the original text', () => {
        const text = 'First. Second! Third? Fourth… Fifth. Sixth.';
        const clamped = clampParagraph(text);

        expect(clamped.head).toBe('First. Second! Third? Fourth…');
        expect(clamped.rest).toBe('Fifth. Sixth.');
        expect(`${clamped.head} ${clamped.rest}`).toBe(text);
    });

    it('does not treat a dot inside code as a sentence end', () => {
        const text = 'The test section requires `FrozenClock` instead of `Date.now()` in `domain/`. That is all.';

        expect(clampParagraph(text)).toEqual({ head: text, rest: '' });
    });

    it('keeps the tail when the text has no final period', () => {
        const clamped = clampParagraph('One. Two. Three. Four. Tail without a period', 4);

        expect(clamped.rest).toBe('Tail without a period');
    });
});
