// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { shouldClearSelectionOnPointerDown } from './use-selection.js';

describe('clearing selection on mousedown', () => {
    it('keeps selection inside lines and the Selection popover', () => {
        const rows = document.createElement('div');
        rows.className = 'diff-rows';
        const rowButton = document.createElement('button');
        rows.append(rowButton);

        const popover = document.createElement('div');
        popover.className = 'selection-popover';
        const popoverInput = document.createElement('input');
        popover.append(popoverInput);

        expect(shouldClearSelectionOnPointerDown(rowButton)).toBe(false);
        expect(shouldClearSelectionOnPointerDown(popoverInput)).toBe(false);
        expect(shouldClearSelectionOnPointerDown(document.body)).toBe(true);
    });
});
