import { STOP_PARAGRAPH_MAX_CHARS } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { asRawText, mediumRawResults } from './fixture-support.js';
import { paragraphMarkupErrors } from './paragraph-markup.js';
import { validateSkeleton } from './skeleton.js';

/** The model reads the error, so tests check both rejection and its wording. */
function errors(text: string): string[] {
    return paragraphMarkupErrors('section.stops[0].paragraph', 3, text);
}

describe('stop description markup vocabulary', () => {
    it('accepts the whole vocabulary: paragraphs, ul, ol, code, bold and a link', () => {
        const text = [
            'The edit window became a domain concept: `EditWindow` computes the time left using an injected clock.',
            '',
            'Three cases shorten the window:',
            '- fresh food: 10 minutes',
            '- pharmacy: 5 minutes',
            '',
            'The **shortest** window wins in the cart.',
            '',
            '1. the policy receives the window',
            '2. the endpoint returns the time left',
            '',
            'The rules are in [docs/edit-window.md](#file-services/orders/docs/edit-window.md).',
        ].join('\n');

        expect(errors(text)).toEqual([]);
    });

    it('treats unmatched asterisks, tildes and brackets as literal text', () => {
        expect(errors('Area a * b, path ~/dir and [broken link(')).toEqual([]);
    });

    it('rejects italics, strikethrough and a horizontal rule outside the vocabulary', () => {
        expect(errors('Area *a* × *b*, ~~almost~~.')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 uses italics; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
            'section.stops[0].paragraph: paragraph of stop 3 uses strikethrough; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
        expect(errors('One.\n\n---\n\nTwo.')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 uses a horizontal rule; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
    });

    it('also treats an underlined heading as a heading', () => {
        expect(errors('What changed\n---\n\nWindow.')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 uses a heading; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
    });

    it('accepts the `* ` list marker just like `- `', () => {
        expect(errors('* one\n* two')).toEqual([]);
    });

    it('rejects a list marker outside the vocabulary', () => {
        expect(errors('+ one\n+ two')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 uses a list marker other than `- `, `* ` and `1. `; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
        expect(errors('1) one\n2) two')).toHaveLength(1);
    });

    it('rejects a link target outside the vocabulary', () => {
        expect(errors('See [file](src/a.ts).')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 links to an address other than http(s), `#stop-<planIndex>` or `#file-<path>`; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
        expect(errors('[issue](https://example.test/T-1), [stop](#stop-2), [file](#file-a.ts)')).toEqual([]);
    });

    it('rejects a heading', () => {
        expect(errors('## What changed\n\nThe window became a domain concept.')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 uses a heading; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
    });

    it('rejects both fenced and indented code blocks', () => {
        expect(errors('Example:\n\n```ts\nconst a = 1;\n```')).toHaveLength(1);
        expect(errors('Example:\n\n    const a = 1;')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 uses a code block; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
    });

    it('rejects a nested item', () => {
        expect(errors('- root\n  - nested')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 uses a nested list item; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
    });

    it('rejects a second paragraph in a list item', () => {
        expect(errors('- a\n\n  item continuation')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 puts more than one paragraph into a list item; allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
    });

    it('rejects a link definition and a description without visible text', () => {
        expect(errors('[ref]: https://example.test')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 has no visible text: the reviewer would see an empty description.',
            'section.stops[0].paragraph: paragraph of stop 3 uses a link reference definition `[label]: url`; write links inline as [text](url); allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url).',
        ]);
        expect(errors('See [issue][t].\n\n[t]: https://example.test/T-1')).toHaveLength(1);
        expect(errors('[](https://example.test)')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 has no visible text: the reviewer would see an empty description.',
        ]);
    });

    it('rejects tables, images and blockquotes', () => {
        expect(errors('| a | b |\n| --- | --- |\n| 1 | 2 |')).toHaveLength(1);
        expect(errors('Schema: ![diagram](https://example.test/d.png)')).toHaveLength(1);
        expect(errors('> Quote from the issue.')).toHaveLength(1);
    });

    it('does not treat a pipe without a separator row as a table', () => {
        expect(errors('The regex `^a|b$` is unchanged.')).toEqual([]);
    });

    it('rejects five items and accepts four', () => {
        const items = (count: number) =>
            Array.from({ length: count }, (_, index) => `- item ${String(index + 1)}`).join('\n');

        expect(errors(items(4))).toEqual([]);
        expect(errors(items(5))).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 has a list of 5 items, at most 4 are allowed. A list is for enumerating like things; move the rest into the prose.',
        ]);
    });

    it('does not let blank lines between items bypass the limit', () => {
        expect(errors('- a\n\n- b\n\n- c\n\n- d\n\n- e')).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 has a list of 5 items, at most 4 are allowed. A list is for enumerating like things; move the rest into the prose.',
        ]);
    });

    it('does not join lists separated by a paragraph', () => {
        expect(errors('- a\n- b\n- c\n\nConclusion about the list.\n\n- d\n- e\n- f')).toEqual([]);
    });

    it('accepts 840 characters and rejects 841', () => {
        expect(errors('a'.repeat(STOP_PARAGRAPH_MAX_CHARS))).toEqual([]);
        expect(errors('a'.repeat(STOP_PARAGRAPH_MAX_CHARS + 1))).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 is 841 chars, limit is 840. Cut it down, do not split it across stops.',
        ]);
    });

    it('counts visible text toward the budget and excludes link targets and markup', () => {
        const url = `https://example.test/${'a'.repeat(STOP_PARAGRAPH_MAX_CHARS)}`;
        const prose = 'a'.repeat(STOP_PARAGRAPH_MAX_CHARS - 20);
        const fits = `**${prose}** [issue](${url}) and \`code\``;

        expect(fits.length).toBeGreaterThan(STOP_PARAGRAPH_MAX_CHARS);
        expect(errors(fits)).toEqual([]);
        expect(errors(`- ${prose}\n- ${'é'.repeat(21)}`)).toEqual([
            'section.stops[0].paragraph: paragraph of stop 3 is 841 chars, limit is 840. Cut it down, do not split it across stops.',
        ]);
    });
});

describe('PR summary uses the same vocabulary without a length budget', () => {
    const ALLOWED = 'allowed: paragraphs, `- `/`* `/`1. ` lists up to 4 items, `code`, **bold**, [links](url)';

    function summaryErrors(summary: string): readonly string[] {
        const result = validateSkeleton(asRawText({ ...mediumRawResults().skeleton, summary }));
        return result.ok ? [] : result.errors;
    }

    it('accepts paragraphs, a list, code, bold and links to a stop and a file', () => {
        const summary = [
            'The PR introduces `EditWindow`: orders can be edited for **30 minutes** after placement.',
            '',
            'The window is shorter for:',
            '- fresh produce',
            '- pharmacy',
            '',
            'Start with the [domain model](#stop-1), the rules are in the [README](#file-services/orders/README.md).',
        ].join('\n');

        expect(summaryErrors(summary)).toEqual([]);
    });

    it('accepts text longer than the stop description budget', () => {
        expect(summaryErrors('a'.repeat(STOP_PARAGRAPH_MAX_CHARS * 3))).toEqual([]);
    });

    it('reports a heading or code block as a skeleton error', () => {
        expect(summaryErrors('## Summary\n\nThe window became a domain concept.')).toEqual([
            `skeleton.summary: summary uses a heading; ${ALLOWED}.`,
        ]);
        expect(summaryErrors('Example:\n\n```ts\nconst a = 1;\n```')).toEqual([
            `skeleton.summary: summary uses a code block; ${ALLOWED}.`,
        ]);
    });

    it('rejects a five-item list', () => {
        const items = Array.from({ length: 5 }, (_, index) => `- item ${String(index + 1)}`).join('\n');
        expect(summaryErrors(items)).toEqual([
            'skeleton.summary: summary has a list of 5 items, at most 4 are allowed. A list is for enumerating like things; move the rest into the prose.',
        ]);
    });

    it('rejects text without visible content', () => {
        expect(summaryErrors('[](https://example.test)')).toEqual([
            'skeleton.summary: summary has no visible text: the reviewer would see an empty description.',
        ]);
    });
});
