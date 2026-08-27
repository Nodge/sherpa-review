import type { FileDiff, RouteStop, UiFileProgress, UiSeenRange } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { FileReadState } from '../progress/read-state.js';
import type { AnchorSpan } from './anchor-clip.js';
import type { RouteEntry, RouteFileGroup } from './route-model.js';
import { stopCoveredByProgress } from './stop-coverage.js';

function file(fileId: string): FileDiff {
    return {
        fileId,
        path: `${fileId}.ts`,
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: 20,
        deletions: 20,
        patch: null,
        viewed: null,
        blameUrl: null,
    };
}

function group(fileId: string, seenRanges: readonly AnchorSpan[]): RouteFileGroup {
    return {
        file: file(fileId),
        fileId,
        path: `${fileId}.ts`,
        name: `${fileId}.ts`,
        dir: '',
        anchors: [],
        collapsedAnchors: [],
        contextLines: { old: new Set(), new: new Set() },
        hunks: seenRanges.length,
        additions: 0,
        deletions: 0,
        collapsedLines: 0,
        seenRanges,
        whole: false,
    };
}

function entry(stopId: string, groups: readonly RouteFileGroup[]): RouteEntry {
    const stop: RouteStop = {
        id: stopId,
        planIndex: 1,
        tier: 'high',
        title: stopId,
        status: 'ready',
        paragraph: 'done',
        bridge: null,
        anchors: [],
        tests: [],
        droppedClaims: 0,
        validationNotes: [],
        provenance: null,
    };
    return {
        kind: 'stop',
        view: {
            stop,
            planLabel: '01',
            files: groups,
            changedLines: 0,
            unresolvedPaths: [],
            drift: false,
            empty: false,
            pending: false,
            parseFailed: false,
        },
    };
}

function snapshot(
    records: readonly UiFileProgress[],
    readStates: readonly (readonly [string, FileReadState])[] = [],
) {
    return {
        progress: new Map(records.map((record) => [record.fileId, record])),
        readState: new Map(readStates),
    };
}

function progress(fileId: string, seenRanges: readonly UiSeenRange[]): UiFileProgress {
    return { fileId, viewed: false, seenRanges: [...seenRanges] };
}

describe('stop coverage by file progress', () => {
    it('requires the entire range to be contained in the union of viewed ranges', () => {
        const target = entry('s01', [group('a', [{ side: 'new', start: 10, end: 20 }])]);

        expect(stopCoveredByProgress(target, snapshot([progress('a', [{ side: 'new', start: 10, end: 19 }])]))).toBe(false);
        expect(
            stopCoveredByProgress(
                target,
                snapshot([
                    progress('a', [
                        { side: 'new', start: 15, end: 20 },
                        { side: 'new', start: 10, end: 14 },
                    ]),
                ]),
            ),
        ).toBe(true);
    });

    it('covers the file portion in a stop with a whole-file pin even without ranges', () => {
        const target = entry('s01', [group('a', [{ side: 'new', start: 10, end: 20 }])]);
        const pinned: FileReadState = {
            state: 'read',
            seen: 40,
            total: 40,
            pinned: true,
            generatedDefault: false,
            tooltip: 'read',
        };

        expect(stopCoveredByProgress(target, snapshot([], [['a', pinned]]))).toBe(true);
    });

    it('does not count the generated default as viewed without a progress record', () => {
        const target = entry('s01', [group('generated', [{ side: 'new', start: 1, end: 20 }])]);
        const generatedDefault: FileReadState = {
            state: 'read',
            seen: 40,
            total: 40,
            pinned: true,
            generatedDefault: true,
            tooltip: 'generated file — read by default',
        };

        expect(stopCoveredByProgress(target, snapshot([], [['generated', generatedDefault]]))).toBe(false);
    });

    it('completes only the covered range of a file shared between stops', () => {
        const first = entry('s01', [group('shared', [{ side: 'new', start: 1, end: 5 }])]);
        const second = entry('s02', [group('shared', [{ side: 'new', start: 6, end: 10 }])]);
        const current = snapshot([progress('shared', [{ side: 'new', start: 1, end: 5 }])]);

        expect(stopCoveredByProgress(first, current)).toBe(true);
        expect(stopCoveredByProgress(second, current)).toBe(false);
    });

    it('keeps old and new sides separate', () => {
        const target = entry('s01', [
            group('a', [
                { side: 'old', start: 2, end: 4 },
                { side: 'new', start: 8, end: 10 },
            ]),
        ]);

        expect(
            stopCoveredByProgress(
                target,
                snapshot([
                    progress('a', [
                        { side: 'new', start: 2, end: 4 },
                        { side: 'new', start: 8, end: 10 },
                    ]),
                ]),
            ),
        ).toBe(false);
        expect(
            stopCoveredByProgress(
                target,
                snapshot([
                    progress('a', [
                        { side: 'old', start: 2, end: 4 },
                        { side: 'new', start: 8, end: 10 },
                    ]),
                ]),
            ),
        ).toBe(true);
    });

    it('does not let a shared orphan whitespace line complete another stop\'s anchored range', () => {
        const orphan = { side: 'new' as const, start: 20, end: 20 };
        const first = entry('s01', [group('shared', [{ side: 'new', start: 1, end: 3 }, orphan])]);
        const second = entry('s02', [group('shared', [{ side: 'new', start: 10, end: 12 }, orphan])]);
        const afterFirst = snapshot([
            progress('shared', [
                { side: 'new', start: 1, end: 3 },
                orphan,
            ]),
        ]);

        expect(stopCoveredByProgress(first, afterFirst)).toBe(true);
        expect(stopCoveredByProgress(second, afterFirst)).toBe(false);
    });
});
