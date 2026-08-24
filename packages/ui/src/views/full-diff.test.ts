import { describe, expect, it } from 'vitest';

import { commentPosition } from './full-diff.tsx';

describe('line comment anchor', () => {
    const selection = { fileId: 'f1', anchor: 'a10', focus: 'a12' };

    it('preserves the selected range on a click inside it', () => {
        expect(commentPosition(selection, 'f1', 'new', 11)).toEqual({ side: 'new', line: 10, size: 3 });
    });

    it('does not carry an old selection to another line button', () => {
        expect(commentPosition(selection, 'f1', 'new', 50)).toEqual({ side: 'new', line: 50, size: 1 });
    });
});
