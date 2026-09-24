import type { FileContent } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel, DiffGap } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { clipModelToAnchors } from '../route/anchor-clip.js';
import { expandFileContext, expandGap, gapKeyOf } from './expand.js';
import { shownFileModel } from './file-card.tsx';
import { gutterDigits } from './gutter.js';

/** A file with 1100 lines: `line-1` … `line-1100`. */
const LINES = Array.from({ length: 1100 }, (_, index) => `line-${String(index + 1)}`);
const CONTENT: FileContent = { oldText: LINES.join('\n'), newText: LINES.join('\n') };

/** Changes at lines 5 and 995. The file tail after them is hidden. */
function model(): DiffFileModel {
    return parseFileDiff({
        fileId: 'f1',
        path: 'app.ts',
        oldPath: null,
        changeType: 'modify',
        binary: false,
        patch: ['@@ -5,1 +5,1 @@', '-line-5', '+line-5 changed', '@@ -995,1 +995,1 @@', '-line-995', '+line-995 changed', ''].join(
            '\n',
        ),
    });
}

function trailingGap(source: DiffFileModel): DiffGap {
    const gap =
        source.content.kind === 'text'
            ? source.content.blocks.find((block): block is DiffGap => block.kind === 'gap' && block.edge === 'trailing')
            : undefined;
    if (gap === undefined) {
        throw new Error('model has no trailing gap');
    }
    return gap;
}

describe('gutterDigits', () => {
    it('uses one digit when there are no lines', () => {
        expect(gutterDigits(null)).toBe(1);
    });

    it('takes the largest number among visible lines on both sides', () => {
        expect(gutterDigits(model())).toBe(3);
    });

    it('widens the column for expanded context with longer line numbers', () => {
        const source = model();
        const expansion = expandGap(new Map(), gapKeyOf(trailingGap(source)), 'down', 10);

        expect(gutterDigits(expandFileContext(source, CONTENT, expansion))).toBe(4);
    });

    it('counts only remaining lines in a route slice', () => {
        const clip = (expanded: DiffFileModel): DiffFileModel =>
            clipModelToAnchors(expanded, [{ side: 'new', start: 5, end: 5 }]).model;

        expect(gutterDigits(shownFileModel(model(), CONTENT, new Map(), clip))).toBe(1);
    });

    it('keeps context expanded within a slice visible and counts its line numbers too', () => {
        const source = model();
        const expansion = expandGap(new Map(), gapKeyOf(trailingGap(source)), 'down', 10);
        const clip = (expanded: DiffFileModel): DiffFileModel =>
            clipModelToAnchors(expanded, [{ side: 'new', start: 5, end: 5 }]).model;

        expect(gutterDigits(shownFileModel(source, CONTENT, expansion, clip))).toBe(4);
    });
});
