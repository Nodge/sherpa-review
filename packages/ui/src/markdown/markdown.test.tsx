import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Markdown } from './markdown.tsx';
import { stripInlineCode } from './markdown.js';

/**
 * Markdown renderer: two profiles and safety properties. Checks the finished markup,
 * exactly what the browser sees: all raw HTML must arrive as escaped text.
 */

function comment(text: string): string {
    return renderToStaticMarkup(<Markdown text={text} profile="comment" />);
}

function route(text: string): string {
    return renderToStaticMarkup(<Markdown text={text} profile="route" />);
}

describe('markdown, comment profile', () => {
    it('separates paragraphs with a blank line and renders a single newline as <br>', () => {
        expect(comment('first\nsecond\n\nthird')).toBe(
            '<p class="md-p">first<br/>second</p><p class="md-p">third</p>',
        );
    });

    it('uses h1–h6 with a level class and treats a seventh hash as plain text', () => {
        expect(comment('# one')).toBe('<h1 class="md-heading md-h1">one</h1>');
        expect(comment('## two')).toBe('<h2 class="md-heading md-h2">two</h2>');
        expect(comment('### three')).toBe('<h3 class="md-heading md-h3">three</h3>');
        expect(comment('#### four')).toBe('<h4 class="md-heading md-h4">four</h4>');
        expect(comment('###### six')).toBe('<h6 class="md-heading md-h6">six</h6>');
        expect(comment('##### What is wrong\ntext')).toBe(
            '<h5 class="md-heading md-h5">What is wrong</h5><p class="md-p">text</p>',
        );
        expect(comment('####### seven')).toBe('<p class="md-p">####### seven</p>');
    });

    it('renders bulleted and numbered lists with indentation-based nesting', () => {
        expect(comment('- one\n- two')).toBe(
            '<ul class="md-list"><li class="md-item">one</li><li class="md-item">two</li></ul>',
        );
        expect(comment('1. one\n2. two')).toContain('<ol class="md-list">');
        expect(comment('- one\n  - nested\n- two')).toBe(
            '<ul class="md-list"><li class="md-item">one<ul class="md-list"><li class="md-item">nested</li></ul></li>' +
                '<li class="md-item">two</li></ul>',
        );
    });

    it('renders fenced code line breaks and passes the language to data-lang and highlighting', () => {
        const html = comment('before\n```ts\nconst a = 1;\nconst b = 2;\n```\nafter');

        expect(html).toContain(
            '<pre class="md-pre" data-lang="ts"><code><span class="syntax-keyword">const</span> a = ' +
                '<span class="syntax-string">1</span>;\n<span class="syntax-keyword">const</span> b = ' +
                '<span class="syntax-string">2</span>;</code></pre>',
        );
        expect(html).toContain('<p class="md-p">before</p>');
        expect(html).toContain('<p class="md-p">after</p>');
    });

    it('sets only data-lang for an unknown language and omits the attribute for a fence without a language', () => {
        expect(comment('```rust\nfn main() {}\n```')).toBe(
            '<pre class="md-pre" data-lang="rust"><code>fn main() {}</code></pre>',
        );
        expect(comment('```\nfn main() {}\n```')).toBe('<pre class="md-pre"><code>fn main() {}</code></pre>');
    });

    it('treats blockquotes and tables inside a fence as literal text', () => {
        expect(comment('```\n> not a quote\n| not | table |\n| --- | --- |\n```')).toBe(
            '<pre class="md-pre"><code>&gt; not a quote\n| not | table |\n| --- | --- |</code></pre>',
        );
    });

    it('closes an unclosed fence at the end of the text without losing the tail', () => {
        expect(comment('```\nconst a = 1;')).toBe('<pre class="md-pre"><code>const a = 1;</code></pre>');
    });

    it('does not close a four-backtick fence with three backticks inside it', () => {
        expect(comment('````\n```\nx\n```\n````\ntail')).toBe(
            '<pre class="md-pre"><code>```\nx\n```</code></pre><p class="md-p">tail</p>',
        );
    });

    it('renders bold and italic and treats an unmatched asterisk as a literal', () => {
        expect(comment('**bold** and *italic*')).toBe(
            '<p class="md-p"><strong>bold</strong> and <em>italic</em></p>',
        );
        expect(comment('2 * 3 = 6')).toBe('<p class="md-p">2 * 3 = 6</p>');
    });

    it('does not open emphasis at an asterisk beside whitespace, preserving globs and pointers', () => {
        expect(comment('rename *.ts and *.tsx files')).toBe(
            '<p class="md-p">rename *.ts and *.tsx files</p>',
        );
        expect(comment('char *buf, int *len')).toBe('<p class="md-p">char *buf, int *len</p>');
        expect(comment('area = a * b * c')).toBe('<p class="md-p">area = a * b * c</p>');
        expect(comment('2 ** 3 and 4 ** 5')).toBe('<p class="md-p">2 ** 3 and 4 ** 5</p>');
    });

    it('matches strikethrough pairs and treats a single tilde or an unmatched pair as a literal', () => {
        expect(comment('~~struck through~~ and ~~pair~~')).toBe(
            '<p class="md-p"><del>struck through</del> and <del>pair</del></p>',
        );
        expect(comment('unmatched ~~tail and a ~ b and ~/dir')).toBe(
            '<p class="md-p">unmatched ~~tail and a ~ b and ~/dir</p>',
        );
    });

    it('draws checklist markers with spans and no interactive input', () => {
        const html = comment('- [ ] not done\n- [x] done\n- [X] also');

        expect(html).toBe(
            '<ul class="md-list">' +
                '<li class="md-item md-item--task"><span class="md-check" aria-hidden="true"></span>not done</li>' +
                '<li class="md-item md-item--task"><span class="md-check md-check--on" aria-hidden="true"></span>done</li>' +
                '<li class="md-item md-item--task"><span class="md-check md-check--on" aria-hidden="true"></span>also</li>' +
                '</ul>',
        );
        expect(html).not.toContain('<input');
    });

    it('treats brackets without following text as a literal in a normal list item', () => {
        expect(comment('- [ ]')).toBe('<ul class="md-list"><li class="md-item">[ ]</li></ul>');
    });

    it('parses blockquotes recursively with their own paragraphs and lists', () => {
        expect(comment('> quote\n> - item')).toBe(
            '<blockquote class="md-quote"><p class="md-p">quote</p>' +
                '<ul class="md-list"><li class="md-item">item</li></ul></blockquote>',
        );
    });

    it('nests blockquotes up to two levels and treats the third marker as a literal', () => {
        expect(comment('> > nested')).toBe(
            '<blockquote class="md-quote"><blockquote class="md-quote"><p class="md-p">nested</p></blockquote></blockquote>',
        );
        expect(comment('> > > text')).toBe(
            '<blockquote class="md-quote"><blockquote class="md-quote"><p class="md-p">&gt; text</p></blockquote></blockquote>',
        );
    });

    it('ends a blockquote at the first line without `>` and does not accept lazy continuation', () => {
        expect(comment('> quote\nplain')).toBe(
            '<blockquote class="md-quote"><p class="md-p">quote</p></blockquote><p class="md-p">plain</p>',
        );
        expect(comment('paragraph\n> quote')).toBe(
            '<p class="md-p">paragraph</p><blockquote class="md-quote"><p class="md-p">quote</p></blockquote>',
        );
    });

    it('takes table alignment from the separator row and allows omitted outer pipes', () => {
        expect(comment('| a | b |\n| :-- | --: |\n| 1 | 2 |')).toBe(
            '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
                '<th style="text-align:left">a</th><th style="text-align:right">b</th>' +
                '</tr></thead><tbody><tr>' +
                '<td style="text-align:left">1</td><td style="text-align:right">2</td>' +
                '</tr></tbody></table></div>',
        );
        expect(comment('a | b\n--- | ---\n1 | 2')).toContain('<th>a</th><th>b</th>');
    });

    it('keeps an escaped pipe inside a cell and fits rows to the header', () => {
        expect(comment('| a | b |\n| --- | --- |\n| x \\| y | z |')).toContain('<td>x | y</td><td>z</td>');
        expect(comment('| a | b | c |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |')).toContain(
            '<tbody><tr><td>1</td><td></td><td></td></tr><tr><td>1</td><td>2</td><td>3</td></tr></tbody>',
        );
    });

    it('treats a line with pipes but no separator row as a normal paragraph', () => {
        expect(comment('| a | b |\nplain text')).toBe('<p class="md-p">| a | b |<br/>plain text</p>');
    });

    it('ends a paragraph before a table instead of consuming its lines', () => {
        expect(comment('paragraph\n| a | b |\n| --- | --- |\n| 1 | 2 |')).toContain(
            '<p class="md-p">paragraph</p><div class="md-table-wrap">',
        );
    });

    it('opens a link in a new tab without a referrer and uses a class to wrap long URLs', () => {
        const html = comment('[issue](https://github.com/quillmart/quillmart/issues/1)');

        expect(html).toBe(
            '<p class="md-p"><a class="md-link" href="https://github.com/quillmart/quillmart/issues/1" target="_blank" rel="noreferrer">issue</a></p>',
        );
    });

    it('turns a bare URL into a link without including the sentence period', () => {
        const html = comment('see https://example.com/a/b?x=1.');

        expect(html).toContain('href="https://example.com/a/b?x=1"');
        expect(html).toContain('>https://example.com/a/b?x=1</a>.');
    });

    it('keeps a parenthesis inside the URL from breaking the link', () => {
        const html = comment('[wiki](https://ru.wikipedia.org/wiki/Foo_(bar)) tail');

        expect(html).toBe(
            '<p class="md-p"><a class="md-link" href="https://ru.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noreferrer">wiki</a> tail</p>',
        );
    });

    it('allows mailto as the only non-web scheme', () => {
        expect(comment('[email](mailto:alice@example.com)')).toContain('href="mailto:alice@example.com"');
    });
});

describe('markdown, sanitisation', () => {
    it('keeps raw HTML as text', () => {
        const html = comment('<img src=x onerror="alert(1)"> and <script>alert(2)</script>');

        expect(html).not.toContain('<img');
        expect(html).not.toContain('<script');
        expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
        expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
    });

    it('keeps javascript: and data: as text instead of links', () => {
        const js = comment('[click](javascript:alert(1))');
        const data = comment('[click](data:text/html;base64,PHNjcmlwdD4=)');

        expect(js).not.toContain('<a');
        expect(js).toContain('[click](javascript:alert(1))');
        expect(data).not.toContain('<a');
        expect(data).toContain('data:text/html;base64,PHNjcmlwdD4=');
    });

    it('treats relative and protocol-relative links as literals because the scheme must be explicit', () => {
        expect(comment('[here](/local/file)')).not.toContain('<a');
        expect(comment('[here](//example.com)')).not.toContain('<a');
    });

    it('does not let whitespace in the scheme bypass the check', () => {
        expect(comment('[click](java\tscript:alert(1))')).not.toContain('<a');
        expect(comment('[click]( javascript:alert(1))')).not.toContain('<a');
    });
});

describe('markdown, route profile', () => {
    it('renders inline code in monospace without visible backticks', () => {
        expect(route('`EditPolicy` decides based on the window')).toBe(
            '<code class="md-code">EditPolicy</code> decides based on the window',
        );
    });

    it('keeps block syntax literal because the route is a narrow column', () => {
        expect(route('# Heading')).toBe('# Heading');
        expect(route('- item')).toBe('- item');
        expect(route('**bold** and *italic*')).toBe('**bold** and *italic*');
        expect(route('[text](https://example.com)')).toBe('[text](https://example.com)');
        expect(route('https://example.com')).toBe('https://example.com');
    });

    it('also keeps blockquotes, tables and strikethrough literal in a route', () => {
        expect(route('~~struck through~~')).toBe('~~struck through~~');
        expect(route('> quote')).toBe('&gt; quote');
        expect(route('| a | b |')).toBe('| a | b |');
        expect(route('- [x] done')).toBe('- [x] done');
    });

    it('escapes raw HTML here too', () => {
        expect(route('<b>bold</b>')).toBe('&lt;b&gt;bold&lt;/b&gt;');
    });

    it('treats an unmatched backtick as literal text', () => {
        expect(route('the `slot field became required')).toBe('the `slot field became required');
        // Truncating the paragraph with a clamp breaks the pair, and that should remain visible.
        expect(route('a solution with code `edit-window')).toContain('`edit-window');
    });

    it('closes double backticks with matching backticks', () => {
        expect(route('`` a`b ``')).toBe('<code class="md-code"> a`b </code>');
    });
});

describe('stripping backticks for string attributes', () => {
    it('removes paired backticks and keeps their contents', () => {
        expect(stripInlineCode('The policy decides based on `EditWindow`, rather than the clock')).toBe(
            'The policy decides based on EditWindow, rather than the clock',
        );
    });

    it('leaves an unmatched backtick in place without rewriting the text', () => {
        expect(stripInlineCode('window `EditWindow')).toBe('window `EditWindow');
    });

    it('leaves other syntax unchanged when cleaning an attribute', () => {
        expect(stripInlineCode('**bold** [text](https://example.com)')).toBe(
            '**bold** [text](https://example.com)',
        );
    });
});
