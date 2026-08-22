import type { FileDiff, UiFileProgress, UiSeenRange } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';

/**
 * File reading progress (SPEC §2.12, requirements §3.1): three read-state values and tooltip counts.
 * Pure module: takes a progress record, a diff file, and (when available) changed model lines,
 * and returns state and a tooltip, without React or network calls.
 *
 * Marks are manual only, with no viewport tracking (requirements §3.1 decision). Seen ranges arrive
 * with M2 stops. They are always empty in M1, so `partial` is reachable only in unit tests and the gallery.
 */

export type ReadState = 'unread' | 'partial' | 'read';

/** Changed file lines by side: added lines live in `new`, removed lines in `old`. */
export interface ChangedLines {
    readonly old: ReadonlySet<number>;
    readonly new: ReadonlySet<number>;
}

/** Fields needed from the diff file. Other fields do not affect read-state. */
export type ReadStateFile = Pick<FileDiff, 'generated' | 'viewed' | 'additions' | 'deletions'>;

export interface ReadStateInput {
    readonly file: ReadStateFile;
    /** Explicit progress record. null means no record, so defaults apply. */
    readonly record: UiFileProgress | null;
    /**
     * Changed lines from the parsed model allow exact range counts. Without them, coverage
     * is estimated from range lengths, an upper bound capped at the changed-line count.
     */
    readonly changed?: ChangedLines;
}

export interface FileReadState {
    readonly state: ReadState;
    /** Changed lines seen, used in the tooltip. Must match the visual state (SPEC §2.12). */
    readonly seen: number;
    readonly total: number;
    /** `read` is pinned (manual mark, host mark, generated default) rather than based on coverage. */
    readonly pinned: boolean;
    /** Marked by default because the file is generated. The mark can be cleared (requirements §3.7). */
    readonly generatedDefault: boolean;
    readonly tooltip: string;
}

const GENERATED_NOTE = 'generated — marked read by default';

/**
 * Merge sources. An explicit record takes precedence: `true` pins `read` permanently, `false` removes
 * the pin (including the generated default), then state comes from ranges. Without a record, `read` comes from
 * a host mark, then a generated file. Otherwise state comes from coverage.
 */
export function readStateOf(input: ReadStateInput): FileReadState {
    const { file, record } = input;
    const total = file.additions + file.deletions;

    if (record !== null) {
        return record.viewed ? pinned(total, false) : fromCoverage(record.seenRanges, input.changed, total, false);
    }
    if (file.viewed === true) {
        return pinned(total, false);
    }
    if (file.generated) {
        return pinned(total, true);
    }
    return fromCoverage([], input.changed, total, false);
}

/** Changed model lines: the `changed` input for exact coverage counts. */
export function changedLinesOf(model: DiffFileModel | null): ChangedLines | undefined {
    if (model?.content.kind !== 'text') {
        return undefined;
    }

    const oldLines = new Set<number>();
    const newLines = new Set<number>();
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            if (line.kind === 'del' && line.oldLine !== null) {
                oldLines.add(line.oldLine);
            }
            if (line.kind === 'add' && line.newLine !== null) {
                newLines.add(line.newLine);
            }
        }
    }
    return { old: oldLines, new: newLines };
}

/** A mark keeps the whole file `read`: the tooltip count must match the filled box. */
function pinned(total: number, generatedDefault: boolean): FileReadState {
    return {
        state: 'read',
        seen: total,
        total,
        pinned: true,
        generatedDefault,
        tooltip: tooltipOf(total, total, generatedDefault),
    };
}

function fromCoverage(
    ranges: readonly UiSeenRange[],
    changed: ChangedLines | undefined,
    total: number,
    generatedDefault: boolean,
): FileReadState {
    const seen = Math.min(countSeen(ranges, changed), total);
    const state: ReadState = seen === 0 ? 'unread' : seen >= total ? 'read' : 'partial';
    return {
        state,
        seen,
        total,
        pinned: false,
        generatedDefault,
        tooltip: tooltipOf(seen, total, generatedDefault),
    };
}

function tooltipOf(seen: number, total: number, generatedDefault: boolean): string {
    const numbers =
        total === 0
            ? 'no changed lines in this file'
            : `${String(seen)} of ${String(total)} changed lines seen`;
    return generatedDefault ? `${GENERATED_NOTE} · ${numbers}` : numbers;
}

/**
 * How many changed lines ranges cover. If model lines are known, count their intersection
 * with the ranges. Otherwise, use range lengths (after merging overlaps), and the caller
 * caps the result at the changed-line count.
 */
function countSeen(ranges: readonly UiSeenRange[], changed: ChangedLines | undefined): number {
    if (ranges.length === 0) {
        return 0;
    }

    const merged = { old: mergeSide(ranges, 'old'), new: mergeSide(ranges, 'new') };
    if (changed === undefined) {
        return length(merged.old) + length(merged.new);
    }
    return countCovered(changed.old, merged.old) + countCovered(changed.new, merged.new);
}

type Span = readonly [start: number, end: number];

function mergeSide(ranges: readonly UiSeenRange[], side: UiSeenRange['side']): Span[] {
    const spans = ranges
        .filter((range) => range.side === side)
        .map((range): Span => [range.start, range.end])
        .sort((a, b) => a[0] - b[0]);

    const merged: Span[] = [];
    for (const span of spans) {
        const last = merged.at(-1);
        if (last === undefined || span[0] > last[1] + 1) {
            merged.push(span);
            continue;
        }
        merged[merged.length - 1] = [last[0], Math.max(last[1], span[1])];
    }
    return merged;
}

function length(spans: readonly Span[]): number {
    return spans.reduce((total, [start, end]) => total + (end - start + 1), 0);
}

function countCovered(lines: ReadonlySet<number>, spans: readonly Span[]): number {
    let covered = 0;
    for (const line of lines) {
        if (spans.some(([start, end]) => line >= start && line <= end)) {
            covered += 1;
        }
    }
    return covered;
}
