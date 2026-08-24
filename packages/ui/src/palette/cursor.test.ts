import { describe, expect, it, vi } from 'vitest';

import { movePaletteCursor, scrollPaletteCursor } from './cursor.js';

describe('palette cursor', () => {
    it('moves in both directions and wraps around', () => {
        expect(movePaletteCursor(0, 3, 1)).toBe(1);
        expect(movePaletteCursor(2, 3, 1)).toBe(0);
        expect(movePaletteCursor(0, 3, -1)).toBe(2);
    });

    it('normalizes a missing cursor and an empty list', () => {
        expect(movePaletteCursor(-1, 3, 1)).toBe(0);
        expect(movePaletteCursor(4, 3, -1)).toBe(2);
        expect(movePaletteCursor(0, 0, 1)).toBe(-1);
    });

    it('scrolls the keyboard cursor into view with the nearest alignment', () => {
        const scrollIntoView = vi.fn();
        const querySelector = vi.fn(() => ({ scrollIntoView }));

        scrollPaletteCursor({ querySelector } as unknown as ParentNode, 23);

        expect(querySelector).toHaveBeenCalledWith('[data-index="23"]');
        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    });
});
