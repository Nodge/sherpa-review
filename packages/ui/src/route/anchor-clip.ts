import type { RouteAnchor } from '@sherpa/protocol';

import type { DiffBlock, DiffFileModel, DiffHunk, DiffLine } from '../diff/model.js';

/**
 * Clip the file model to stop anchors (README §1: the stop's right column shows
 * the real diff, limited to the ranges the stop covers.
 *
 * This pure function uses the original model. UI state is a set of anchors, and each calculation starts
 * from scratch. Within a hunk, `ANCHOR_CONTEXT` unchanged lines remain around each range. Every
 * A gap between slices gives accurate counts of unchanged
 * lines and changed lines explained by other stops (brief principle 3: nothing
 * is hidden silently).
 */

/** Unchanged lines around an anchor range within a hunk. */
export const ANCHOR_CONTEXT = 3;

/** A line range on one side. `RouteAnchor` satisfies it. */
export interface AnchorSpan {
    readonly side: 'old' | 'new';
    readonly start: number;
    readonly end: number;
}

export interface ClippedModel {
    /** Model containing only hunks that intersect anchors. Blocks are new objects, and the original is unchanged. */
    readonly model: DiffFileModel;
    /** Changed file lines strictly within anchors (`changedLinesOf` rule: add→new, del→old). */
    readonly changedLines: number;
    /** Hunks in the slice. Zero means anchors do not resolve in this diff (anchor drift, SPEC §2.9). */
    readonly hunks: number;
}

/** Whether a line's number on its side falls within an anchor range. */
export function lineInAnchors(line: DiffLine, anchors: readonly AnchorSpan[]): boolean {
    return anchors.some((anchor) => {
        const number = anchor.side === 'old' ? line.oldLine : line.newLine;
        return number !== null && number >= anchor.start && number <= anchor.end;
    });
}

/**
 * Changed model lines covered by anchors. Counts follow the `changedLinesOf` rule
 * (add is on `new`, del is on `old`), so the numbers match the coverage bar and seen ranges.
 */
export function coveredChangedLines(
    model: DiffFileModel | null,
    anchors: readonly AnchorSpan[],
): { readonly additions: number; readonly deletions: number } {
    if (model?.content.kind !== 'text' || anchors.length === 0) {
        return { additions: 0, deletions: 0 };
    }

    let additions = 0;
    let deletions = 0;
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            if (line.kind === 'add' && line.newLine !== null && covers(anchors, 'new', line.newLine)) {
                additions += 1;
            }
            if (line.kind === 'del' && line.oldLine !== null && covers(anchors, 'old', line.oldLine)) {
                deletions += 1;
            }
        }
    }
    return { additions, deletions };
}

function covers(anchors: readonly AnchorSpan[], side: 'old' | 'new', line: number): boolean {
    return anchors.some((anchor) => anchor.side === side && line >= anchor.start && line <= anchor.end);
}

/**
 * Changed file lines untouched by any anchor supply the synthetic
 * "Other" stop. Ranges merge adjacent line numbers, with each side kept separate.
 */
export function uncoveredRanges(
    model: DiffFileModel | null,
    anchors: readonly AnchorSpan[],
): readonly AnchorSpan[] {
    if (model?.content.kind !== 'text') {
        return [];
    }

    const uncovered: { old: number[]; new: number[] } = { old: [], new: [] };
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            if (line.kind === 'add' && line.newLine !== null && !covers(anchors, 'new', line.newLine)) {
                uncovered.new.push(line.newLine);
            }
            if (line.kind === 'del' && line.oldLine !== null && !covers(anchors, 'old', line.oldLine)) {
                uncovered.old.push(line.oldLine);
            }
        }
    }

    return [...toSpans('old', uncovered.old), ...toSpans('new', uncovered.new)];
}

function toSpans(side: 'old' | 'new', lines: readonly number[]): AnchorSpan[] {
    const sorted = [...new Set(lines)].sort((left, right) => left - right);
    const spans: AnchorSpan[] = [];
    for (const line of sorted) {
        const last = spans.at(-1);
        if (last !== undefined && line === last.end + 1) {
            spans[spans.length - 1] = { side, start: last.start, end: line };
            continue;
        }
        spans.push({ side, start: line, end: line });
    }
    return spans;
}

/** Number of lines in the ranges, counting one line per side. */
export function spanLines(spans: readonly AnchorSpan[]): number {
    return spans.reduce((total, span) => total + (span.end - span.start + 1), 0);
}

/** Stop anchors for one file. `RouteAnchor` already has the required fields. */
export function anchorSpans(anchors: readonly RouteAnchor[]): readonly AnchorSpan[] {
    return anchors.map(({ side, start, end }) => ({ side, start, end }));
}

/**
 * Model clipped by anchors. Non-text content (binary, empty patch) returns
 * unchanged because there is nothing to clip. The card shows its single-line notice.
 *
 * `context` is the number of unchanged lines to keep around a range. The card's "Expand context"
 * increases it. Expansion around a stop shows the same unchanged lines over a wider range.
 */
export function clipModelToAnchors(
    model: DiffFileModel,
    anchors: readonly AnchorSpan[],
    context = ANCHOR_CONTEXT,
): ClippedModel {
    if (model.content.kind !== 'text') {
        return { model, changedLines: 0, hunks: 0 };
    }
    if (anchors.length === 0) {
        return { model: { ...model, content: { kind: 'text', blocks: [] } }, changedLines: 0, hunks: 0 };
    }

    const blocks: DiffBlock[] = [];
    /** Content omitted between the chunk already placed and the next one. A gap forms only between them. */
    let skipped = { context: 0, changed: 0 };
    let changedLines = 0;
    let hunks = 0;

    const flush = (lines: DiffLine[], source: DiffHunk): void => {
        if (lines.length === 0) {
            return;
        }
        if (blocks.length > 0 && skipped.context + skipped.changed > 0) {
            blocks.push(gapOf(lines[0], skipped));
        }
        skipped = { context: 0, changed: 0 };
        blocks.push(hunkOf(source, lines));
        hunks += 1;
    };

    for (const block of model.content.blocks) {
        if (block.kind === 'gap') {
            // A gap in the original model contains unchanged lines between file hunks.
            skipped = { ...skipped, context: skipped.context + (block.hiddenLines ?? 0) };
            continue;
        }

        const keep = keepMask(block.lines, anchors, context);
        let run: DiffLine[] = [];
        for (const [index, line] of block.lines.entries()) {
            if (keep[index] === true) {
                run.push(line);
                if (line.kind !== 'context' && lineInAnchors(line, anchors)) {
                    changedLines += 1;
                }
                continue;
            }
            flush(run, block);
            run = [];
            skipped =
                line.kind === 'context'
                    ? { ...skipped, context: skipped.context + 1 }
                    : { ...skipped, changed: skipped.changed + 1 };
        }
        flush(run, block);
    }

    return { model: { ...model, content: { kind: 'text', blocks } }, changedLines, hunks };
}

/**
 * Hunk lines to keep: those within an anchor plus up to `context` unchanged lines
 * around it. Expansion stops at the first changed line outside the anchor. Changes from other stops
 * stay out of the slice because their own stop explains them.
 */
function keepMask(lines: readonly DiffLine[], anchors: readonly AnchorSpan[], context: number): boolean[] {
    const mask = Array.from({ length: lines.length }, () => false);
    for (const [index, line] of lines.entries()) {
        if (!lineInAnchors(line, anchors)) {
            continue;
        }
        mask[index] = true;
        for (const step of [-1, 1]) {
            for (let offset = 1; offset <= context; offset += 1) {
                const neighbour = lines[index + step * offset];
                if (neighbour?.kind !== 'context') {
                    break;
                }
                mask[index + step * offset] = true;
            }
        }
    }
    return mask;
}

function gapOf(next: DiffLine | undefined, skipped: { context: number; changed: number }): DiffBlock {
    return {
        kind: 'gap',
        edge: 'inner',
        hiddenLines: skipped.context,
        ...(skipped.changed === 0 ? {} : { hiddenChanged: skipped.changed }),
        // The gap starts where its following content does. A gap has no line numbers of its own.
        oldStart: next?.oldLine ?? 0,
        newStart: next?.newLine ?? 0,
    };
}

/** A chunk of the original hunk as a standalone hunk, with boundaries and counts from its actual lines. */
function hunkOf(source: DiffHunk, lines: readonly DiffLine[]): DiffHunk {
    const oldLines = lines.filter((line) => line.oldLine !== null);
    const newLines = lines.filter((line) => line.newLine !== null);
    return {
        ...source,
        oldStart: oldLines[0]?.oldLine ?? source.oldStart,
        oldCount: oldLines.length,
        newStart: newLines[0]?.newLine ?? source.newStart,
        newCount: newLines.length,
        lines: [...lines],
    };
}
