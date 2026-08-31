import { baseKeymap, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import {
    defaultMarkdownParser,
    defaultMarkdownSerializer,
    MarkdownParser,
    MarkdownSerializer,
    schema,
} from 'prosemirror-markdown';
import type { MarkType, NodeType } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command, Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import type { ComposerTool } from './composer-markdown.js';

export interface VisualEditorOptions {
    readonly markdown: string;
    readonly disabled: boolean;
    readonly ariaLabel: string;
    readonly onChange: (markdown: string) => void;
    readonly onSave: () => void;
    readonly onCancel: () => void;
}

export interface VisualEditorHandle {
    readonly setMarkdown: (markdown: string) => void;
    readonly setDisabled: (disabled: boolean) => void;
    readonly format: (tool: ComposerTool) => void;
    readonly focus: () => void;
    readonly destroy: () => void;
}

const markdownParser = new MarkdownParser(schema, defaultMarkdownParser.tokenizer, {
    ...defaultMarkdownParser.tokens,
    softbreak: { node: 'hard_break' },
});

const markdownSerializer = new MarkdownSerializer(
    {
        ...defaultMarkdownSerializer.nodes,
        hard_break: (state, _node, parent, index) => {
            if (index + 1 < parent.childCount) {
                state.write('\n');
            }
        },
        text: (state, node, parent, index) => {
            const defaultEscape = state.esc.bind(state);
            state.esc = (text, startOfLine = false) => {
                if (node.marks.length > 0 || !parsesAsPlainText(text)) {
                    return defaultEscape(text, startOfLine);
                }
                return startOfLine ? escapeBlockStart(text) : text;
            };
            try {
                defaultMarkdownSerializer.nodes.text?.(state, node, parent, index);
            } finally {
                state.esc = defaultEscape;
            }
        },
    },
    defaultMarkdownSerializer.marks,
);

export function parseMarkdown(markdown: string) {
    return markdownParser.parse(markdown);
}

export function serializeMarkdown(markdown: string): string {
    return markdownSerializer.serialize(parseMarkdown(markdown));
}

function parsesAsPlainText(markdown: string): boolean {
    const tokens = markdownParser.tokenizer.parseInline(markdown, {});
    const children = tokens.flatMap((token) => token.children ?? []);
    return children.every((token) => token.type === 'text') && children.map((token) => token.content).join('') === markdown;
}

function escapeBlockStart(text: string): string {
    return text
        .replace(/^(\+[ ]|[-*>])/, '\\$&')
        .replace(/^(\s*)(#{1,6})(\s|$)/, '$1\\$2$3')
        .replace(/^(\s*\d+)\.\s/, '$1\\. ');
}

/** Mounts ProseMirror. The module loads only when the visual layout is selected. */
export function createVisualEditor(element: HTMLElement, options: VisualEditorOptions): VisualEditorHandle {
    element.replaceChildren();
    let disabled = options.disabled;
    let lastMarkdown = options.markdown;

    const view = new EditorView(element, {
        state: stateFor(options.markdown, options),
        dispatchTransaction: (transaction: Transaction) => {
            const nextState = view.state.apply(transaction);
            view.updateState(nextState);
            if (!transaction.docChanged) {
                return;
            }
            lastMarkdown = markdownSerializer.serialize(nextState.doc);
            options.onChange(lastMarkdown);
        },
        editable: () => !disabled,
        attributes: {
            class: 'thread-composer__prosemirror',
            role: 'textbox',
            'aria-label': options.ariaLabel,
            'aria-multiline': 'true',
        },
        handleKeyDown: (_view, event) => {
            if (isComposerShortcut(event) || isComposerInputKey(event.key)) {
                event.stopPropagation();
            }
            return false;
        },
    });

    const apply = (command: Command): void => {
        command(view.state, view.dispatch, view);
        view.focus();
    };

    return {
        setMarkdown: (markdown) => {
            if (markdown === lastMarkdown) {
                return;
            }
            lastMarkdown = markdown;
            view.updateState(stateFor(markdown, options));
        },
        setDisabled: (value) => {
            disabled = value;
            view.setProps({ editable: () => !disabled });
        },
        format: (tool) => {
            apply(commandFor(tool));
        },
        focus: () => {
            view.focus();
        },
        destroy: () => {
            view.destroy();
        },
    };
}

function stateFor(markdown: string, options: VisualEditorOptions): EditorState {
    return EditorState.create({
        schema,
        doc: parseMarkdown(markdown),
        plugins: [
            history(),
            keymap({
                'Mod-b': formatMark(schema.marks.strong, 'text'),
                'Mod-i': formatMark(schema.marks.em, 'text'),
                'Mod-k': linkCommand(),
                'Mod-Enter': () => {
                    options.onSave();
                    return true;
                },
                Escape: () => {
                    options.onCancel();
                    return true;
                },
                'Mod-z': undo,
                'Shift-Mod-z': redo,
            }),
            keymap(baseKeymap),
        ],
    });
}

function commandFor(tool: ComposerTool): Command {
    switch (tool) {
        case 'bold':
            return formatMark(schema.marks.strong, 'text');
        case 'italic':
            return formatMark(schema.marks.em, 'text');
        case 'link':
            return linkCommand();
        case 'code':
            return formatMark(schema.marks.code, 'code');
        case 'codeblock':
            return blockCommand(schema.nodes.code_block, 'code');
        case 'list':
            return listCommand();
    }
}

function formatMark(mark: MarkType, fallback: string): Command {
    return (state, dispatch) => {
        if (!state.selection.empty) {
            return toggleMark(mark)(state, dispatch);
        }
        if (dispatch === undefined) {
            return true;
        }
        const from = state.selection.from;
        const transaction = state.tr.insertText(fallback).addMark(from, from + fallback.length, mark.create());
        dispatch(transaction.setSelection(TextSelection.create(transaction.doc, from, from + fallback.length)));
        return true;
    };
}

function linkCommand(): Command {
    const link = schema.marks.link;
    return (state, dispatch) => {
        const { from, to, empty } = state.selection;
        if (dispatch === undefined) {
            return true;
        }
        let transaction = state.tr;
        let end = to;
        if (empty) {
            transaction = transaction.insertText('text');
            end = from + 5;
        }
        transaction = transaction.addMark(from, end, link.create({ href: 'https://', title: null }));
        dispatch(transaction.setSelection(TextSelection.create(transaction.doc, from, end)));
        return true;
    };
}

function blockCommand(node: NodeType, fallback: string): Command {
    return (state, dispatch, view) => {
        let nextState = state;
        if (state.selection.empty && dispatch !== undefined) {
            const from = state.selection.from;
            const transaction = state.tr.insertText(fallback);
            dispatch(transaction.setSelection(TextSelection.create(transaction.doc, from, from + fallback.length)));
            nextState = view?.state ?? state.apply(transaction);
        }
        return setBlockType(node)(nextState, dispatch);
    };
}

function listCommand(): Command {
    const list = schema.nodes.bullet_list;
    return (state, dispatch, view) => {
        let nextState = state;
        if (state.selection.empty && dispatch !== undefined) {
            const from = state.selection.from;
            const transaction = state.tr.insertText('text');
            dispatch(transaction.setSelection(TextSelection.create(transaction.doc, from, from + 5)));
            nextState = view?.state ?? state.apply(transaction);
        }
        return wrapIn(list)(nextState, dispatch);
    };
}

function isComposerInputKey(key: string): boolean {
    return key.length === 1;
}

function isComposerShortcut(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
        return true;
    }
    if (!(event.metaKey || event.ctrlKey)) {
        return false;
    }
    return ['b', 'i', 'k', 'Enter'].includes(event.key);
}
