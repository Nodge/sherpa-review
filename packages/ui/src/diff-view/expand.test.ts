import type { FileContent } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel, DiffGap, DiffHunk } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import type { ExpandDirection, FileExpansion } from './expand.js';
import {
    expandAllGaps,
    expandFileContext,
    expandGap,
    gapExpansionDelta,
    gapKeyOf,
    hiddenLinesOf,
    remainingHiddenLines,
} from './expand.js';

/** A 120-line file: `line-1` … `line-120`. */
const LINES = Array.from({ length: 120 }, (_, index) => `line-${String(index + 1)}`);
const CONTENT: FileContent = { oldText: LINES.join('\n'), newText: LINES.join('\n') };
const EMPTY_EXPANSION: FileExpansion = new Map();

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

function expansionFor(
    model: DiffFileModel,
    edge: DiffGap['edge'],
    direction: ExpandDirection,
    amount = 20,
): FileExpansion {
    const gap = gaps(model).find((candidate) => candidate.edge === edge);
    if (gap === undefined) {
        throw new Error(`model has no ${edge} gap`);
    }
    return expandGap(EMPTY_EXPANSION, gapKeyOf(gap), direction, amount);
}

describe('directional context expansion', () => {
    it('initial model has a leading gap, an inner gap and a tail of unknown length', () => {
        expect(gaps(twoHunks()).map((gap) => [gap.edge, gap.hiddenLines])).toEqual([
            ['leading', 20],
            ['inner', 19],
            ['trailing', null],
        ]);
    });

    it('up arrow expands the top edge of only the selected inner gap', () => {
        const model = twoHunks();
        const expanded = expandFileContext(model, CONTENT, expansionFor(model, 'inner', 'up', 5));
        const inner = gaps(expanded).find((gap) => gap.edge === 'inner');
        const [first, second] = hunks(expanded);

        expect(first?.lines.at(-1)).toMatchObject({ newLine: 26, text: 'line-26' });
        expect(second?.lines[0]).toMatchObject({ oldLine: 41, kind: 'del' });
        expect(inner).toMatchObject({ hiddenLines: 14, newStart: 27 });
    });

    it('down arrow expands the bottom edge of only the selected inner gap', () => {
        const model = twoHunks();
        const expanded = expandFileContext(model, CONTENT, expansionFor(model, 'inner', 'down', 5));
        const inner = gaps(expanded).find((gap) => gap.edge === 'inner');
        const [first, second] = hunks(expanded);

        expect(first?.lines.at(-1)).toMatchObject({ newLine: 21, kind: 'add' });
        expect(second?.lines[0]).toMatchObject({ newLine: 36, text: 'line-36' });
        expect(inner).toMatchObject({ hiddenLines: 14, newStart: 22 });
    });

    it('repeated clicks accumulate and preserve the original gap key', () => {
        const model = twoHunks();
        const inner = gaps(model).find((gap) => gap.edge === 'inner');
        if (inner === undefined) {
            throw new Error('model has no inner gap');
        }
        const key = gapKeyOf(inner);
        const once = expandGap(EMPTY_EXPANSION, key, 'up');
        const twice = expandGap(once, key, 'up');
        const expanded = expandFileContext(model, CONTENT, twice);
        const remaining = gaps(expanded).find((gap) => gap.edge === 'inner');

        expect(twice.get(key)?.up).toBe(40);
        expect(remaining).toBeUndefined();
    });

    it('remainder below 20 expands with one target and the gap bar disappears', () => {
        const model = twoHunks();
        const expanded = expandFileContext(model, CONTENT, expansionFor(model, 'inner', 'all'));

        expect(gaps(expanded).some((gap) => gap.edge === 'inner')).toBe(false);
        expect(hunks(expanded)).toHaveLength(1);
    });

    it('meeting expansion directions merge adjacent hunks', () => {
        const model = twoHunks();
        const inner = gaps(model).find((gap) => gap.edge === 'inner');
        if (inner === undefined) {
            throw new Error('model has no inner gap');
        }
        const key = gapKeyOf(inner);
        const up = expandGap(EMPTY_EXPANSION, key, 'up', 10);
        const both = expandGap(up, key, 'down', 9);
        const expanded = expandFileContext(model, CONTENT, both);
        const merged = hunks(expanded);

        expect(merged).toHaveLength(1);
        const middle = merged[0]?.lines.filter((line) => line.newLine !== null).map((line) => line.newLine);
        expect(middle).toEqual(Array.from({ length: 21 }, (_, index) => index + 21));
    });

    it('leading gap expands toward the first hunk', () => {
        const model = twoHunks();
        const expanded = expandFileContext(model, CONTENT, expansionFor(model, 'leading', 'up'));

        expect(gaps(expanded).some((gap) => gap.edge === 'leading')).toBe(false);
        expect(hunks(expanded)[0]?.newStart).toBe(1);
        expect(hunks(expanded)[0]?.lines[0]).toMatchObject({ newLine: 1, text: 'line-1' });
    });

    it('trailing gap with hiddenLines=null derives its length from content and expands downward', () => {
        const model = twoHunks();
        const trailing = gaps(model).at(-1);
        if (trailing === undefined) {
            throw new Error('model has no trailing gap');
        }
        expect(hiddenLinesOf(trailing, null)).toBeNull();
        expect(hiddenLinesOf(trailing, CONTENT)).toBe(79);

        const expanded = expandFileContext(model, CONTENT, expansionFor(model, 'trailing', 'down'));
        const remaining = gaps(expanded).at(-1);
        expect(hunks(expanded).at(-1)?.lines.at(-1)).toMatchObject({ newLine: 61, text: 'line-61' });
        expect(remaining?.newStart).toBe(62);
        expect(hiddenLinesOf(remaining ?? trailing, CONTENT)).toBe(59);
    });

    it('computes aria-live after loading from the actual expanded lines and remainder', () => {
        const model = twoHunks();
        const trailing = gaps(model).at(-1);
        if (trailing === undefined) {
            throw new Error('model has no trailing gap');
        }
        const key = gapKeyOf(trailing);
        const before = expandFileContext(model, CONTENT, EMPTY_EXPANSION);
        const expansion = expandGap(EMPTY_EXPANSION, key, 'down');
        const after = expandFileContext(model, CONTENT, expansion);

        expect(gapExpansionDelta(before, after, CONTENT, key)).toEqual({ loaded: 20, hidden: 59 });

        const shortLines = LINES.slice(0, 55);
        const short: FileContent = { oldText: shortLines.join('\n'), newText: shortLines.join('\n') };
        const beforeLast = expandFileContext(model, short, EMPTY_EXPANSION);
        const afterLast = expandFileContext(model, short, expansion);
        expect(gapExpansionDelta(beforeLast, afterLast, short, key)).toEqual({ loaded: 14, hidden: 0 });
    });

    it('"expand file" leaves no gaps', () => {
        const model = twoHunks();
        const expanded = expandFileContext(model, CONTENT, expandAllGaps(model, EMPTY_EXPANSION));

        expect(gaps(expanded)).toEqual([]);
        expect(remainingHiddenLines(expanded, CONTENT)).toBe(0);
        expect(hunks(expanded)[0]?.lines.filter((line) => line.newLine !== null)).toHaveLength(120);
    });

    it('newline at the end of a file does not become an extra line', () => {
        const model = twoHunks();
        const withNewline: FileContent = { oldText: `${LINES.join('\n')}\n`, newText: `${LINES.join('\n')}\n` };
        const expanded = expandFileContext(model, withNewline, expandAllGaps(model, EMPTY_EXPANSION));

        expect(hunks(expanded)[0]?.lines.at(-1)).toMatchObject({ newLine: 120, text: 'line-120' });
    });

    it('added file and model without content stay unchanged', () => {
        const added = parseFileDiff({
            fileId: 'f2',
            path: 'new.ts',
            oldPath: null,
            changeType: 'add',
            binary: false,
            patch: ['@@ -0,0 +1,2 @@', '+line-1', '+line-2', ''].join('\n'),
        });
        const addedContent = { oldText: null, newText: 'line-1\nline-2' };
        const model = twoHunks();

        expect(remainingHiddenLines(added, addedContent)).toBe(0);
        expect(expandFileContext(added, addedContent, expandAllGaps(added, EMPTY_EXPANSION))).toEqual(added);
        expect(expandFileContext(model, null, expandAllGaps(model, EMPTY_EXPANSION))).toEqual(model);
        expect(remainingHiddenLines(model, null)).toBeNull();
    });

    it('content shorter than expected adds only real lines', () => {
        const model = twoHunks();
        const short: FileContent = { oldText: 'line-1\nline-2', newText: 'line-1\nline-2' };
        const expanded = expandFileContext(model, short, expandAllGaps(model, EMPTY_EXPANSION));
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
        const expanded = expandFileContext(model, CONTENT, expansionFor(model, 'inner', 'down', 3));
        const revealed = hunks(expanded)[1]?.lines[0];

        expect(revealed).toMatchObject({ oldLine: 38, newLine: 40, text: 'line-40' });
    });
});
