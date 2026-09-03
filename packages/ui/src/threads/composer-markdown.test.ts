import { describe, expect, it } from 'vitest';

import { editMarkdown } from './composer-markdown.js';

const PLACEHOLDERS = { text: 'text', code: 'code' };

describe('composer Markdown toolbar', () => {
    it('puts a list on a separate line when the caret is inside text', () => {
        expect(editMarkdown('check here next', 10, 10, 'list', PLACEHOLDERS)).toEqual({
            text: 'check here\n- text\n next',
            selectionStart: 11,
            selectionEnd: 17,
        });
    });

    it('turns each selected line into a list item', () => {
        expect(editMarkdown('before\nfirst\nsecond\nafter', 7, 19, 'list', PLACEHOLDERS)).toEqual({
            text: 'before\n- first\n- second\nafter',
            selectionStart: 7,
            selectionEnd: 23,
        });
    });
});
