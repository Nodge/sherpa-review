// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseFileDiff } from '../diff/parse.js';
import { parseBlocks } from '../markdown/markdown.js';
import { MarkdownReview, markdownSegments, markdownTextSelection } from './markdown-review.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const TEXT = '# Заголовок\n\nПервые **важные слова** здесь.\nСледующее предложение.\n\n- Пункт\n  - Вложенный\n\n| Имя | Значение |\n| --- | --- |\n| A | B |\n\n> Цитата\n> Продолжение\n\n```ts\nconst x = 1;\n```';
function model(text = TEXT, start = 1) {
    return parseFileDiff({ fileId: 'md', path: 'doc.md', oldPath: null, changeType: 'add', binary: false, patch: `@@ -0,0 +${String(start)},${String(text.split('\n').length)} @@\n${text.split('\n').map((line) => '+' + line).join('\n')}` });
}
function html(text = TEXT, start = 1) {
    const root = document.createElement('div');
    root.innerHTML = renderToStaticMarkup(<MarkdownReview model={model(text, start)} selection={null} focusedThreadRange={null} />);
    document.body.append(root);
    return root;
}
function select(root: HTMLElement, from: number, to = from) {
    const first = root.querySelector(`[data-source-line="${String(from)}"]`);
    const last = root.querySelector(`[data-source-line="${String(to)}"]`);
    if (first === null || last === null) throw new Error('source line is missing');
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.childNodes.length);
    const selection = window.getSelection();
    selection?.removeAllRanges(); selection?.addRange(range);
    return markdownTextSelection(root, selection);
}
afterEach(() => { window.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });
describe('Markdown view with source lines', () => {
    it('preserves lines of paragraphs, nested lists, tables, quotes, and code', () => {
        const root = html();
        for (const line of [1, 3, 4, 6, 7, 9, 11, 13, 14, 17]) {
            expect(select(root, line)).toMatchObject({ start: line, end: line });
        }
        expect(select(root, 3, 4)).toMatchObject({ start: 3, end: 4 });
    });
    it('passes selected words without markup, including backward selection', () => {
        const root = html();
        const node = root.querySelector('strong')?.firstChild;
        if (node === null || node === undefined) throw new Error('bold text is missing');
        const selection = window.getSelection();
        selection?.setBaseAndExtent(node, 12, node, 2);
        expect(markdownTextSelection(root, selection)).toEqual({ start: 3, end: 3, text: 'portant wo' });
    });
    it('source lines account for fragment offset and CRLF', () => {
        const root = html('First\r\n**Second**', 41);
        expect(select(root, 42)).toEqual({ start: 42, end: 42, text: 'Second' });
        expect(parseBlocks('```\nbody', 41)[0]?.source).toEqual({ start: 41, end: 42 });
    });
    it('does not execute HTML or unsafe links', () => {
        const root = html('<script>alert(1)</script>\n[unsafe](javascript:alert(1))');
        expect(root.querySelector('script, a')).toBeNull();
        expect(root.textContent).toContain('<script>');
    });
    it('does not join old and new sides or fragments across a gap', () => {
        const diff = parseFileDiff({ fileId: 'md', path: 'doc.md', oldPath: null, changeType: 'modify', binary: false, patch: '@@ -1,1 +1,1 @@\n-before\n+after\n@@ -10,1 +10,1 @@\n-old tail\n+new tail' });
        expect(markdownSegments(diff, 'old').map((s) => s.lines.map((l) => l.text))).toEqual([['before'], ['old tail']]);
        expect(markdownSegments(diff, 'new').map((s) => s.start)).toEqual([1, 10]);
    });
    it('renders each line\'s discussions once, including blank lines and Markdown syntax lines', () => {
        const after = vi.fn(() => null);
        renderToStaticMarkup(<MarkdownReview model={model()} selection={null} focusedThreadRange={null} renderAfterLine={after} />);
        expect(after.mock.calls.map((args) => args)).toEqual(TEXT.split('\n').map((_, i) => ['new', i + 1]));
    });
    it('does not duplicate comments between nested and outer lists', () => {
        const text = '  - First\n    1. Nested\n1. Second\n- Third';
        expect(parseBlocks(text, 11).map((block) => block.source)).toEqual([
            { start: 11, end: 12 }, { start: 13, end: 14 },
        ]);
        const after = vi.fn(() => null);
        renderToStaticMarkup(<MarkdownReview model={model(text, 11)} selection={null} focusedThreadRange={null} renderAfterLine={after} />);
        expect(after.mock.calls).toEqual([['new', 11], ['new', 12], ['new', 13], ['new', 14]]);
    });
    it('does not turn selected comment text into a question about the document', () => {
        const root = document.createElement('div');
        root.innerHTML = '<div class="markdown-review__source"><span data-source-line="1">document</span></div><p>comment</p>';
        document.body.append(root);
        const paragraph = root.querySelector('p');
        if (paragraph === null) throw new Error('paragraph is missing');
        const range = document.createRange(); range.selectNodeContents(paragraph);
        window.getSelection()?.addRange(range);
        expect(markdownTextSelection(root, window.getSelection())).toBeNull();
    });
    it('shows a deleted document on the old side', () => {
        const diff = parseFileDiff({ fileId: 'md', path: 'doc.md', oldPath: null, changeType: 'delete', binary: false, patch: '@@ -1,1 +0,0 @@\n-# Deleted' });
        const root = document.createElement('div'); const react = createRoot(root); document.body.append(root);
        act(() => { react.render(<MarkdownReview model={diff} selection={null} focusedThreadRange={null} />); });
        expect(root.querySelector('h1')?.textContent).toBe('Deleted');
        expect(root.querySelector('[data-side="old"]')).not.toBeNull();
        act(() => { react.unmount(); });
    });
});
