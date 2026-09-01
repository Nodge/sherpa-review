import type { FileContent } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { parseFileDiff } from '../diff/parse.js';
import { expandFileContext, expandGap, gapKeyOf } from '../diff-view/expand.js';
import { commentPosition } from './full-diff.tsx';

const MODEL = parseFileDiff({
    fileId: 'f1',
    path: 'app.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    patch: [
        '@@ -100,4 +120,5 @@',
        ' context-before',
        '-old-101',
        '-old-102',
        '+new-121',
        '+new-122',
        '+new-123',
        ' context-after',
    ].join('\n'),
});

describe('line comment anchor', () => {
    const selection = { fileId: 'f1', anchor: 'a121', focus: 'a123' };

    it('preserves the selected range on a click inside it', () => {
        expect(commentPosition(selection, MODEL, 'f1', 'new', 122)).toEqual({ side: 'new', line: 121, size: 3 });
    });

    it('anchors a comment to the first line of a backward selection', () => {
        expect(commentPosition({ ...selection, anchor: 'a123', focus: 'a121' }, MODEL, 'f1', 'new', 121)).toEqual({
            side: 'new',
            line: 121,
            size: 3,
        });
    });

    it.each([
        ['deletion → addition', 'd101', 'a123'],
        ['addition → deletion', 'a123', 'd101'],
    ] as const)('%s projects the replacement range onto the old side', (_label, anchor, focus) => {
        expect(commentPosition({ fileId: 'f1', anchor, focus }, MODEL, 'f1', 'old', 101)).toEqual({
            side: 'old',
            line: 101,
            size: 2,
        });
    });

    it.each([
        ['deletion → addition', 'd101', 'a123'],
        ['addition → deletion', 'a123', 'd101'],
    ] as const)('%s projects the replacement range onto the new side', (_label, anchor, focus) => {
        expect(commentPosition({ fileId: 'f1', anchor, focus }, MODEL, 'f1', 'new', 123)).toEqual({
            side: 'new',
            line: 121,
            size: 3,
        });
    });

    it('uses expanded context instead of the raw file model', () => {
        if (MODEL.content.kind !== 'text') {
            throw new Error('the test needs a text model');
        }
        const gap = MODEL.content.blocks.find((block) => block.kind === 'gap' && block.edge === 'leading');
        if (gap?.kind !== 'gap') {
            throw new Error('the test needs a leading gap');
        }
        const lines = Array.from({ length: 140 }, (_, index) => `line-${String(index + 1)}`);
        const content: FileContent = { oldText: lines.join('\n'), newText: lines.join('\n') };
        const expanded = expandFileContext(MODEL, content, expandGap(new Map(), gapKeyOf(gap), 'up', 2));
        const expandedSelection = { fileId: 'f1', anchor: 'c98:98', focus: 'c99:99' };

        expect(commentPosition(expandedSelection, MODEL, 'f1', 'new', 98)).toEqual({
            side: 'new',
            line: 98,
            size: 1,
        });
        expect(commentPosition(expandedSelection, expanded, 'f1', 'new', 98)).toEqual({
            side: 'new',
            line: 98,
            size: 2,
        });
    });

    it('does not carry an old selection to another line button', () => {
        expect(commentPosition(selection, MODEL, 'f1', 'new', 50)).toEqual({ side: 'new', line: 50, size: 1 });
    });
});
