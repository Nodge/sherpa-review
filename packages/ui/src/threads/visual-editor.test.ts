// @vitest-environment jsdom
import { schema } from 'prosemirror-markdown';
import { EditorState, Selection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { describe, expect, it, vi } from 'vitest';

import {
    createEditorState,
    markdownInputRules,
    parseClipboardMarkdown,
    serializeMarkdown,
    serializeMarkdownDocument,
} from './visual-editor.js';

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

    it('parses pasted plain text as Markdown without adding backslashes', () => {
        const slice = parseClipboardMarkdown('check **bold** and `code`');
        const doc = schema.topNodeType.create(null, slice.content);

        expect(doc.firstChild?.child(1).marks[0]?.type.name).toBe('strong');
        expect(doc.firstChild?.child(3).marks[0]?.type.name).toBe('code');
        expect(serializeMarkdownDocument(doc)).toBe('check **bold** and `code`');
    });

    it.each([
        ['**bold**', 'strong'],
        ['*italic*', 'em'],
        ['`code`', 'code'],
    ])('turns typed %s into mark %s', (input, markName) => {
        const host = document.createElement('div');
        const view = new EditorView(host, {
            state: EditorState.create({ schema, plugins: [markdownInputRules()] }),
        });

        type(view, input);

        expect(view.state.doc.textContent).toBe(input.replace(/^\*\*|\*\*$|^\*|\*$|^`|`$/g, ''));
        expect(view.state.doc.firstChild?.firstChild?.marks[0]?.type.name).toBe(markName);
        view.destroy();
    });
});

/** Types one character at a time, as the browser does, through the input rules handleTextInput. */
function type(view: EditorView, input: string): void {
    for (const character of input) {
        const { from, to } = view.state.selection;
        const handled = view.someProp('handleTextInput', (handler) =>
            handler(view, from, to, character, () => view.state.tr.insertText(character, from, to)),
        );
        if (!handled) {
            view.dispatch(view.state.tr.insertText(character, from, to));
        }
    }
}

function press(view: EditorView, key: string, modifiers: KeyboardEventInit = {}): boolean {
    const event = new KeyboardEvent('keydown', { key, ...modifiers });
    return view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false;
}

/** Editor with all plugins: input rules and hotkeys together, as in the composer. */
function mountEditor(markdown = '') {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const options = {
        markdown,
        disabled: false,
        ariaLabel: 'comment',
        placeholders: { text: 'text', code: 'code' },
        onChange: () => undefined,
        onSave,
        onCancel,
    };
    const view = new EditorView(document.createElement('div'), { state: createEditorState(markdown, options) });
    view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)));
    return { view, onSave, onCancel };
}

describe('visual editor block input rules and hotkeys', () => {
    it('turns "- " into a list item', () => {
        const { view } = mountEditor();

        type(view, '- item');

        expect(view.state.doc.firstChild?.type.name).toBe('bullet_list');
        expect(serializeMarkdownDocument(view.state.doc)).toBe('* item');
        view.destroy();
    });

    it('turns "1. " into a numbered list', () => {
        const { view } = mountEditor();

        type(view, '1. item');

        expect(view.state.doc.firstChild?.type.name).toBe('ordered_list');
        expect(serializeMarkdownDocument(view.state.doc)).toBe('1. item');
        view.destroy();
    });

    it('turns ``` into a code block', () => {
        const { view } = mountEditor();

        type(view, '```');
        type(view, 'const value = 1;');

        expect(view.state.doc.firstChild?.type.name).toBe('code_block');
        expect(serializeMarkdownDocument(view.state.doc)).toBe('```\nconst value = 1;\n```');
        view.destroy();
    });

    it('restores the literal text on Backspace immediately after "- "', () => {
        const { view } = mountEditor();

        type(view, '- ');
        expect(view.state.doc.firstChild?.type.name).toBe('bullet_list');

        expect(press(view, 'Backspace')).toBe(true);

        expect(view.state.doc.firstChild?.type.name).toBe('paragraph');
        expect(view.state.doc.textContent).toBe('- ');
        view.destroy();
    });

    it('creates the next list item on Enter', () => {
        const { view } = mountEditor();

        type(view, '- first');
        expect(press(view, 'Enter')).toBe(true);
        type(view, 'second');

        expect(view.state.doc.firstChild?.childCount).toBe(2);
        expect(serializeMarkdownDocument(view.state.doc)).toBe('* first\n* second');
        view.destroy();
    });

    it('exits the list on Enter in an empty item', () => {
        const { view } = mountEditor();

        type(view, '- first');
        press(view, 'Enter');
        expect(press(view, 'Enter')).toBe(true);
        type(view, 'paragraph');

        expect(view.state.doc.childCount).toBe(2);
        expect(view.state.doc.lastChild?.type.name).toBe('paragraph');
        expect(serializeMarkdownDocument(view.state.doc)).toBe('* first\n\nparagraph');
        view.destroy();
    });

    it('nests an item on Tab and moves it back on Shift-Tab', () => {
        const { view } = mountEditor();

        type(view, '- first');
        press(view, 'Enter');
        expect(press(view, 'Tab')).toBe(true);
        type(view, 'nested');

        expect(serializeMarkdownDocument(view.state.doc)).toBe('* first\n  * nested');

        expect(press(view, 'Tab', { shiftKey: true })).toBe(true);
        expect(serializeMarkdownDocument(view.state.doc)).toBe('* first\n* nested');
        view.destroy();
    });

    it('exits a code block into a new paragraph on Shift-Enter', () => {
        const { view } = mountEditor();

        type(view, '```');
        type(view, 'const value = 1;');
        expect(press(view, 'Enter', { shiftKey: true })).toBe(true);
        type(view, 'after code');

        expect(view.state.doc.lastChild?.type.name).toBe('paragraph');
        expect(serializeMarkdownDocument(view.state.doc)).toBe('```\nconst value = 1;\n```\n\nafter code');
        view.destroy();
    });

    it('inserts a soft break within the same paragraph on Shift-Enter', () => {
        const { view } = mountEditor();

        type(view, 'first');
        expect(press(view, 'Enter', { shiftKey: true })).toBe(true);
        type(view, 'second');

        expect(view.state.doc.childCount).toBe(1);
        expect(serializeMarkdownDocument(view.state.doc)).toBe('first\nsecond');
        view.destroy();
    });

    it('inserts a line break instead of a new list item on Enter in a code block inside an item', () => {
        const { view } = mountEditor('* item\n\n  ```\n  code\n  ```');

        expect(press(view, 'Enter')).toBe(true);
        type(view, 'more');

        expect(view.state.doc.childCount).toBe(1);
        expect(serializeMarkdownDocument(view.state.doc)).toBe('* item\n\n  ```\n  code\n  more\n  ```');
        view.destroy();
    });

    it('still saves on ⌘⏎ and cancels on Esc', () => {
        const { view, onSave, onCancel } = mountEditor();

        type(view, '- item');
        expect(press(view, 'Enter', { ctrlKey: true })).toBe(true);
        expect(press(view, 'Escape')).toBe(true);

        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(view.state.doc.firstChild?.type.name).toBe('bullet_list');
        view.destroy();
    });
});
