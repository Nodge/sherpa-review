import type { FileDiff, PrDiff, RouteAnchor } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { walkPatch } from '../route/diff-index.js';
import { mediumReadySnapshot } from '../route/fixture-support.js';
import type { LineRange } from '../route/ranges.js';
import type { IterationMap, MappedRange } from './line-map.js';
import { affectedStops, buildIterationMap, classifyStop, identityMap } from './line-map.js';

/**
 * Line mapping A→B from an interdiff. Each rule gets its own patch: an off-by-one error
 * assigns carried progress to the wrong lines and makes a valid stop falsely `new`.
 */

const PATH = 'services/orders/src/infra/clock.ts';
const OTHER = 'services/orders/src/api/handlers.ts';
const BASE = 'base-a1b2c3';
const HEADERS = ['--- a/x.ts', '+++ b/x.ts'];

/** 1 deleted line versus 2 added lines: delta +1. */
const PLUS_ONE = [
    ...HEADERS,
    '@@ -10,6 +10,7 @@',
    ' ctx10',
    ' ctx11',
    '-del12',
    '+add12',
    '+add13',
    ' ctx13',
    ' ctx14',
    ' ctx15',
];

/** 2 deleted lines versus 1 added line: delta −1. */
const MINUS_ONE = [
    ...HEADERS,
    '@@ -10,7 +10,6 @@',
    ' ctx10',
    ' ctx11',
    '-del12',
    '-del13',
    '+add12',
    ' ctx14',
    ' ctx15',
    ' ctx16',
];

/** 2 changes in a single hunk with context between them. */
const TWO_CHANGES = [
    ...HEADERS,
    '@@ -10,5 +10,5 @@',
    ' ctx10',
    '-del11',
    '+add11',
    ' ctx12',
    '-del13',
    '+add13',
    ' ctx14',
];

/** Inserts 2 lines between 11 and 12 without any deletions. */
const INSERT = [...HEADERS, '@@ -10,3 +10,5 @@', ' ctx10', ' ctx11', '+ins12', '+ins13', ' ctx12'];

/** Deletes 2 lines without any additions. */
const DELETE_ONLY = [...HEADERS, '@@ -10,4 +10,2 @@', ' ctx10', '-del11', '-del12', ' ctx13'];

/** 2 insertions in a single hunk with context between them: no deletions. */
const TWO_INSERTS = [...HEADERS, '@@ -9,4 +9,6 @@', ' ctx9', ' ctx10', '+ins11', ' ctx11', '+ins13', ' ctx12'];

/** Insertion at the start of the region and replacement at its end: only the insertion has an outside neighbor. */
const INSERT_THEN_REPLACE = [
    ...HEADERS,
    '@@ -10,4 +10,5 @@',
    ' ctx10',
    '+ins11',
    ' ctx11',
    '-del12',
    '+add12',
    ' ctx13',
];

function fileDiff(overrides: Partial<FileDiff> & Pick<FileDiff, 'path'>): FileDiff {
    return {
        fileId: `file:${overrides.path}`,
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: 0,
        deletions: 0,
        patch: null,
        viewed: null,
        blameUrl: null,
        hostFileUrl: null,
        image: null,
        ...overrides,
    };
}

function interdiffOf(files: readonly FileDiff[]): PrDiff {
    return { diffId: 'iteration-b', baseCommit: BASE, headCommit: 'head-b', files: [...files] };
}

/** Map for a single changed file `PATH`. Bases match by default. */
function mapWith(patch: readonly string[] | null, bases: { from?: string; to?: string } = {}): IterationMap {
    return buildIterationMap({
        interdiff: interdiffOf([fileDiff({ path: PATH, patch: patch === null ? null : patch.join('\n') })]),
        fromBaseCommit: bases.from ?? BASE,
        toBaseCommit: bases.to ?? BASE,
    });
}

function range(start: number, end: number): LineRange {
    return { start, end };
}

function mapNew(map: IterationMap, start: number, end: number): MappedRange {
    return map.mapRange(PATH, 'new', range(start, end));
}

function anchor(overrides: Partial<RouteAnchor> & Pick<RouteAnchor, 'start' | 'end'>): RouteAnchor {
    return { fileId: `file:${PATH}`, path: PATH, side: 'new', collapsed: false, ...overrides };
}

function totalLength(ranges: readonly LineRange[]): number {
    return ranges.reduce((sum, item) => sum + (item.end - item.start + 1), 0);
}

describe('carrying over new-side ranges', () => {
    it('carries over a range entirely before the hunk without a shift', () => {
        expect(mapNew(mapWith(PLUS_ONE), 1, 5)).toEqual({ carried: [range(1, 5)], touched: [] });
    });

    it('shifts a range entirely after the hunk by a positive delta', () => {
        expect(mapNew(mapWith(PLUS_ONE), 20, 25)).toEqual({ carried: [range(21, 26)], touched: [] });
    });

    it('shifts a range entirely after the hunk by a negative delta', () => {
        expect(mapNew(mapWith(MINUS_ONE), 20, 25)).toEqual({ carried: [range(19, 24)], touched: [] });
    });

    it('splits a range overlapping the left edge of the hunk region into touched and carried pieces', () => {
        expect(mapNew(mapWith(PLUS_ONE), 11, 12)).toEqual({ carried: [range(11, 11)], touched: [range(12, 12)] });
    });

    it('carries over the tail of a range overlapping the right edge of the hunk region with a shift', () => {
        expect(mapNew(mapWith(PLUS_ONE), 12, 13)).toEqual({ carried: [range(14, 14)], touched: [range(12, 12)] });
    });

    it('splits a range around the hunk in 2: the pieces have different shifts', () => {
        expect(mapNew(mapWith(PLUS_ONE), 11, 14)).toEqual({
            carried: [range(11, 11), range(14, 15)],
            touched: [range(12, 12)],
        });
    });

    it('does not carry over a range inside the hunk region', () => {
        expect(mapNew(mapWith(TWO_CHANGES), 11, 13)).toEqual({ carried: [], touched: [range(11, 13)] });
    });

    it('leaves context at the start and end of the hunk untouched', () => {
        expect(mapNew(mapWith(PLUS_ONE), 10, 11)).toEqual({ carried: [range(10, 11)], touched: [] });
        expect(mapNew(mapWith(PLUS_ONE), 13, 15)).toEqual({ carried: [range(14, 16)], touched: [] });
    });

    it('touches context between 2 changes in the same hunk', () => {
        expect(mapWith(TWO_CHANGES).touchedInA(PATH, 'new', range(12, 12))).toEqual([range(12, 12)]);
        expect(mapWith(TWO_CHANGES).touchedInB(PATH, 'new', range(12, 12))).toEqual([range(12, 12)]);
    });
});

describe('insertion without deletions', () => {
    it('touches the lines next to the insertion in A', () => {
        expect(mapWith(INSERT).touchedInA(PATH, 'new', range(1, 30))).toEqual([range(11, 12)]);
    });

    it('touches the inserted lines themselves in B', () => {
        expect(mapWith(INSERT).touchedInB(PATH, 'new', range(1, 30))).toEqual([range(12, 13)]);
    });

    it('carries over lines after the insertion with a shift', () => {
        expect(mapNew(mapWith(INSERT), 13, 14)).toEqual({ carried: [range(15, 16)], touched: [] });
    });

    it('insertion at the start of the file touches only the following line in A', () => {
        const patch = [...HEADERS, '@@ -1,2 +1,4 @@', '+ins1', '+ins2', ' ctx1', ' ctx2'];
        const map = mapWith(patch);
        expect(map.touchedInA(PATH, 'new', range(1, 10))).toEqual([range(1, 1)]);
        expect(mapNew(map, 2, 2)).toEqual({ carried: [range(4, 4)], touched: [] });
    });

    it('deletion without additions touches neighbors of the removed lines in B', () => {
        const map = mapWith(DELETE_ONLY);
        expect(map.touchedInA(PATH, 'new', range(1, 30))).toEqual([range(11, 12)]);
        expect(map.touchedInB(PATH, 'new', range(1, 30))).toEqual([range(10, 11)]);
    });

    it('insertion marks neighbors even when git merged it with another change into a single hunk', () => {
        const map = mapWith(TWO_INSERTS);
        expect(map.touchedInA(PATH, 'new', range(1, 30))).toEqual([range(10, 12)]);
        expect(map.touchedInB(PATH, 'new', range(1, 30))).toEqual([range(11, 13)]);
    });

    it('insertion at the start of a region includes an outside neighbor, replacement at the end does not', () => {
        const map = mapWith(INSERT_THEN_REPLACE);
        expect(map.touchedInA(PATH, 'new', range(1, 30))).toEqual([range(10, 12)]);
        expect(map.touchedInB(PATH, 'new', range(1, 30))).toEqual([range(11, 13)]);
        expect(mapNew(map, 13, 13)).toEqual({ carried: [range(14, 14)], touched: [] });
    });

    it('line replacement stays within its lines: carries over adjacent context', () => {
        expect(mapWith(PLUS_ONE).touchedInA(PATH, 'new', range(1, 30))).toEqual([range(12, 12)]);
    });
});

describe('file statuses', () => {
    it('a path absent from the interdiff is unchanged and maps identically', () => {
        const map = mapWith(PLUS_ONE);
        expect(map.fileStatus(OTHER)).toBe('unchanged');
        expect(map.mapRange(OTHER, 'new', range(5, 9))).toEqual({ carried: [range(5, 9)], touched: [] });
        expect(map.touchedInB(OTHER, 'new', range(5, 9))).toEqual([]);
    });

    it('deleted file: nothing to carry over, everything is touched', () => {
        const map = buildIterationMap({
            interdiff: interdiffOf([fileDiff({ path: PATH, changeType: 'delete' })]),
            fromBaseCommit: BASE,
            toBaseCommit: BASE,
        });
        expect(map.fileStatus(PATH)).toBe('removed');
        expect(mapNew(map, 3, 7)).toEqual({ carried: [], touched: [range(3, 7)] });
        expect(map.touchedInB(PATH, 'new', range(3, 7))).toEqual([range(3, 7)]);
    });

    it('added file: absent from A, the entire range is touched', () => {
        const map = buildIterationMap({
            interdiff: interdiffOf([fileDiff({ path: PATH, changeType: 'add' })]),
            fromBaseCommit: BASE,
            toBaseCommit: BASE,
        });
        expect(map.fileStatus(PATH)).toBe('added');
        expect(mapNew(map, 1, 4)).toEqual({ carried: [], touched: [range(1, 4)] });
    });

    it('rename means removed and added: old path is removed, new path is added', () => {
        const map = buildIterationMap({
            interdiff: interdiffOf([fileDiff({ path: PATH, oldPath: OTHER, changeType: 'move' })]),
            fromBaseCommit: BASE,
            toBaseCommit: BASE,
        });
        expect(map.fileStatus(OTHER)).toBe('removed');
        expect(map.fileStatus(PATH)).toBe('added');
        expect(map.mapRange(OTHER, 'new', range(1, 3))).toEqual({ carried: [], touched: [range(1, 3)] });
        expect(mapNew(map, 1, 3)).toEqual({ carried: [], touched: [range(1, 3)] });
    });

    it('copy: new path is added, source is untouched', () => {
        const map = buildIterationMap({
            interdiff: interdiffOf([fileDiff({ path: PATH, oldPath: OTHER, changeType: 'copy' })]),
            fromBaseCommit: BASE,
            toBaseCommit: BASE,
        });
        expect(map.fileStatus(PATH)).toBe('added');
        expect(map.fileStatus(OTHER)).toBe('unchanged');
        expect(map.mapRange(OTHER, 'new', range(1, 3))).toEqual({ carried: [range(1, 3)], touched: [] });
    });

    it('treats conflict as an ordinary file change', () => {
        const map = buildIterationMap({
            interdiff: interdiffOf([
                fileDiff({ path: PATH, changeType: 'conflict', patch: PLUS_ONE.join('\n') }),
            ]),
            fromBaseCommit: BASE,
            toBaseCommit: BASE,
        });
        expect(map.fileStatus(PATH)).toBe('modified');
        expect(mapNew(map, 20, 20)).toEqual({ carried: [range(21, 21)], touched: [] });
    });

    it('a file without a text diff is entirely touched on both sides', () => {
        const map = mapWith(null);
        expect(mapNew(map, 4, 8)).toEqual({ carried: [], touched: [range(4, 8)] });
        expect(map.touchedInB(PATH, 'new', range(4, 8))).toEqual([range(4, 8)]);
        // An unchanged base does not save the old side: there is still no mapping to carry it over.
        expect(map.mapRange(PATH, 'old', range(4, 8))).toEqual({ carried: [], touched: [range(4, 8)] });
        expect(map.touchedInB(PATH, 'old', range(4, 8))).toEqual([range(4, 8)]);
    });
});

describe('identity mappings', () => {
    it('null interdiff means regeneration on the same iteration: carries everything over as is', () => {
        const map = buildIterationMap({ interdiff: null, fromBaseCommit: BASE, toBaseCommit: BASE });
        expect(map.fileStatus(PATH)).toBe('unchanged');
        expect(mapNew(map, 7, 12)).toEqual({ carried: [range(7, 12)], touched: [] });
        expect(map.touchedInA(PATH, 'new', range(7, 12))).toEqual([]);
    });

    it('an interdiff with no files is an identity mapping', () => {
        const map = buildIterationMap({ interdiff: interdiffOf([]), fromBaseCommit: BASE, toBaseCommit: BASE });
        expect(mapNew(map, 7, 12)).toEqual({ carried: [range(7, 12)], touched: [] });
    });

    it('identityMap touches nothing', () => {
        const map = identityMap();
        expect(map.fileStatus(PATH)).toBe('unchanged');
        expect(map.mapRange(PATH, 'old', range(1, 3))).toEqual({ carried: [range(1, 3)], touched: [] });
        expect(map.touchedInB(PATH, 'new', range(1, 3))).toEqual([]);
    });

    it('a degenerate range carries over nothing in either map', () => {
        expect(mapWith(PLUS_ONE).mapRange(PATH, 'new', range(5, 3))).toEqual({ carried: [], touched: [] });
        expect(identityMap().mapRange(PATH, 'new', range(5, 3))).toEqual({ carried: [], touched: [] });
    });
});

describe('old side and base changes', () => {
    it('unchanged base: old side maps identically', () => {
        expect(mapWith(PLUS_ONE).mapRange(PATH, 'old', range(10, 14))).toEqual({
            carried: [range(10, 14)],
            touched: [],
        });
    });

    it('changed base: entire old side is touched, new side carries over as usual', () => {
        const map = mapWith(PLUS_ONE, { to: 'base-d4e5f6' });
        expect(map.mapRange(PATH, 'old', range(10, 14))).toEqual({ carried: [], touched: [range(10, 14)] });
        expect(map.touchedInB(PATH, 'old', range(10, 14))).toEqual([range(10, 14)]);
        expect(mapNew(map, 20, 21)).toEqual({ carried: [range(21, 22)], touched: [] });
    });

    it('base changed with an empty interdiff: old side is still touched', () => {
        const map = buildIterationMap({ interdiff: null, fromBaseCommit: BASE, toBaseCommit: 'base-d4e5f6' });
        expect(map.mapRange(PATH, 'old', range(1, 5))).toEqual({ carried: [], touched: [range(1, 5)] });
        expect(map.touchedInB(PATH, 'old', range(1, 5))).toEqual([range(1, 5)]);
        expect(mapNew(map, 1, 5)).toEqual({ carried: [range(1, 5)], touched: [] });
    });

    it('changed base: old side is touched even for files outside the interdiff', () => {
        const map = mapWith(PLUS_ONE, { to: 'base-d4e5f6' });
        expect(map.mapRange(OTHER, 'old', range(1, 2))).toEqual({ carried: [], touched: [range(1, 2)] });
    });

    it('unknown base: old side is touched, new side carries over as usual', () => {
        // Iteration recorded by server 0.3.x: no row in `iterations` and no snapshot with a base.
        const map = buildIterationMap({
            interdiff: interdiffOf([fileDiff({ path: PATH, patch: PLUS_ONE.join('\n') })]),
            fromBaseCommit: null,
            toBaseCommit: BASE,
        });

        expect(map.mapRange(PATH, 'old', range(10, 14))).toEqual({ carried: [], touched: [range(10, 14)] });
        expect(map.touchedInB(PATH, 'old', range(10, 14))).toEqual([range(10, 14)]);
        expect(mapNew(map, 20, 21)).toEqual({ carried: [range(21, 22)], touched: [] });
    });
});

describe('mapping invariants', () => {
    const patches = [PLUS_ONE, MINUS_ONE, TWO_CHANGES, INSERT, DELETE_ONLY, TWO_INSERTS, INSERT_THEN_REPLACE];

    it('pieces do not overlap, are sorted, and their lengths add up to the input length', () => {
        for (const patch of patches) {
            const map = mapWith(patch);
            for (let start = 1; start <= 20; start += 1) {
                for (let end = start; end <= 20; end += 1) {
                    const result = map.mapRange(PATH, 'new', range(start, end));
                    const length = end - start + 1;
                    expect(totalLength(result.carried) + totalLength(result.touched)).toBe(length);
                    for (const pieces of [result.carried, result.touched]) {
                        let previous = 0;
                        for (const piece of pieces) {
                            expect(piece.start).toBeGreaterThan(previous);
                            expect(piece.end).toBeGreaterThanOrEqual(piece.start);
                            previous = piece.end;
                        }
                    }
                }
            }
        }
    });
});

describe('consistency with walkPatch', () => {
    /**
     * Reference for rule 1 directly from patch markup: changed hunk lines plus context between them.
     * Works for patches without pure insertions, whose region also grows to include neighbors (rule 2).
     */
    function expectedTouchedOld(patch: readonly string[]): number[] {
        const touched: number[] = [];
        for (const hunk of hunksOf(patch)) {
            const first = hunk.findIndex((line) => line.changed);
            const last = hunk.findLastIndex((line) => line.changed);
            if (first < 0) {
                continue;
            }
            for (const line of hunk.slice(first, last + 1)) {
                if (line.old !== null) {
                    touched.push(line.old);
                }
            }
        }
        return touched;
    }

    function hunksOf(patch: readonly string[]): { old: number | null; new: number | null; changed: boolean }[][] {
        const hunks: { old: number | null; new: number | null; changed: boolean }[][] = [];
        for (const line of walkPatch(patch.join('\n'))) {
            if (line.old === null && line.new === null) {
                if (line.raw.startsWith('@@')) {
                    hunks.push([]);
                }
                continue;
            }
            hunks.at(-1)?.push({ old: line.old, new: line.new, changed: line.changed });
        }
        return hunks;
    }

    const patches = [PLUS_ONE, MINUS_ONE, TWO_CHANGES];

    it('the set of touched lines in A matches the set computed with walkPatch', () => {
        for (const patch of patches) {
            const touched = mapWith(patch).touchedInA(PATH, 'new', range(1, 100));
            const lines = touched.flatMap((piece) => {
                const numbers: number[] = [];
                for (let line = piece.start; line <= piece.end; line += 1) {
                    numbers.push(line);
                }
                return numbers;
            });
            expect(lines).toEqual(expectedTouchedOld(patch));
        }
    });

    it('the shift of each untouched context line equals new − old from walkPatch', () => {
        for (const patch of patches) {
            const map = mapWith(patch);
            const touched = new Set(expectedTouchedOld(patch));
            for (const hunk of hunksOf(patch)) {
                for (const line of hunk) {
                    if (line.changed || line.old === null || line.new === null || touched.has(line.old)) {
                        continue;
                    }
                    expect(map.mapRange(PATH, 'new', range(line.old, line.old)).carried).toEqual([
                        range(line.new, line.new),
                    ]);
                }
            }
        }
    });
});

describe('classifying a new snapshot stop', () => {
    it('all anchor lines are touched: stop is new', () => {
        const map = mapWith(TWO_CHANGES);
        expect(classifyStop({ anchors: [anchor({ start: 11, end: 13 })] }, map)).toBe('new');
    });

    it('file appeared between iterations: stop is new', () => {
        const map = buildIterationMap({
            interdiff: interdiffOf([fileDiff({ path: PATH, changeType: 'add' })]),
            fromBaseCommit: BASE,
            toBaseCommit: BASE,
        });
        expect(classifyStop({ anchors: [anchor({ start: 1, end: 40 })] }, map)).toBe('new');
    });

    it('some lines are touched: stop is changed', () => {
        const map = mapWith(TWO_CHANGES);
        expect(classifyStop({ anchors: [anchor({ start: 10, end: 14 })] }, map)).toBe('changed');
    });

    it('some anchors are touched and some are not: stop is changed', () => {
        const map = mapWith(TWO_CHANGES);
        const stop = { anchors: [anchor({ start: 11, end: 13 }), anchor({ path: OTHER, start: 1, end: 5 })] };
        expect(classifyStop(stop, map)).toBe('changed');
    });

    it('no lines are touched: no classification', () => {
        const map = mapWith(TWO_CHANGES);
        expect(classifyStop({ anchors: [anchor({ start: 20, end: 25 })] }, map)).toBeNull();
    });

    it('does not classify a stop without anchors', () => {
        expect(classifyStop({ anchors: [] }, mapWith(TWO_CHANGES))).toBeNull();
    });

    it('classifies a stop with an old-side anchor as new when the base changes', () => {
        const map = mapWith(TWO_CHANGES, { to: 'base-d4e5f6' });
        expect(classifyStop({ anchors: [anchor({ side: 'old', start: 40, end: 44 })] }, map)).toBe('new');
    });
});

describe('affected stops in the old snapshot', () => {
    it('returns IDs of stops with affected anchors in snapshot order', () => {
        const snapshot = mediumReadySnapshot();
        const map = mapWith(PLUS_ONE);
        expect(affectedStops(snapshot, map)).toEqual(['s01']);
    });

    it('returns no stops when the interdiff leaves the snapshot untouched', () => {
        expect(affectedStops(mediumReadySnapshot(), identityMap())).toEqual([]);
    });

    it('affects stops with old-side anchors when the base changes', () => {
        const snapshot = mediumReadySnapshot();
        const map = mapWith(PLUS_ONE, { to: 'base-d4e5f6' });
        expect(affectedStops(snapshot, map)).toContain('s02');
    });
});
