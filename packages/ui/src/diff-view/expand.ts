import type { FileContent } from '@sherpa/protocol';

import type { DiffBlock, DiffFileModel, DiffGap, DiffHunk, DiffLine, LanguageId } from '../diff/model.js';
import { highlightable, highlightText } from '../diff/syntax.js';

/** Context gap bar expansion step. */
export const EXPAND_STEP = 20;

export type GapKey = string;
export type ExpandDirection = 'up' | 'down' | 'all';

/** Internal key for the "Expand file" action. transform expands all allowed context. */
export const FILE_EXPANSION_KEY: GapKey = 'file:all';

export interface GapExpansion {
    readonly up: number;
    readonly down: number;
    readonly all: boolean;
}

/** Expansion for one file, with independent state for each original gap bar. */
export type FileExpansion = ReadonlyMap<GapKey, GapExpansion>;

interface Sides {
    /** New-version lines (1-based indexing through `at`). */
    readonly lines: readonly string[];
    /** Old-version lines, needed only when the new side is absent entirely. */
    readonly oldLines: readonly string[] | null;
}

function split(text: string | null): readonly string[] | null {
    if (text === null) {
        return null;
    }
    const lines = text.split('\n');
    // A file almost always ends with a newline, so the last split segment is an empty tail.
    if (lines.at(-1) === '') {
        lines.pop();
    }
    return lines;
}

/** Line count in the new file version. 0 means the new side has no content. */
export function newFileLength(content: FileContent): number {
    return split(content.newText)?.length ?? 0;
}

/** Stable gap key derived from its boundaries in the original file model. */
export function gapKeyOf(gap: DiffGap): GapKey {
    const hidden = gap.hiddenLines === null ? 'end' : String(gap.hiddenLines);
    return gap.sourceKey ?? `${gap.edge}:${String(gap.oldStart)}:${String(gap.newStart)}:${hidden}`;
}

/** New immutable state after one target action. */
export function expandGap(
    expansion: FileExpansion,
    key: GapKey,
    direction: ExpandDirection,
    amount = EXPAND_STEP,
): FileExpansion {
    const current = expansion.get(key) ?? { up: 0, down: 0, all: false };
    const next: GapExpansion =
        direction === 'all'
            ? { ...current, all: true }
            : direction === 'up'
              ? { ...current, up: current.up + amount }
              : { ...current, down: current.down + amount };
    return new Map(expansion).set(key, next);
}

/** Full expansion adds `all` to original file gaps and gaps visible after transform. */
export function expandAllGaps(
    model: DiffFileModel,
    expansion: FileExpansion,
    visibleGapKeys: readonly GapKey[] = [],
): FileExpansion {
    const next = new Map(expansion);
    const keys = new Set<GapKey>([FILE_EXPANSION_KEY, ...visibleGapKeys]);
    if (model.content.kind === 'text') {
        for (const block of model.content.blocks) {
            if (block.kind === 'gap') {
                keys.add(gapKeyOf(block));
            }
        }
    }
    for (const key of keys) {
        const current = next.get(key) ?? { up: 0, down: 0, all: false };
        next.set(key, { ...current, all: true });
    }
    return next;
}

/**
 * Number of unchanged lines hidden by a gap. The parser sets `null` for a trailing gap:
 * the exact length becomes known only after loading the file contents.
 */
export function hiddenLinesOf(gap: DiffGap, content: FileContent | null): number | null {
    if (gap.hiddenLines !== null) {
        return gap.hiddenLines;
    }
    if (content === null) {
        return null;
    }
    const total = newFileLength(content);
    return total === 0 ? null : Math.max(total - gap.newStart + 1, 0);
}

/**
 * Number of lines remaining behind this key. A gap that disappears is fully expanded. Several gaps can
 * share a key when a stop slice splits the gap with changed lines from other stops,
 * and the resulting pieces share one expansion state.
 */
export function hiddenLinesForGap(model: DiffFileModel, content: FileContent | null, key: GapKey): number | null {
    if (model.content.kind !== 'text') {
        return 0;
    }
    let total = 0;
    for (const block of model.content.blocks) {
        if (block.kind !== 'gap' || gapKeyOf(block) !== key) {
            continue;
        }
        const hidden = hiddenLinesOf(block, content);
        if (hidden === null) {
            return null;
        }
        total += hidden;
    }
    return total;
}

/** Changed lines from other stops remaining behind this key, summed across all its pieces. */
export function hiddenChangedForGap(model: DiffFileModel, key: GapKey): number {
    if (model.content.kind !== 'text') {
        return 0;
    }
    let total = 0;
    for (const block of model.content.blocks) {
        if (block.kind === 'gap' && gapKeyOf(block) === key) {
            total += block.hiddenChanged ?? 0;
        }
    }
    return total;
}

/** Exact counts for one action, measured on models before and after expansion. */
export function gapExpansionDelta(
    before: DiffFileModel,
    after: DiffFileModel,
    content: FileContent | null,
    key: GapKey,
): { readonly loaded: number; readonly hidden: number; readonly hiddenChanged: number } {
    const beforeHidden = hiddenLinesForGap(before, content, key) ?? 0;
    const afterHidden = hiddenLinesForGap(after, content, key) ?? 0;
    return {
        loaded: Math.max(0, beforeHidden - afterHidden),
        hidden: afterHidden,
        hiddenChanged: hiddenChangedForGap(after, key),
    };
}

/**
 * Model with directionally expanded context. The function always computes from the original model,
 * so the same state produces the same result for every card consumer.
 */
export function expandFileContext(
    model: DiffFileModel,
    content: FileContent | null,
    expansion: FileExpansion,
): DiffFileModel {
    if (content === null || model.content.kind !== 'text' || expansion.size === 0) {
        return model;
    }

    const sides: Sides = { lines: split(content.newText) ?? [], oldLines: split(content.oldText) };
    if (sides.lines.length === 0 && sides.oldLines === null) {
        return model;
    }

    const blocks: DiffBlock[] = [];
    const source = model.content.blocks;
    /** Lines expanded at the bottom edge of the gap. The next hunk takes them at its start. */
    let prefix: DiffLine[] = [];
    let merge = false;

    for (const [index, block] of source.entries()) {
        if (block.kind === 'hunk') {
            const grown = prefix.length === 0 ? block : growUp(block, prefix);
            const last = blocks.at(-1);
            if (merge && last?.kind === 'hunk') {
                blocks[blocks.length - 1] = join(last, grown);
            } else {
                blocks.push(grown);
            }
            prefix = [];
            merge = false;
            continue;
        }

        const hidden = hiddenLinesOf(block, content);
        if (hidden === null || hidden <= 0) {
            blocks.push(block);
            continue;
        }

        const state = expansion.get(gapKeyOf(block));
        if (state === undefined) {
            blocks.push(block);
            continue;
        }

        const hasPrevious = source[index - 1]?.kind === 'hunk';
        const hasNext = source[index + 1]?.kind === 'hunk';
        const towardPrevious = state.all
            ? hasPrevious
                ? hidden
                : 0
            : Math.min(block.edge === 'inner' ? state.up : block.edge === 'trailing' ? state.down : 0, hidden);
        const towardNext = state.all
            ? hasNext
                ? hidden
                : 0
            : Math.min(block.edge === 'inner' ? state.down : block.edge === 'leading' ? state.up : 0, hidden);

        if (towardPrevious + towardNext >= hidden) {
            const revealed = reveal(model, sides, block, 0, hidden);
            if (hasPrevious) {
                growDown(blocks, revealed);
            } else {
                prefix = revealed;
            }
            merge = hasPrevious && hasNext;
            continue;
        }

        growDown(blocks, reveal(model, sides, block, 0, towardPrevious));
        blocks.push({
            ...block,
            sourceKey: gapKeyOf(block),
            hiddenLines: block.hiddenLines === null ? null : hidden - towardPrevious - towardNext,
            oldStart: block.oldStart + towardPrevious,
            newStart: block.newStart + towardPrevious,
        });
        prefix = reveal(model, sides, block, hidden - towardNext, towardNext);
    }

    return { ...model, content: { kind: 'text', blocks } };
}

/** `count` lines of a gap starting at `offset`. */
function reveal(
    model: DiffFileModel,
    sides: Sides,
    gap: DiffGap,
    offset: number,
    count: number,
): DiffLine[] {
    const lines: DiffLine[] = [];
    const sourceGapKey = gapKeyOf(gap);
    for (let i = 0; i < count; i += 1) {
        const newLine = gap.newStart + offset + i;
        const oldLine = gap.oldStart + offset + i;
        const text = sides.lines[newLine - 1] ?? sides.oldLines?.[oldLine - 1];
        if (text === undefined) {
            break;
        }

        lines.push({ kind: 'context', oldLine, newLine, text, sourceGapKey });
    }

    highlightRevealed(lines, model.language);
    return lines;
}

/**
 * Expanded lines are highlighted together as a contiguous file fragment. Highlighting line by line
 * cannot handle its multiline constructs (see `highlightHunk` in `diff/parse.ts`).
 * The length safeguard matches the parser.
 */
function highlightRevealed(lines: readonly DiffLine[], language: LanguageId | null): void {
    if (language === null || lines.length === 0) {
        return;
    }
    const texts = lines.map((line) => line.text);
    if (!highlightable(texts)) {
        return;
    }

    const tokens = highlightText(texts.join('\n'), language);
    for (const [index, line] of lines.entries()) {
        const lineTokens = tokens[index];
        if (lineTokens !== undefined && lineTokens.length > 0) {
            line.tokens = lineTokens;
        }
    }
}

/** Append expanded lines to an existing hunk. */
function growDown(blocks: DiffBlock[], lines: DiffLine[]): void {
    const last = blocks.at(-1);
    if (last?.kind !== 'hunk' || lines.length === 0) {
        return;
    }
    blocks[blocks.length - 1] = {
        ...last,
        lines: [...last.lines, ...lines],
        oldCount: last.oldCount + lines.length,
        newCount: last.newCount + lines.length,
    };
}

/** Two hunks become one when the gap bar between them disappears. */
function join(first: DiffHunk, second: DiffHunk): DiffHunk {
    return {
        ...first,
        lines: [...first.lines, ...second.lines],
        oldCount: first.oldCount + second.oldCount,
        newCount: first.newCount + second.newCount,
        whitespaceOnly: first.whitespaceOnly && second.whitespaceOnly,
    };
}

function growUp(hunk: DiffHunk, lines: DiffLine[]): DiffHunk {
    const first = lines[0];
    return {
        ...hunk,
        lines: [...lines, ...hunk.lines],
        oldStart: first?.oldLine ?? hunk.oldStart,
        newStart: first?.newLine ?? hunk.newStart,
        oldCount: hunk.oldCount + lines.length,
        newCount: hunk.newCount + lines.length,
    };
}

/** Zero means nothing remains to expand. `null` means the tail length is still unknown. */
export function remainingHiddenLines(model: DiffFileModel, content: FileContent | null): number | null {
    if (model.content.kind !== 'text') {
        return 0;
    }

    let total = 0;
    for (const block of model.content.blocks) {
        if (block.kind !== 'gap') {
            continue;
        }
        const hidden = hiddenLinesOf(block, content);
        if (hidden === null) {
            return null;
        }
        total += hidden;
    }
    return total;
}

/**
 * Number of changed lines from other stops hidden by gaps. A slice card cannot expand them
 * because other stops explain them. Always 0 in Full diff because only clipping sets `hiddenChanged`.
 */
export function remainingHiddenChanged(model: DiffFileModel): number {
    if (model.content.kind !== 'text') {
        return 0;
    }

    let total = 0;
    for (const block of model.content.blocks) {
        if (block.kind === 'gap') {
            total += block.hiddenChanged ?? 0;
        }
    }
    return total;
}
