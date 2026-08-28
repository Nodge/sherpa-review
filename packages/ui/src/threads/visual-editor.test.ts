import { describe, expect, it } from 'vitest';

import { serializeMarkdown } from './visual-editor.js';

const CASES = [
    ['bold', '**important**', '**important**'],
    ['italic', '*careful*', '*careful*'],
    ['inline code', 'check `isDirty` here', 'check `isDirty` here'],
    ['code block', '```\nconst value = 1;\n```', '```\nconst value = 1;\n```'],
    // prosemirror-markdown normalizes the unordered list marker without changing the structure.
    ['list', '- first\n- second', '* first\n* second'],
    ['link', '[documentation](https://example.com/docs)', '[documentation](https://example.com/docs)'],
    ['list with inline code', '- call `retry()`\n- check `status`', '* call `retry()`\n* check `status`'],
    ['link inside bold', '**see [contract](https://example.com/spec)**', '**see [contract](https://example.com/spec)**'],
    ['multiline code block', '```\nconst first = 1;\nconst second = 2;\n```', '```\nconst first = 1;\nconst second = 2;\n```'],
    ['single line break within a paragraph', 'first line\nsecond line', 'first line\nsecond line'],
    ['square brackets without a link', 'see [TODO] in code', 'see [TODO] in code'],
    ['asterisk without formatting', '2*3', '2*3'],
    ['tilde without formatting', 'version ~2', 'version ~2'],
    ['unmatched backtick', 'plain ` backtick', 'plain ` backtick'],
    ['backslash without an escape sequence', 'path\\to', 'path\\to'],
] as const;

describe('visual editor Markdown round trip', () => {
    it.each(CASES)('%s', (_title, markdown, expected) => {
        expect(serializeMarkdown(markdown)).toBe(expected);
    });
});
