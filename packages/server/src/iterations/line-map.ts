/**
 * Maps lines between PR iterations. Takes an interdiff A→B:
 * a regular `PrDiff` whose old patch side is iteration A's head and whose new side is B's head.
 * A line outside the interdiff hunks carries over to B with an offset. A line inside is "touched".
 *
 * The same functions handle progress carryover, classification of stops in the new snapshot,
 * stale banner text and note anchor migration. Only pure functions here, with no database or host.
 *
 * `walkPatch` reads the hunk layout. It is the same parser that supplies line numbers to the model
 * in the payload. There is no separate parser here.
 */
import type { PrDiff, RouteSnapshot, RouteStop } from '@sherpa/protocol';

import type { PatchLine } from '../route/diff-index.js';
import { walkPatch } from '../route/diff-index.js';
import type { LineRange } from '../route/ranges.js';
import { intersectRanges, subtractRanges } from '../route/ranges.js';

export interface IterationMapInput {
    /**
     * Interdiff A→B. null or an interdiff without files means the iteration heads match
     * (regeneration on the same iteration). The base still needs a separate check:
     * `null` does not mean "nothing changed" if the base changed.
     */
    interdiff: PrDiff | null;
    /**
     * Iteration A's base. If it matches B's base, the `old` side carries over unchanged.
     * `null` means the base is unknown (the iteration was recorded by server 0.3.x, with no row or snapshot).
     * The entire `old` side then counts as touched, as with a base change. Substituting iteration B's base
     * would carry over the old side using a map known to be wrong.
     */
    fromBaseCommit: string | null;
    /** Iteration B's base. */
    toBaseCommit: string;
}

export type FileStatus = 'unchanged' | 'modified' | 'added' | 'removed';

/** Result of mapping a range A→B: `carried` uses B's coordinates, `touched` uses A's coordinates. */
export interface MappedRange {
    readonly carried: readonly LineRange[];
    readonly touched: readonly LineRange[];
}

export interface IterationMap {
    fileStatus(path: string): FileStatus;
    /**
     * Range A → B. Pieces are sorted and do not overlap.
     * The combined lengths of `touched` and `carried` equal the input length.
     */
    mapRange(path: string, side: 'old' | 'new', range: LineRange): MappedRange;
    /** Touched lines in A within the range, for the "stops 02, 03 and 07 are affected" banner. */
    touchedInA(path: string, side: 'old' | 'new', range: LineRange): readonly LineRange[];
    /** Touched lines in B within range B, for classifying stops in the new snapshot. */
    touchedInB(path: string, side: 'old' | 'new', range: LineRange): readonly LineRange[];
}

/** Classification of a stop in the new snapshot. */
export type StopChangeKind = 'new' | 'changed';

/** Offset segment: lines in A starting at `from` shift by `delta` in B. */
interface ShiftPoint {
    readonly from: number;
    readonly delta: number;
}

/** Mapping for one text file. `null` means the entire file is touched. */
interface FileLineMap {
    /** Touched lines in A's coordinates, sorted and non-overlapping. */
    readonly touchedOld: readonly LineRange[];
    /** Touched lines in B's coordinates. */
    readonly touchedNew: readonly LineRange[];
    /** Cumulative offset after each hunk, in ascending `from` order. */
    readonly shifts: readonly ShiftPoint[];
}

/** Lines of one hunk with numbers for both sides, the only patch layout data needed. */
type Hunk = PatchLine[];

/** How a path maps: nothing to carry over, carry over unchanged, or calculate from the patch. */
type MappedPath = { kind: 'opaque' } | { kind: 'identity' } | { kind: 'mapped'; file: FileLineMap };

/** "Nothing changed" mapping: every range maps to itself. */
export function identityMap(): IterationMap {
    return {
        fileStatus: () => 'unchanged',
        mapRange: (_path, _side, range) =>
            isEmpty(range) ? { carried: [], touched: [] } : { carried: [range], touched: [] },
        touchedInA: () => [],
        touchedInB: () => [],
    };
}

/**
 * Mapping when carryover is impossible: no interdiff is or will be available (a host without `capabilities.iterations`,
 * or an iteration the host no longer knows). Every range counts as touched. It is more honest to say
 * "not carried over" than to pretend the lines are still there.
 */
export function opaqueMap(): IterationMap {
    const touched = (_path: string, _side: 'old' | 'new', range: LineRange): readonly LineRange[] =>
        isEmpty(range) ? [] : [range];
    return {
        fileStatus: () => 'modified',
        mapRange: (_path, _side, range) => (isEmpty(range) ? { carried: [], touched: [] } : { carried: [], touched: [range] }),
        touchedInA: touched,
        touchedInB: touched,
    };
}

/** Maps lines A→B using the interdiff: file statuses, carryover with an offset, touched ranges. */
export function buildIterationMap(input: IterationMapInput): IterationMap {
    const statuses = new Map<string, FileStatus>();
    const files = new Map<string, FileLineMap | null>();
    const claim = (path: string, status: FileStatus): boolean => {
        // The first file with this path wins, as in `indexDiff`.
        if (statuses.has(path)) {
            return false;
        }
        statuses.set(path, status);
        return true;
    };

    for (const file of input.interdiff?.files ?? []) {
        switch (file.changeType) {
            case 'add':
                claim(file.path, 'added');
                break;
            case 'delete':
                claim(file.path, 'removed');
                break;
            case 'move':
                // In v1, a rename means "removed and added". Lines do not carry over through it.
                if (file.oldPath !== null) {
                    claim(file.oldPath, 'removed');
                }
                claim(file.path, 'added');
                break;
            case 'copy':
                claim(file.path, 'added');
                break;
            case 'modify':
            case 'conflict':
                if (claim(file.path, 'modified')) {
                    // No text diff (binary, etc.) means the entire file is touched.
                    files.set(file.path, file.patch === null ? null : buildFileLineMap(file.patch));
                }
                break;
        }
    }

    const baseChanged = input.fromBaseCommit === null || input.fromBaseCommit !== input.toBaseCommit;
    const fileStatus = (path: string): FileStatus => statuses.get(path) ?? 'unchanged';

    const classifyPath = (path: string): MappedPath => {
        const status = fileStatus(path);
        // The file was absent in A (added) or is gone in B (removed). There is nothing to carry over.
        if (status === 'added' || status === 'removed') {
            return { kind: 'opaque' };
        }
        if (status === 'unchanged') {
            return { kind: 'identity' };
        }
        const file = files.get(path) ?? null;
        // The file changed but has no parseable patch. Both sides count as entirely touched.
        return file === null ? { kind: 'opaque' } : { kind: 'mapped', file };
    };

    const mapRange = (path: string, side: 'old' | 'new', range: LineRange): MappedRange => {
        if (isEmpty(range)) {
            return { carried: [], touched: [] };
        }
        const target = classifyPath(path);
        if (target.kind === 'opaque') {
            return { carried: [], touched: [range] };
        }
        if (side === 'old') {
            return baseChanged ? { carried: [], touched: [range] } : { carried: [range], touched: [] };
        }
        if (target.kind === 'identity') {
            return { carried: [range], touched: [] };
        }
        const { file } = target;
        return {
            carried: subtractRanges(range, file.touchedOld).flatMap((gap) => shiftGap(gap, file.shifts)),
            touched: intersectRanges(range, file.touchedOld),
        };
    };

    const touchedInB = (path: string, side: 'old' | 'new', range: LineRange): readonly LineRange[] => {
        if (isEmpty(range)) {
            return [];
        }
        const target = classifyPath(path);
        if (target.kind === 'opaque') {
            return [range];
        }
        if (side === 'old') {
            return baseChanged ? [range] : [];
        }
        if (target.kind === 'identity') {
            return [];
        }
        return intersectRanges(range, target.file.touchedNew);
    };

    return {
        fileStatus,
        mapRange,
        touchedInA: (path, side, range) => mapRange(path, side, range).touched,
        touchedInB,
    };
}

/**
 * Classifies a stop in the new snapshot (anchors in B's coordinates): `new` means the interdiff touched all
 * anchor lines (or the file was added), `changed` means some, null means none or a stop without anchors.
 */
export function classifyStop(stop: Pick<RouteStop, 'anchors'>, map: IterationMap): StopChangeKind | null {
    let total = 0;
    let touched = 0;
    for (const anchor of stop.anchors) {
        const range = { start: anchor.start, end: anchor.end };
        total += rangeLength(range);
        touched += totalLength(map.touchedInB(anchor.path, anchor.side, range));
    }
    if (total === 0 || touched === 0) {
        return null;
    }
    return touched === total ? 'new' : 'changed';
}

/**
 * Stops in the old snapshot (anchors in A's coordinates) that the interdiff touched,
 * for the "stops 02, 03 and 07 are affected" banner. Uses snapshot order.
 */
export function affectedStops(snapshot: Pick<RouteSnapshot, 'stops'>, map: IterationMap): string[] {
    return snapshot.stops
        .filter((stop) =>
            stop.anchors.some(
                (anchor) =>
                    map.touchedInA(anchor.path, anchor.side, { start: anchor.start, end: anchor.end }).length > 0,
            ),
        )
        .map((stop) => stop.id);
}

/** Carries a piece untouched by the interdiff over to B's coordinates. The offset is constant within the piece. */
function shiftGap(gap: LineRange, shifts: readonly ShiftPoint[]): LineRange[] {
    const pieces: LineRange[] = [];
    let cursor = gap.start;
    let delta = 0;
    for (const shift of shifts) {
        if (shift.from > gap.end) {
            break;
        }
        if (shift.from <= cursor) {
            delta = shift.delta;
            continue;
        }
        pieces.push({ start: cursor + delta, end: shift.from - 1 + delta });
        cursor = shift.from;
        delta = shift.delta;
    }
    pieces.push({ start: cursor + delta, end: gap.end + delta });
    return pieces;
}

/** Parses a patch into touched regions and offsets. `null` means the patch cannot be used for carryover. */
function buildFileLineMap(patch: string): FileLineMap | null {
    const touchedOld: LineRange[] = [];
    const touchedNew: LineRange[] = [];
    const shifts: ShiftPoint[] = [];
    let delta = 0;

    for (const hunk of splitHunks(patch)) {
        const first = hunk.findIndex((line) => line.changed);
        if (first < 0) {
            continue;
        }
        const last = hunk.findLastIndex((line) => line.changed);
        const old = regionSpan(hunk, first, last, 'old');
        const fresh = regionSpan(hunk, first, last, 'new');
        if (old === null || fresh === null) {
            // A hunk with no lines on the required side (a diff without context). Its insertion point
            // cannot be read from the layout in that side's coordinates, so the whole file counts as touched.
            return null;
        }

        touchedOld.push(old);
        touchedNew.push(fresh);
        delta += countSide(hunk, 'new') - countSide(hunk, 'old');
        shifts.push({ from: old.end + 1, delta });
    }

    return { touchedOld: mergeRanges(touchedOld), touchedNew: mergeRanges(touchedNew), shifts };
}

/**
 * Patch hunks. `walkPatch` supplies the boundary: the `@@` header is the only unnumbered line
 * that starts a numbered body.
 */
function splitHunks(patch: string): Hunk[] {
    const hunks: Hunk[] = [];
    let current: Hunk | null = null;
    for (const line of walkPatch(patch)) {
        if (line.old === null && line.new === null) {
            if (line.raw.startsWith('@@')) {
                current = [];
                hunks.push(current);
            }
            continue;
        }
        current?.push(line);
    }
    return hunks;
}

/**
 * A hunk's touched region on one side runs from the first changed line to the last, covering
 * that side's line numbers in the region plus the context between changes (rule 1).
 *
 * An insertion has no lines of its own on this side. Its position comes from adjacent lines (rule 2):
 * a stop anchored at 10–20 must become `changed` if code is inserted inside it. Neighbours are taken
 * separately for each insertion run, not for the region as a whole. Otherwise, the same insertion would mark
 * its neighbours only when git did not combine it with a nearby change into one hunk. An insertion next
 * to a deletion is a replacement. The deleted lines already cover its position, so the region
 * does not grow outward (otherwise every line edit would also affect the next line).
 */
function regionSpan(hunk: Hunk, first: number, last: number, side: 'old' | 'new'): LineRange | null {
    const numberAt = (index: number): number | null => {
        const line = hunk[index];
        if (line === undefined) {
            return null;
        }
        return side === 'old' ? line.old : line.new;
    };
    // A changed line with a number on this side: a deletion for `old`, an addition
    // for `new`, the second half of a replacement.
    const isCounterpart = (index: number): boolean => (hunk[index]?.changed ?? false) && numberAt(index) !== null;

    const bounds: number[] = [];
    let index = first;
    while (index <= last) {
        const number = numberAt(index);
        if (number !== null) {
            bounds.push(number);
            index += 1;
            continue;
        }
        const runStart = index;
        while (index <= last && numberAt(index) === null) {
            index += 1;
        }
        if (isCounterpart(runStart - 1) || isCounterpart(index)) {
            continue;
        }
        const before = nearestNumber(hunk, runStart - 1, -1, side);
        const after = nearestNumber(hunk, index, 1, side);
        if (before !== null) {
            bounds.push(before);
        }
        if (after !== null) {
            bounds.push(after);
        }
    }

    return bounds.length === 0 ? null : { start: Math.min(...bounds), end: Math.max(...bounds) };
}

/** Nearest line numbered on the required side, starting at index `from` in direction `step`. */
function nearestNumber(hunk: Hunk, from: number, step: -1 | 1, side: 'old' | 'new'): number | null {
    for (let index = from; index >= 0 && index < hunk.length; index += step) {
        const number = side === 'old' ? hunk[index]?.old : hunk[index]?.new;
        if (number !== null && number !== undefined) {
            return number;
        }
    }
    return null;
}

function countSide(hunk: Hunk, side: 'old' | 'new'): number {
    return hunk.filter((line) => line.changed && (side === 'old' ? line.old : line.new) !== null).length;
}

/** Merges adjacent and overlapping pieces. Input is in ascending order. */
function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
    const merged: LineRange[] = [];
    for (const range of ranges) {
        const last = merged.at(-1);
        if (last !== undefined && range.start <= last.end + 1) {
            merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
            continue;
        }
        merged.push(range);
    }
    return merged;
}

function isEmpty(range: LineRange): boolean {
    return range.end < range.start;
}

function rangeLength(range: LineRange): number {
    return range.end - range.start + 1;
}

function totalLength(ranges: readonly LineRange[]): number {
    return ranges.reduce((sum, range) => sum + rangeLength(range), 0);
}
