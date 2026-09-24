import type { DiffFileModel } from '../diff/model.js';

/**
 * Digit count of the longest line number among visible model lines. The card uses it to set
 * line number column widths (`--gutter-digits`, `diff-view.css`). Both sides count, since
 * split mode uses the same width for both halves. No lines means one digit.
 */
export function gutterDigits(model: DiffFileModel | null): number {
    let max = 0;
    if (model?.content.kind === 'text') {
        for (const block of model.content.blocks) {
            if (block.kind !== 'hunk') {
                continue;
            }
            for (const line of block.lines) {
                max = Math.max(max, line.oldLine ?? 0, line.newLine ?? 0);
            }
        }
    }
    return String(max).length;
}
