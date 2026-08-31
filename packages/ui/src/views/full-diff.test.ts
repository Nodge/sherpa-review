import { describe, expect, it } from 'vitest';

import { parseFileDiff } from '../diff/parse.js';
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

    it('does not carry an old selection to another line button', () => {
        expect(commentPosition(selection, MODEL, 'f1', 'new', 50)).toEqual({ side: 'new', line: 50, size: 1 });
    });
});
