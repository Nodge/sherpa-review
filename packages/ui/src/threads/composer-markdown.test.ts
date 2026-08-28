import { describe, expect, it } from 'vitest';

import { editMarkdown } from './composer-markdown.js';

describe('composer Markdown toolbar', () => {
    it('puts a list on a separate line when the caret is inside text', () => {
        expect(editMarkdown('смотри тут дальше', 10, 10, 'list')).toEqual({
            text: 'check here\n- text\n next',
            selectionStart: 11,
            selectionEnd: 17,
        });
    });

    it('turns each selected line into a list item', () => {
        expect(editMarkdown('до\nпервый\nвторой\nпосле', 3, 16, 'list')).toEqual({
            text: 'before\n- first\n- second\nafter',
            selectionStart: 7,
            selectionEnd: 23,
        });
    });
});
