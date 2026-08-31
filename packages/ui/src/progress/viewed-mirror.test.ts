import type { UiFileProgress, UiSeenRange } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { ChangedLines, ReadStateFile } from './read-state.js';
import { readStateOf } from './read-state.js';
import type { ViewedMirrorSource } from './viewed-mirror.js';
import { viewedMirrorUpdate } from './viewed-mirror.js';

const PLAIN: ReadStateFile = { generated: false, viewed: null, additions: 3, deletions: 0 };
const CHANGED: ChangedLines = { old: new Set(), new: new Set([1, 2, 3]) };

interface SourceFile {
    readonly fileId: string;
    readonly file?: ReadStateFile;
    readonly record?: UiFileProgress;
}

function record(fileId: string, viewed: boolean, seenRanges: readonly UiSeenRange[] = []): UiFileProgress {
    return { fileId, viewed, seenRanges: [...seenRanges] };
}

function source(files: readonly SourceFile[], fileWrites: ReadonlySet<string> = new Set()): ViewedMirrorSource {
    const progress = new Map<string, UiFileProgress>();
    const readStates = new Map(
        files.map(({ fileId, file = PLAIN, record: progressRecord }) => {
            if (progressRecord !== undefined) {
                progress.set(fileId, progressRecord);
            }
            return [
                fileId,
                readStateOf({
                    file,
                    record: progressRecord ?? null,
                    ...(progressRecord?.seenRanges.length ? { changed: CHANGED } : {}),
                }),
            ] as const;
        }),
    );
    return { progress, readStates, fileWrites };
}

const FULL = [{ side: 'new' as const, start: 1, end: 3 }];
const PARTIAL = [{ side: 'new' as const, start: 1, end: 2 }];

describe('mirroring read state from coverage', () => {
    it('uses the first calculation as a baseline without sending it', () => {
        const update = viewedMirrorUpdate(null, source([{ fileId: 'A', record: record('A', false, FULL) }]));

        expect(update.entries).toEqual([]);
        expect(update.state.get('A')).toBe(true);
    });

    it('produces symmetric deltas for full coverage and clearing a stop', () => {
        const baseline = viewedMirrorUpdate(null, source([{ fileId: 'A', record: record('A', false, PARTIAL) }]));
        const covered = viewedMirrorUpdate(
            baseline.state,
            source([{ fileId: 'A', record: record('A', false, FULL) }]),
        );
        const uncovered = viewedMirrorUpdate(
            covered.state,
            source([{ fileId: 'A', record: record('A', false, PARTIAL) }]),
        );

        expect(covered.entries).toEqual([{ fileId: 'A', viewed: true }]);
        expect(uncovered.entries).toEqual([{ fileId: 'A', viewed: false }]);
    });

    it('keeps old coverage hidden after explicitly clearing a file until ranges are cleared', () => {
        const explicit = viewedMirrorUpdate(
            null,
            source([{ fileId: 'A', record: record('A', true, FULL) }]),
        );
        const optimistic = viewedMirrorUpdate(
            explicit.state,
            source([{ fileId: 'A', record: record('A', false, FULL) }], new Set(['A'])),
        );
        const confirmed = viewedMirrorUpdate(
            optimistic.state,
            source([{ fileId: 'A', record: record('A', false) }], new Set(['A'])),
        );
        const coveredAgain = viewedMirrorUpdate(
            confirmed.state,
            source([{ fileId: 'A', record: record('A', false, FULL) }]),
        );

        expect(optimistic.entries).toEqual([]);
        expect(optimistic.state.get('A')).toBe(false);
        expect(confirmed.entries).toEqual([]);
        expect(confirmed.state.get('A')).toBe(false);
        expect(coveredAgain.entries).toEqual([{ fileId: 'A', viewed: true }]);
    });

    it('does not duplicate an explicit mark on an already covered file', () => {
        const covered = viewedMirrorUpdate(
            null,
            source([{ fileId: 'A', record: record('A', false, FULL) }]),
        );
        const explicitlyViewed = viewedMirrorUpdate(
            covered.state,
            source([{ fileId: 'A', record: record('A', true, FULL) }]),
        );

        expect(covered.state.get('A')).toBe(true);
        expect(explicitlyViewed.entries).toEqual([]);
    });

    it('collects transitions from one recalculation in one list', () => {
        const baseline = viewedMirrorUpdate(
            null,
            source([
                { fileId: 'A', record: record('A', false, PARTIAL) },
                { fileId: 'B', record: record('B', false, PARTIAL) },
            ]),
        );
        const covered = viewedMirrorUpdate(
            baseline.state,
            source([
                { fileId: 'A', record: record('A', false, FULL) },
                { fileId: 'B', record: record('B', false, FULL) },
            ]),
        );

        expect(covered.entries).toEqual([
            { fileId: 'A', viewed: true },
            { fileId: 'B', viewed: true },
        ]);
    });

    it('does not mirror the generated default, partial state, file marks or host marks', () => {
        const baseline = new Map([
            ['generated', false],
            ['partial', false],
            ['explicit', false],
            ['host', false],
        ]);
        const update = viewedMirrorUpdate(
            baseline,
            source([
                { fileId: 'generated', file: { ...PLAIN, generated: true } },
                { fileId: 'partial', record: record('partial', false, PARTIAL) },
                { fileId: 'explicit', record: record('explicit', true) },
                { fileId: 'host', file: { ...PLAIN, viewed: true } },
            ]),
        );

        expect(update.entries).toEqual([]);
    });

    it('an old explicit false record does not hide a later coverage removal', () => {
        const covered = viewedMirrorUpdate(
            null,
            source([{ fileId: 'A', record: record('A', false, FULL) }]),
        );
        const uncovered = viewedMirrorUpdate(
            covered.state,
            source([{ fileId: 'A', record: record('A', false) }]),
        );

        expect(uncovered.entries).toEqual([{ fileId: 'A', viewed: false }]);
    });

    it('avoids a loop on host echo and mirrors only the neighbouring file when clearing a file', () => {
        const covered = viewedMirrorUpdate(
            null,
            source([
                { fileId: 'A', record: record('A', false, FULL) },
                { fileId: 'B', record: record('B', false, FULL) },
            ]),
        );
        const echoed = viewedMirrorUpdate(
            covered.state,
            source([
                { fileId: 'A', file: { ...PLAIN, viewed: true }, record: record('A', false, FULL) },
                { fileId: 'B', file: { ...PLAIN, viewed: true }, record: record('B', false, FULL) },
            ]),
        );
        const afterFileUnmark = viewedMirrorUpdate(
            echoed.state,
            source(
                [
                    { fileId: 'A', file: { ...PLAIN, viewed: false }, record: record('A', false) },
                    { fileId: 'B', file: { ...PLAIN, viewed: true } },
                ],
                new Set(['A']),
            ),
        );

        expect(echoed.entries).toEqual([]);
        expect(afterFileUnmark.entries).toEqual([{ fileId: 'B', viewed: false }]);
    });
});
