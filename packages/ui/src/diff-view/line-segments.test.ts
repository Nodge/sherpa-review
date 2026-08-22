import { describe, expect, it } from 'vitest';

import type { DiffLine } from '../diff/model.js';
import { hasTabs, lineSegments } from './line-segments.js';

/** Splitting a line into segments: highlighting, word-level changes, tabs, trailing spaces. */

function line(partial: Partial<DiffLine> & { text: string }): DiffLine {
    return { kind: 'context', oldLine: 1, newLine: 1, ...partial };
}

describe('diff line segments', () => {
    it('a line without markup is one segment', () => {
        expect(lineSegments(line({ text: 'const x = 1;' }))).toEqual([
            { text: 'const x = 1;', kind: null, word: false, trailing: false },
        ]);
    });

    it('splits the line at syntax token boundaries', () => {
        const segments = lineSegments(
            line({ text: 'const x = 1;', tokens: [{ from: 0, to: 5, kind: 'keyword' }] }),
        );

        expect(segments).toEqual([
            { text: 'const', kind: 'keyword', word: false, trailing: false },
            { text: ' x = 1;', kind: null, word: false, trailing: false },
        ]);
    });

    it('splits overlapping word-level highlighting and tokens into segments', () => {
        const segments = lineSegments(
            line({
                kind: 'add',
                text: 'return b;',
                tokens: [{ from: 0, to: 6, kind: 'keyword' }],
                words: [{ from: 7, to: 8 }],
            }),
        );

        expect(segments.map((segment) => [segment.text, segment.kind, segment.word])).toEqual([
            ['return', 'keyword', false],
            [' ', null, false],
            ['b', null, true],
            [';', null, false],
        ]);
    });

    it('displays tabs as four spaces without shifting offsets', () => {
        const raw = '\tconst x = 1;';
        const segments = lineSegments(line({ text: raw, tokens: [{ from: 1, to: 6, kind: 'keyword' }] }));

        expect(hasTabs(line({ text: raw }))).toBe(true);
        expect(segments).toEqual([
            { text: '    ', kind: null, word: false, trailing: false },
            { text: 'const', kind: 'keyword', word: false, trailing: false },
            { text: ' x = 1;', kind: null, word: false, trailing: false },
        ]);
    });

    it('puts trailing spaces of an added line in a separate segment', () => {
        const segments = lineSegments(line({ kind: 'add', text: 'const x = 1;   ' }));

        expect(segments.at(-1)).toEqual({ text: '   ', kind: null, word: false, trailing: true });
    });

    it('marks trailing spaces only on added lines', () => {
        expect(lineSegments(line({ kind: 'del', text: 'x   ' })).some((segment) => segment.trailing)).toBe(false);
        expect(lineSegments(line({ kind: 'context', text: 'x   ' })).some((segment) => segment.trailing)).toBe(false);
    });

    it('creates no trailing-space block for empty or whitespace-only lines', () => {
        expect(lineSegments(line({ kind: 'add', text: '' }))).toEqual([]);
        expect(lineSegments(line({ kind: 'add', text: '   ' })).some((segment) => segment.trailing)).toBe(false);
    });

    it('skips markup for very long lines without truncating them', () => {
        const text = 'x'.repeat(5000);
        const segments = lineSegments(line({ text, tokens: [{ from: 0, to: 10, kind: 'string' }] }));

        expect(segments).toHaveLength(1);
        expect(segments[0]?.text).toHaveLength(5000);
        expect(segments[0]?.kind).toBeNull();
    });
});
