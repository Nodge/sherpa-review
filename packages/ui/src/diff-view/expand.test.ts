import type { FileContent } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel, DiffGap, DiffHunk } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { expandFileContext, hiddenLinesOf, remainingHiddenLines } from './expand.js';

/**
 * Context expansion is a pure function of the model and file content. Tests cover the behaviour
 * behind the card button: gaps disappear when they close, line numbers stay correct,
 * expansion stops at file boundaries, and the tail's actual length comes from the content.
 */

/** A 120-line file: `line-1` … `line-120`. */
const LINES = Array.from({ length: 120 }, (_, index) => `line-${String(index + 1)}`);
const CONTENT: FileContent = { oldText: LINES.join('\n'), newText: LINES.join('\n') };

/** A diff with two hunks. Lines 21 and 41 change, and gaps hide the rest. */
function twoHunks(): DiffFileModel {
    const patch = [
        'diff --git a/app.ts b/app.ts',
        '--- a/app.ts',
        '+++ b/app.ts',
        '@@ -21,1 +21,1 @@',
        '-line-21',
        '+line-21 changed',
        '@@ -41,1 +41,1 @@',
        '-line-41',
        '+line-41 changed',
        '',
    ].join('\n');

    return parseFileDiff({
        fileId: 'f1',
        path: 'app.ts',
        oldPath: null,
        changeType: 'modify',
        binary: false,
        patch,
    });
}

function blocks(model: DiffFileModel): (DiffHunk | DiffGap)[] {
    return model.content.kind === 'text' ? [...model.content.blocks] : [];
}

function gaps(model: DiffFileModel): DiffGap[] {
    return blocks(model).filter((block): block is DiffGap => block.kind === 'gap');
}

function hunks(model: DiffFileModel): DiffHunk[] {
    return blocks(model).filter((block): block is DiffHunk => block.kind === 'hunk');
}

describe('context expansion', () => {
    it('initial model has a leading gap, an inner gap and a tail of unknown length', () => {
        const model = twoHunks();

        expect(gaps(model).map((gap) => [gap.edge, gap.hiddenLines])).toEqual([
            ['leading', 20],
            ['inner', 19],
            ['trailing', null],
        ]);
    });

    it('a +20 step reveals 20 lines around each hunk with correct line numbers', () => {
        const expanded = expandFileContext(twoHunks(), CONTENT, 20);
        const first = hunks(expanded)[0];

        // Leading gap: lines 1–20 appeared above the hunk, so the gap disappeared entirely.
        expect(first?.newStart).toBe(1);
        expect(first?.lines[0]).toMatchObject({ newLine: 1, oldLine: 1, text: 'line-1', kind: 'context' });
        // Twenty tail lines appeared below the second hunk, so the block ends at line 61.
        expect(first?.lines.at(-1)).toMatchObject({ newLine: 61, text: 'line-61' });
        expect(gaps(expanded).map((gap) => gap.edge)).toEqual(['trailing']);
    });

    it('closing an inner gap merges the hunks into one continuous block', () => {
        const expanded = expandFileContext(twoHunks(), CONTENT, 20);
        const merged = hunks(expanded);

        expect(merged).toHaveLength(1);
        const lines = merged[0]?.lines ?? [];
        // Lines are consecutive on the new side, without gaps.
        const numbers = lines.filter((line) => line.newLine !== null).map((line) => line.newLine);
        expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => index + 1));
        expect(numbers.length).toBe(61);
    });

    it('a small step leaves a gap and shifts its start', () => {
        const expanded = expandFileContext(twoHunks(), CONTENT, 5);
        const [leading, inner] = gaps(expanded);

        expect(leading).toMatchObject({ edge: 'leading', hiddenLines: 15, newStart: 1 });
        // The inner gap gave up 5 lines at each end: 19 − 10, with its start shifted by 5.
        expect(inner).toMatchObject({ edge: 'inner', hiddenLines: 9, newStart: 27 });
    });

    it('gets the tail length from the content instead of inventing it', () => {
        const model = twoHunks();
        const trailing = gaps(model).at(-1);
        if (trailing === undefined) {
            throw new Error('model has no trailing gap');
        }

        expect(hiddenLinesOf(trailing, null)).toBeNull();
        expect(hiddenLinesOf(trailing, CONTENT)).toBe(79);

        const expanded = expandFileContext(model, CONTENT, 5);
        const expandedTrailing = gaps(expanded).at(-1);
        expect(expandedTrailing?.newStart).toBe(47);
        expect(hiddenLinesOf(expandedTrailing ?? trailing, CONTENT)).toBe(74);
    });

    it('"expand all" leaves no gaps', () => {
        const expanded = expandFileContext(twoHunks(), CONTENT, 'all');

        expect(gaps(expanded)).toEqual([]);
        expect(remainingHiddenLines(expanded, CONTENT)).toBe(0);
        expect(hunks(expanded)[0]?.lines.filter((line) => line.newLine !== null)).toHaveLength(120);
    });

    it('newline at the end of a file does not become an extra line', () => {
        const model = twoHunks();
        const trailing = gaps(model).at(-1);
        if (trailing === undefined) {
            throw new Error('model has no trailing gap');
        }

        // A real file almost always ends with `\n`. The tail count must be the same without it.
        const withNewline: FileContent = { oldText: `${LINES.join('\n')}\n`, newText: `${LINES.join('\n')}\n` };
        expect(hiddenLinesOf(trailing, withNewline)).toBe(hiddenLinesOf(trailing, CONTENT));

        const expanded = expandFileContext(twoHunks(), withNewline, 'all');
        expect(hunks(expanded)[0]?.lines.at(-1)).toMatchObject({ newLine: 120, text: 'line-120' });
    });

    it('returns an added file model unchanged because there is nothing to expand', () => {
        const added = parseFileDiff({
            fileId: 'f2',
            path: 'new.ts',
            oldPath: null,
            changeType: 'add',
            binary: false,
            patch: ['@@ -0,0 +1,2 @@', '+line-1', '+line-2', ''].join('\n'),
        });

        expect(remainingHiddenLines(added, { oldText: null, newText: 'line-1\nline-2' })).toBe(0);
        expect(expandFileContext(added, { oldText: null, newText: 'line-1\nline-2' }, 'all')).toEqual(added);
    });

    it('leaves the model unchanged without content', () => {
        const model = twoHunks();
        expect(expandFileContext(model, null, 'all')).toEqual(model);
        expect(remainingHiddenLines(model, null)).toBeNull();
    });

    it('only adds existing lines when the content is shorter than expected', () => {
        const short: FileContent = { oldText: 'line-1\nline-2', newText: 'line-1\nline-2' };
        const expanded = expandFileContext(twoHunks(), short, 'all');
        const revealed = hunks(expanded)
            .flatMap((hunk) => hunk.lines)
            .filter((line) => line.kind === 'context');

        expect(revealed.map((line) => line.text)).toEqual(['line-1', 'line-2']);
    });

    it('old-side numbers account for hunk offsets', () => {
        const patch = [
            '@@ -21,1 +21,3 @@',
            ' line-21',
            '+added-a',
            '+added-b',
            '@@ -41,1 +43,1 @@',
            '-line-41',
            '+line-41 changed',
            '',
        ].join('\n');
        const model = parseFileDiff({
            fileId: 'f3',
            path: 'app.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch,
        });

        const expanded = expandFileContext(model, CONTENT, 3);
        const inner = gaps(expanded).find((gap) => gap.edge === 'inner');
        // Gap between hunks: old side 22…40, new side 24…42, shifted by two additions.
        expect(inner).toMatchObject({ oldStart: 25, newStart: 27 });

        const revealed = hunks(expanded)[1]?.lines[0];
        expect(revealed).toMatchObject({ oldLine: 38, newLine: 40, text: 'line-40' });
    });
});
