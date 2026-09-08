import type { DiffFileModel, DiffGap, DiffHunk } from '../diff/model.js';
import type { ExpandDirection, GapKey } from './expand.js';
import { gapKeyOf } from './expand.js';

/**
 * The `e` key (docs/design/SPEC-elements.md §5) expands the focused hunk's context one step up and down.
 * Gaps around the hunk use the same keys and directions as the targets in the markup
 * (`expandFileContext`). For an internal gap, "down" expands the hunk below it and "up" the one above.
 */
export interface HunkExpandRequest {
    readonly gapKey: GapKey;
    readonly direction: ExpandDirection;
}

/**
 * What to expand to give the focused hunk one more step of context above and below.
 * An empty list means nothing to expand: no hunk, no surrounding gaps, or empty gaps.
 */
export function hunkContextRequests(
    model: DiffFileModel,
    side: 'old' | 'new',
    line: number,
): readonly HunkExpandRequest[] {
    if (model.content.kind !== 'text') {
        return [];
    }
    const blocks = model.content.blocks;
    const position = blocks.findIndex((block) => block.kind === 'hunk' && hunkHasLine(block, side, line));
    if (position < 0) {
        return [];
    }

    const requests: HunkExpandRequest[] = [];
    const above = blocks[position - 1];
    if (above?.kind === 'gap' && hasHidden(above)) {
        // Gap above the hunk: "down" for an internal gap and "up" for a leading gap expand its top.
        requests.push({ gapKey: gapKeyOf(above), direction: above.edge === 'leading' ? 'up' : 'down' });
    }
    const below = blocks[position + 1];
    if (below?.kind === 'gap' && hasHidden(below)) {
        requests.push({ gapKey: gapKeyOf(below), direction: below.edge === 'trailing' ? 'down' : 'up' });
    }
    return requests;
}

function hasHidden(gap: DiffGap): boolean {
    // `null` means a trailing gap of unknown length. There is definitely context to expand there.
    return gap.hiddenLines === null || gap.hiddenLines > 0;
}

function hunkHasLine(hunk: DiffHunk, side: 'old' | 'new', line: number): boolean {
    return hunk.lines.some((value) => (side === 'old' ? value.oldLine : value.newLine) === line);
}
