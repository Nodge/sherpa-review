import type { AgentNote, ChatAnchor, FileDiff } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { parseFileDiff } from '../diff/parse.js';
import {
    groupOverlappingNotes,
    noteStackNeedsSummary,
    placeNotesOnVisibleLines,
} from './model.js';

const FILE: FileDiff = {
    fileId: 'file-1',
    path: 'src/cache.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    additions: 3,
    deletions: 1,
    generated: false,
    viewed: false,
    blameUrl: null,
    patch: [
        '@@ -40,3 +40,5 @@',
        ' const cached = readCache(key);',
        '-return cached;',
        '+if (cached !== null) {',
        '+    return cached;',
        '+}',
        ' return load(key);',
        '',
    ].join('\n'),
};
const MODEL = parseFileDiff(FILE);

function note(
    id: number,
    start: number,
    end: number,
    createdAt: string,
    overrides: Partial<AgentNote> = {},
): AgentNote {
    const anchor: ChatAnchor = { diffId: 'iter-1', fileId: FILE.fileId, path: FILE.path, side: 'new', start, end };
    return {
        id,
        exchangeId: id,
        anchor,
        text: `Note ${String(id)}`,
        lostAnchor: false,
        origin: { commit: 'abcdef1', anchor },
        createdAt,
        ...overrides,
    };
}

describe('note stacks', () => {
    it('groups transitive overlaps and sorts newer notes first', () => {
        const groups = groupOverlappingNotes([
            note(1, 10, 12, '2026-09-01T10:00:00.000Z'),
            note(2, 12, 14, '2026-09-01T10:02:00.000Z'),
            note(3, 14, 16, '2026-09-01T10:01:00.000Z'),
            note(4, 30, 31, '2026-09-01T10:03:00.000Z'),
        ]);

        expect(groups).toHaveLength(2);
        expect(groups[0]).toMatchObject({ start: 10, end: 16 });
        expect(groups[0]?.notes.map((item) => item.id)).toEqual([2, 3, 1]);
        expect(groups[1]?.notes.map((item) => item.id)).toEqual([4]);
    });

    it('summarises a stack only when it has more than three notes', () => {
        const three = groupOverlappingNotes([
            note(1, 41, 43, '2026-09-01T10:00:00.000Z'),
            note(2, 42, 43, '2026-09-01T10:01:00.000Z'),
            note(3, 43, 43, '2026-09-01T10:02:00.000Z'),
        ])[0];
        const four = groupOverlappingNotes([
            note(1, 41, 43, '2026-09-01T10:00:00.000Z'),
            note(2, 42, 43, '2026-09-01T10:01:00.000Z'),
            note(3, 43, 43, '2026-09-01T10:02:00.000Z'),
            note(4, 43, 44, '2026-09-01T10:03:00.000Z'),
        ])[0];

        expect(three === undefined ? null : noteStackNeedsSummary(three)).toBe(false);
        expect(four === undefined ? null : noteStackNeedsSummary(four)).toBe(true);
    });
});

describe('note placement on card lines', () => {
    it('exact keeps a clipped range end under the header and hides a range outside the card', () => {
        const visible = note(1, 41, 42, '2026-09-01T10:00:00.000Z');
        const clipped = note(2, 43, 47, '2026-09-01T10:01:00.000Z');
        const outside = note(3, 90, 99, '2026-09-01T10:02:00.000Z');
        const placement = placeNotesOnVisibleLines(MODEL, true, [outside, clipped, visible], 'exact');

        expect(placement.byLine.get('new:42')?.flatMap((group) => group.notes.map((item) => item.id))).toEqual([1]);
        expect(placement.underHeader.flatMap((group) => group.notes.map((item) => item.id))).toEqual([2]);
        expect(placement.hidden.flatMap((group) => group.notes.map((item) => item.id))).toEqual([3]);
    });

    it('nearest moves a full diff note to the nearest visible line', () => {
        const outside = note(2, 90, 99, '2026-09-01T10:01:00.000Z');
        const placement = placeNotesOnVisibleLines(MODEL, true, [outside], 'nearest');

        expect(placement.byLine.get('new:44')?.[0]?.notes.map((item) => item.id)).toEqual([2]);
        expect(placement.hidden).toEqual([]);
    });

    it('shows notes belonging to a card without lines under its header in both modes', () => {
        const anchored = note(1, 41, 43, '2026-09-01T10:00:00.000Z');
        const nearest = placeNotesOnVisibleLines(MODEL, false, [anchored], 'nearest');
        const exact = placeNotesOnVisibleLines(MODEL, false, [anchored], 'exact');

        expect(nearest.underHeader[0]?.notes.map((item) => item.id)).toEqual([1]);
        expect(exact.underHeader[0]?.notes.map((item) => item.id)).toEqual([1]);
        expect(exact.hidden).toEqual([]);
    });
});
