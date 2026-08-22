import type { UiFileProgress, UiSeenRange } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { parseFileDiff } from '../diff/parse.js';
import type { ReadStateFile } from './read-state.js';
import { changedLinesOf, readStateOf } from './read-state.js';

/** Reading progress tri-state (SPEC §2.12) and tooltip counts. */

const PLAIN: ReadStateFile = { generated: false, viewed: null, additions: 40, deletions: 20 };

function record(viewed: boolean, seenRanges: UiSeenRange[] = []): UiFileProgress {
    return { fileId: 'f', viewed, seenRanges };
}

describe('file read-state', () => {
    it('returns unread with zero in the tooltip when there is no record or coverage', () => {
        expect(readStateOf({ file: PLAIN, record: null })).toMatchObject({
            state: 'unread',
            seen: 0,
            total: 60,
            pinned: false,
            generatedDefault: false,
            tooltip: '0 of 60 changed lines seen',
        });
    });

    it('pins the whole file to read when marked manually and matches the tooltip count to the filled box', () => {
        expect(readStateOf({ file: PLAIN, record: record(true) })).toMatchObject({
            state: 'read',
            seen: 60,
            pinned: true,
            tooltip: '60 of 60 changed lines seen',
        });
    });

    it('returns read for a host mark even without a local record', () => {
        expect(readStateOf({ file: { ...PLAIN, viewed: true }, record: null }).state).toBe('read');
        expect(readStateOf({ file: { ...PLAIN, viewed: false }, record: null }).state).toBe('unread');
    });

    it('marks generated files as read by default and says so in the tooltip', () => {
        const state = readStateOf({ file: { ...PLAIN, generated: true }, record: null });

        expect(state).toMatchObject({ state: 'read', pinned: true, generatedDefault: true });
        expect(state.tooltip).toBe('generated — marked read by default · 60 of 60 changed lines seen');
    });

    it('gives records precedence over defaults for an unmarked generated file and host marks', () => {
        expect(readStateOf({ file: { ...PLAIN, generated: true }, record: record(false) })).toMatchObject({
            state: 'unread',
            generatedDefault: false,
        });
        expect(readStateOf({ file: { ...PLAIN, viewed: true }, record: record(false) }).state).toBe('unread');
    });

    it('returns partial for some range coverage and read for full coverage', () => {
        const changed = { old: new Set([10, 11]), new: new Set([20, 21, 22]) };
        const file: ReadStateFile = { generated: false, viewed: null, additions: 3, deletions: 2 };

        const partial = readStateOf({
            file,
            record: record(false, [{ side: 'new', start: 20, end: 21 }]),
            changed,
        });
        expect(partial).toMatchObject({ state: 'partial', seen: 2, total: 5 });
        expect(partial.tooltip).toBe('2 of 5 changed lines seen');

        const full = readStateOf({
            file,
            record: record(false, [
                { side: 'new', start: 18, end: 30 },
                { side: 'old', start: 1, end: 12 },
            ]),
            changed,
        });
        expect(full).toMatchObject({ state: 'read', seen: 5, pinned: false });
    });

    it('counts no coverage for a range outside the changed lines', () => {
        const state = readStateOf({
            file: { generated: false, viewed: null, additions: 3, deletions: 0 },
            record: record(false, [{ side: 'new', start: 100, end: 200 }]),
            changed: { old: new Set(), new: new Set([1, 2, 3]) },
        });

        expect(state).toMatchObject({ state: 'unread', seen: 0 });
    });

    it('uses range lengths without model lines and caps coverage at the changed-line count', () => {
        const file: ReadStateFile = { generated: false, viewed: null, additions: 6, deletions: 0 };

        expect(
            readStateOf({ file, record: record(false, [{ side: 'new', start: 1, end: 3 }]) }),
        ).toMatchObject({ state: 'partial', seen: 3, total: 6 });
        // Merge overlapping ranges: counting a line twice would give a false count.
        expect(
            readStateOf({
                file,
                record: record(false, [
                    { side: 'new', start: 1, end: 4 },
                    { side: 'new', start: 3, end: 5 },
                ]),
            }),
        ).toMatchObject({ state: 'partial', seen: 5 });
        expect(
            readStateOf({ file, record: record(false, [{ side: 'new', start: 1, end: 99 }]) }),
        ).toMatchObject({ state: 'read', seen: 6 });
    });

    it('reports accurate counts for a file without changed lines', () => {
        const binary: ReadStateFile = { generated: false, viewed: null, additions: 0, deletions: 0 };

        expect(readStateOf({ file: binary, record: null })).toMatchObject({
            state: 'unread',
            tooltip: 'no changed lines in this file',
        });
        expect(readStateOf({ file: binary, record: record(true) })).toMatchObject({
            state: 'read',
            tooltip: 'no changed lines in this file',
        });
    });

    it('takes changed lines from the model by side', () => {
        const model = parseFileDiff({
            fileId: 'f',
            path: 'src/a.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: ['@@ -10,3 +10,3 @@', ' one', '-two', '+two!', ' three'].join('\n'),
        });

        expect(changedLinesOf(model)).toEqual({ old: new Set([11]), new: new Set([11]) });
        expect(changedLinesOf(null)).toBeUndefined();
    });
});
