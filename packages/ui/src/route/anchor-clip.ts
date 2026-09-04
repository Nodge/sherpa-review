import type { RouteAnchor } from '@sherpa/protocol';

import type { DiffBlock, DiffFileModel, DiffGap, DiffHunk, DiffLine } from '../diff/model.js';
import type { FileExpansion } from '../diff-view/expand.js';
import { FILE_EXPANSION_KEY, gapKeyOf } from '../diff-view/expand.js';

/**
 * Clip the file model to stop anchors (README §1: the stop's right column shows
 * the real diff, limited to the ranges the stop covers.
 *
 * This pure function uses the original model. UI state is a set of anchors, and each calculation starts
 * from scratch. Within a hunk, `ANCHOR_CONTEXT` unchanged lines remain around each range. Every
 * omission becomes a gap with accurate counts of unchanged lines and
 * changed lines explained by other stops (brief principle 3: nothing is hidden silently).
 * File edges are gaps too. Without them, the slice would silently drop the file start and end, and the card
 * would assume there was nothing to expand.
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
 *
 * Empty and whitespace-only lines are excluded (decision log, 2026-08-26): there is nothing
 * to read. "Other" and the full diff hatch regularly filled with these separators
 * between blocks assigned to different stops. The rule applies only outside anchors.
 * A covered whitespace line still counts towards its tier.
 */
export function uncoveredRanges(
    model: DiffFileModel | null,
    anchors: readonly AnchorSpan[],
): readonly AnchorSpan[] {
    return changedRanges(model, (line, side, number) => !covers(anchors, side, number) && hasText(line));
}

/**
 * Changed lines excluded from coverage statistics by the whitespace rule have no text and
 * no anchor. The percentage denominator subtracts them, or covered plus uncovered would not match
 * the changed line count.
 */
export function droppedWhitespaceLines(model: DiffFileModel | null, anchors: readonly AnchorSpan[]): number {
    return spanLines(changedRanges(model, (line, side, number) => !covers(anchors, side, number) && !hasText(line)));
}

/**
 * The same uncovered ranges, including all whitespace lines, supply the "viewed" mark.
 * Reading progress counts all changed patch lines, so marking "Other" must
 * cover them all. The whitespace rule removes lines from coverage statistics, not from
 * viewed (requirements §3.1).
 */
export function uncoveredReadRanges(
    model: DiffFileModel | null,
    anchors: readonly AnchorSpan[],
): readonly AnchorSpan[] {
    return changedRanges(model, (line, side, number) => !covers(anchors, side, number));
}

/** Whether a line contains text. Empty and whitespace-only lines do not. */
function hasText(line: DiffLine): boolean {
    return line.text.trim() !== '';
}

/**
 * Changed file lines covered by anchors, as ranges. These are the same lines counted by
 * `coveredChangedLines`, so seen ranges for a stop mark match its counters
 * and the coverage bar.
 */
export function coveredChangedRanges(
    model: DiffFileModel | null,
    anchors: readonly AnchorSpan[],
): readonly AnchorSpan[] {
    if (anchors.length === 0) {
        return [];
    }
    return changedRanges(model, (line, side, number) => covers(anchors, side, number));
}

/** Selected changed lines, merged by adjacent line numbers within each side. */
function changedRanges(
    model: DiffFileModel | null,
    keep: (line: DiffLine, side: 'old' | 'new', number: number) => boolean,
): readonly AnchorSpan[] {
    if (model?.content.kind !== 'text') {
        return [];
    }

    const kept: { old: number[]; new: number[] } = { old: [], new: [] };
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            if (line.kind === 'add' && line.newLine !== null && keep(line, 'new', line.newLine)) {
                kept.new.push(line.newLine);
            }
            if (line.kind === 'del' && line.oldLine !== null && keep(line, 'old', line.oldLine)) {
                kept.old.push(line.oldLine);
            }
        }
    }

    return [...toSpans('old', kept.old), ...toSpans('new', kept.new)];
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
    expansion: FileExpansion = new Map(),
): ClippedModel {
    if (model.content.kind !== 'text') {
        return { model, changedLines: 0, hunks: 0 };
    }
    if (anchors.length === 0) {
        return { model: { ...model, content: { kind: 'text', blocks: [] } }, changedLines: 0, hunks: 0 };
    }

    const blocks: DiffBlock[] = [];
    /** Content omitted between the chunk already placed and the next one. A gap forms only between them. */
    let skipped: SkippedLines = { context: 0, changed: 0 };
    let changedLines = 0;
    let hunks = 0;

    const flush = (lines: DiffLine[], source: DiffHunk): void => {
        if (lines.length === 0) {
            return;
        }
        if (anythingSkipped(skipped)) {
            blocks.push(gapOf(blocks.length === 0 ? 'leading' : 'inner', startOfGap(lines[0]), skipped));
        }
        skipped = { context: 0, changed: 0 };
        blocks.push(hunkOf(source, lines));
        hunks += 1;
    };

    for (const block of model.content.blocks) {
        if (block.kind === 'gap') {
            // A gap in the original model keeps its key and expands before anchor clipping.
            skipped = {
                ...skipped,
                context: skipped.context + (block.hiddenLines ?? 0),
                ...(block.hiddenLines === null ? { toEndOfFile: true } : {}),
                key: skipped.key ?? gapKeyOf(block),
            };
            continue;
        }

        const keep = keepPlan(block.lines, anchors, context, expansion);
        let run: DiffLine[] = [];
        for (const [index, line] of block.lines.entries()) {
            if (keep.mask[index] === true) {
                run.push(line);
                if (line.kind !== 'context' && lineInAnchors(line, anchors)) {
                    changedLines += 1;
                }
                continue;
            }
            flush(run, block);
            run = [];
            // The gap counts everything the slice hid, including changed whitespace lines.
            // the whitespace rule (decision log, 2026-08-26) excludes them from coverage counts,
            // not from what the card must report.
            const key = skipped.key ?? keep.gapKeys[index];
            skipped =
                line.kind === 'context'
                    ? { ...skipped, context: skipped.context + 1, ...(key === undefined ? {} : { key }) }
                    : { ...skipped, changed: skipped.changed + 1, ...(key === undefined ? {} : { key }) };
        }
        flush(run, block);
    }

    const tail = blocks.at(-1);
    if (tail?.kind === 'hunk' && anythingSkipped(skipped)) {
        blocks.push(gapOf('trailing', startAfterHunk(tail), skipped));
    }

    return { model: { ...model, content: { kind: 'text', blocks } }, changedLines, hunks };
}

/** Whether a gap has hidden lines or an unknown tail from the original gap to report. */
function anythingSkipped(skipped: SkippedLines): boolean {
    return skipped.context + skipped.changed > 0 || skipped.toEndOfFile === true;
}

interface KeepPlan {
    readonly mask: boolean[];
    readonly gapKeys: (string | undefined)[];
}

interface SkippedLines {
    readonly context: number;
    readonly changed: number;
    /** The gap reaches the file end. Content supplies its length, as in the original model. */
    readonly toEndOfFile?: true;
    readonly key?: string;
}

/** Line number in each version. */
interface Sides {
    readonly old: number;
    readonly new: number;
}

/**
 * Hunk lines to keep: anchors, base context and directed expansion of specific
 * gaps. A changed line from another stop always stops expansion.
 */
function keepPlan(
    lines: readonly DiffLine[],
    anchors: readonly AnchorSpan[],
    context: number,
    expansion: FileExpansion,
): KeepPlan {
    const mask = Array.from({ length: lines.length }, () => false);
    const gapKeys: (string | undefined)[] = Array.from({ length: lines.length }, () => undefined);
    const revealAllContext = expansion.get(FILE_EXPANSION_KEY)?.all === true;
    for (const [index, line] of lines.entries()) {
        // Expansion happened before transform. The slice must not hide these lines again.
        if (line.sourceGapKey !== undefined || (revealAllContext && line.kind === 'context')) {
            mask[index] = true;
        }
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

    let index = 0;
    while (index < lines.length) {
        if (mask[index] === true) {
            index += 1;
            continue;
        }
        const start = index;
        while (index < lines.length && mask[index] !== true) {
            index += 1;
        }
        const end = index - 1;
        // A fully hidden chunk has no neighbours, so its expansion has nowhere to grow.
        if (start === 0 && end === lines.length - 1) {
            continue;
        }

        const beforeSource = lines[start - 1]?.sourceGapKey;
        const afterSource = lines[end + 1]?.sourceGapKey;
        const sourceKey =
            beforeSource === undefined || afterSource === undefined || beforeSource === afterSource
                ? (beforeSource ?? afterSource)
                : undefined;
        const key = sourceKey ?? `clip:${lineBoundary(lines[start - 1])}>${lineBoundary(lines[end + 1])}`;
        for (let cursor = start; cursor <= end; cursor += 1) {
            gapKeys[cursor] = key;
        }
        const state = expansion.get(key);
        if (state === undefined) {
            continue;
        }
        const up = state.all ? Number.MAX_SAFE_INTEGER : state.up;
        const down = state.all ? Number.MAX_SAFE_INTEGER : state.down;
        // At a hunk edge there is one neighbour and one gap target. Expand towards it,
        // whichever of the two controls was clicked.
        const above = start > 0;
        const below = end < lines.length - 1;
        revealContext(mask, lines, start, 1, above ? (below ? up : Math.max(up, down)) : 0);
        revealContext(mask, lines, end, -1, below ? (above ? down : Math.max(up, down)) : 0);
    }

    return { mask, gapKeys };
}

function revealContext(
    mask: boolean[],
    lines: readonly DiffLine[],
    start: number,
    step: 1 | -1,
    amount: number,
): void {
    for (let offset = 0; offset < amount; offset += 1) {
        const index = start + step * offset;
        if (lines[index]?.kind !== 'context') {
            break;
        }
        mask[index] = true;
    }
}

function lineBoundary(line: DiffLine | undefined): string {
    return line === undefined ? 'none' : `${line.kind}:${String(line.oldLine ?? 0)}:${String(line.newLine ?? 0)}`;
}

function gapOf(edge: DiffGap['edge'], start: Sides, skipped: SkippedLines): DiffGap {
    return {
        kind: 'gap',
        edge,
        hiddenLines: skipped.toEndOfFile === true ? null : skipped.context,
        ...(skipped.changed === 0 ? {} : { hiddenChanged: skipped.changed }),
        ...(skipped.key === undefined ? {} : { sourceKey: skipped.key }),
        oldStart: start.old,
        newStart: start.new,
    };
}

/** A gap starts at what follows it because it has no line numbers of its own. */
function startOfGap(next: DiffLine | undefined): Sides {
    return { old: next?.oldLine ?? 0, new: next?.newLine ?? 0 };
}

/** A trailing gap has no next line. It starts at the end of the last hunk. */
function startAfterHunk(previous: DiffHunk): Sides {
    return { old: previous.oldStart + previous.oldCount, new: previous.newStart + previous.newCount };
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
