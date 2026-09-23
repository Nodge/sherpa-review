import { describe, expect, it } from 'vitest';

import type { MarkdownBlock } from './markdown.js';
import { parseBlocks, parseInline, parseStop, stripInlineCode } from './markdown.js';

/**
 * Parsing into nodes by profile. Render tests in `packages/ui/src/markdown` check the markup
 * the UI builds from these nodes. Here we check node shapes, allowlists and what the validator sees.
 */

function list(block: MarkdownBlock | undefined) {
    if (block?.kind !== 'list') {
        throw new Error(`expected a list, got ${String(block?.kind)}`);
    }
    return block.list;
}

describe('comment profile', () => {
    it('bare addresses become links only with a scheme: filenames and www stay text', () => {
        expect(parseInline('see https://example.com/a. and markdown.ts, www.example.com', 'comment')).toEqual([
            { kind: 'text', text: 'see ' },
            { kind: 'link', href: 'https://example.com/a', children: [{ kind: 'text', text: 'https://example.com/a' }] },
            { kind: 'text', text: '. and markdown.ts, www.example.com' },
        ]);
    });

    it('images and unsafe links keep their original syntax', () => {
        expect(parseInline('![diagram](https://x.test/a.png) [here](/local "t")', 'comment')).toEqual([
            { kind: 'text', text: '![diagram](https://x.test/a.png) [here](/local "t")' },
        ]);
    });

    it('a newline inside bold text splits the node across two paragraph lines', () => {
        expect(parseBlocks('**one\ntwo** three')).toEqual([
            {
                kind: 'paragraph',
                lines: [
                    [{ kind: 'strong', children: [{ kind: 'text', text: 'one' }] }],
                    [{ kind: 'strong', children: [{ kind: 'text', text: 'two' }] }, { kind: 'text', text: ' three' }],
                ],
            },
        ]);
    });

    it('a code block inside an item goes after the list and splits it', () => {
        const blocks = parseBlocks('1. Install:\n   ```sh\n   pnpm i\n   ```\n2. Run', 1);

        expect(blocks.map((block) => [block.kind, block.source])).toEqual([
            ['list', { start: 1, end: 1 }],
            ['code', { start: 2, end: 4 }],
            ['list', { start: 5, end: 5 }],
        ]);
        expect(blocks[1]).toMatchObject({ lang: 'sh', text: 'pnpm i' });
    });

    it('items deeper than five levels become siblings of the fifth level', () => {
        const source = Array.from({ length: 7 }, (_, depth) => `${'  '.repeat(depth)}- ${String(depth)}`).join('\n');
        let level = list(parseBlocks(source)[0]);
        for (let depth = 0; depth < 4; depth += 1) {
            const next = level.items[0]?.list;
            if (next === null || next === undefined) {
                throw new Error(`missing level ${String(depth + 1)}`);
            }
            level = next;
        }

        expect(level.items.map((item) => item.children)).toEqual([
            [{ kind: 'text', text: '4' }],
            [{ kind: 'text', text: '5' }],
            [{ kind: 'text', text: '6' }],
        ]);
    });

    it('item lines and list end exclude blank lines', () => {
        const blocks = parseBlocks('- [x] one\n\n- two\n\nparagraph', 10);

        expect(blocks.map((block) => block.source)).toEqual([{ start: 10, end: 12 }, { start: 14, end: 14 }]);
        expect(list(blocks[0]).items).toEqual([
            { sourceLine: 10, children: [{ kind: 'text', text: 'one' }], list: null, check: true },
            { sourceLine: 12, children: [{ kind: 'text', text: 'two' }], list: null, check: null },
        ]);
    });

    it('four-space indentation makes a code block', () => {
        expect(parseBlocks('text\n\n    const a = 1;')[1]).toEqual({ kind: 'code', lang: null, fenced: false, text: 'const a = 1;' });
    });

    it('a newline inside inline code and a link address stays a paragraph line', () => {
        expect(parseBlocks('one `code\ncontinued` two\nthree')).toEqual([
            {
                kind: 'paragraph',
                lines: [
                    [{ kind: 'text', text: 'one ' }, { kind: 'code', text: 'code' }],
                    [{ kind: 'code', text: 'continued' }, { kind: 'text', text: ' two' }],
                    [{ kind: 'text', text: 'three' }],
                ],
            },
        ]);
        expect(parseBlocks('see [a](\nhttps://x.test) next\nthree', 10)).toEqual([
            {
                source: { start: 10, end: 12 },
                kind: 'paragraph',
                lines: [
                    [{ kind: 'text', text: 'see ' }, { kind: 'link', href: 'https://x.test', children: [{ kind: 'text', text: 'a' }] }],
                    [{ kind: 'text', text: ' next' }],
                    [{ kind: 'text', text: 'three' }],
                ],
            },
        ]);
    });
});

describe('route profile', () => {
    it('only inline code is parsed, escapes and entities stay as written', () => {
        expect(parseInline('`a` **b** \\* &amp; <https://x.test>', 'route')).toEqual([
            { kind: 'code', text: 'a' },
            { kind: 'text', text: ' **b** \\* &amp; <https://x.test>' },
        ]);
        expect(stripInlineCode('**`a`** [b](https://x.test)')).toBe('**a** [b](https://x.test)');
    });
});

describe('stop description profile', () => {
    it('allowed syntax passes without violations', () => {
        const stop = parseStop('Text with `code` and **emphasis**.\n\n- one\n- two\n\n1. [issue](https://x.test/T-1)\n2. [stop](#stop-2)');

        expect([...stop.violations]).toEqual([]);
        expect(stop.longestList).toBe(2);
        expect(stop.blocks.map((block) => block.kind)).toEqual(['paragraph', 'list', 'list']);
    });

    it('each construct outside the allowed syntax has its own violation', () => {
        const cases: readonly (readonly [string, string])[] = [
            ['# Heading', 'heading'],
            ['Heading\n===', 'heading'],
            ['```\nx\n```', 'code'],
            ['    x', 'code'],
            ['| a |\n| - |\n| 1 |', 'table'],
            ['![a](https://x.test/a.png)', 'image'],
            ['> quote', 'quote'],
            ['- a\n  - b', 'nested-list'],
            ['  - a', 'nested-list'],
            ['+ a', 'list-marker'],
            ['1) a', 'list-marker'],
            ['*italic*', 'italic'],
            ['~~no~~', 'strike'],
            ['---', 'rule'],
            ['[a](src/a.ts)', 'link'],
            ['[a](mailto:x@y.test)', 'link'],
            ['- a\n\n  second paragraph of the item', 'list-paragraphs'],
            ['[ref]: https://x.test', 'link-definition'],
            ['[a][ref]\n\n[ref]: https://x.test', 'link-definition'],
        ];
        for (const [source, violation] of cases) {
            expect([...parseStop(source).violations], source).toEqual([violation]);
        }
    });

    it('constructs outside the allowed syntax render as source lines', () => {
        expect(parseStop('- a\n  - b\n\ntext').blocks).toEqual([
            { kind: 'paragraph', lines: [[{ kind: 'text', text: '- a' }], [{ kind: 'text', text: '  - b' }]] },
            { kind: 'paragraph', lines: [[{ kind: 'text', text: 'text' }]] },
        ]);
    });

    it('visible text: link addresses, backticks, asterisks and list markers do not count', () => {
        const stop = parseStop(`**ab** \`cd\` [ef](https://x.test/${'z'.repeat(100)})\n\n- gh\n1. ij`);

        expect(stop.visibleChars).toBe('ab cd ef'.length + 'gh'.length + 'ij'.length);
    });

    it('a bare address is text, but counts in full', () => {
        const stop = parseStop('see https://x.test/a');

        expect(stop.blocks).toEqual([{ kind: 'paragraph', lines: [[{ kind: 'text', text: 'see https://x.test/a' }]] }]);
        expect(stop.visibleChars).toBe(20);
    });
});
