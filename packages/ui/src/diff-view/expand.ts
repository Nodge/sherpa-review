import type { FileContent } from '@sherpa/protocol';

import type { DiffBlock, DiffFileModel, DiffGap, DiffHunk, DiffLine } from '../diff/model.js';
import { tokenizeLine } from '../diff/syntax.js';

/**
 * "Expand context" (SPEC §2.13): each click adds 20 unchanged lines above and below
 * every hunk in the file. "Expand all" reveals the gaps in full.
 *
 * This pure function calculates from the original model, rather than the previous result. UI state is
 * one number (or `all`), and each calculation starts from scratch. Lines come from file content (`FileContent`),
 * and numbering comes from hunk boundaries. An unchanged line has the same text in both versions,
 * only its number differs, so text comes from the new side and the old number comes from an offset.
 */

/** Expansion step from SPEC §2.13. */
export const EXPAND_STEP = 20;

export type ExpandAmount = number | 'all';

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
    // A file almost always ends with a newline. The last split segment is an empty tail,
    // not a file line. Counting it would add one to the length and draw an empty line past the end.
    if (lines.at(-1) === '') {
        lines.pop();
    }
    return lines;
}

/** Line count in the new file version. 0 means the new side has no content. */
export function newFileLength(content: FileContent): number {
    return split(content.newText)?.length ?? 0;
}

/**
 * How many unchanged lines a gap hides. For the trailing gap, the parser sets `null`
 * (the patch cannot give the file length). Here, the content finally provides it.
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
 * Model with expanded context. If `content` lacks the required side or the model is empty, returns
 * the original model unchanged. Lines must not be invented.
 */
export function expandFileContext(
    model: DiffFileModel,
    content: FileContent | null,
    amount: ExpandAmount,
): DiffFileModel {
    if (content === null || model.content.kind !== 'text' || amount === 0) {
        return model;
    }

    const sides: Sides = { lines: split(content.newText) ?? [], oldLines: split(content.oldText) };
    if (sides.lines.length === 0 && sides.oldLines === null) {
        return model;
    }

    const blocks: DiffBlock[] = [];
    const source = model.content.blocks;
    /** Lines revealed above a hunk that has not been emitted yet. The hunk will absorb them. */
    let prefix: DiffLine[] = [];
    /** The gap before this hunk expanded in full, so the hunk merges with the previous one. */
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
            // The tail length is unknown even with content, so the gap stays unchanged.
            blocks.push(block);
            continue;
        }

        const hasPrevious = source[index - 1]?.kind === 'hunk';
        const hasNext = source[index + 1]?.kind === 'hunk';
        const below = hasPrevious ? step(amount, hidden) : 0;
        const above = hasNext ? step(amount, hidden) : 0;

        if (below + above >= hidden) {
            // The gap closed: adjacent hunks are consecutive and the gap no longer exists.
            const revealed = reveal(model, sides, block, 0, hidden);
            if (hasPrevious) {
                growDown(blocks, revealed);
            } else {
                prefix = revealed;
            }
            merge = hasPrevious && hasNext;
            continue;
        }

        growDown(blocks, reveal(model, sides, block, 0, below));
        blocks.push({
            ...block,
            // The patch still cannot tell us the trailing gap's length. Its line count comes
            // from `hiddenLinesOf` using the content and the already shifted start.
            hiddenLines: block.hiddenLines === null ? null : hidden - below - above,
            oldStart: block.oldStart + below,
            newStart: block.newStart + below,
        });
        prefix = reveal(model, sides, block, hidden - above, above);
    }

    return { ...model, content: { kind: 'text', blocks } };
}

function step(amount: ExpandAmount, hidden: number): number {
    return amount === 'all' ? hidden : Math.min(amount, hidden);
}

/**
 * `count` lines from a gap, starting at `offset` within it, as context lines
 * with line numbers for both sides.
 */
function reveal(
    model: DiffFileModel,
    sides: Sides,
    gap: DiffGap,
    offset: number,
    count: number,
): DiffLine[] {
    const lines: DiffLine[] = [];
    for (let i = 0; i < count; i += 1) {
        const newLine = gap.newStart + offset + i;
        const oldLine = gap.oldStart + offset + i;
        const text = sides.lines[newLine - 1] ?? sides.oldLines?.[oldLine - 1];
        if (text === undefined) {
            // The content is shorter than the gap promised. Add nothing further, without an error.
            break;
        }

        const line: DiffLine = { kind: 'context', oldLine, newLine, text };
        if (model.language !== null) {
            const tokens = tokenizeLine(text, model.language);
            if (tokens.length > 0) {
                line.tokens = tokens;
            }
        }
        lines.push(line);
    }
    return lines;
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

/**
 * Merges two hunks with no hidden lines between them. A hunk is a continuous block,
 * so closing the gap must merge the neighbours. The entity header comes from the first hunk.
 */
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

/**
 * What remains hidden: zero means nothing more to expand, so the button is disabled.
 * `null` means the tail length is unknown, so there is still something to expand.
 */
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
