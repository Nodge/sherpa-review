import type { DiffFileModel, DiffLine } from '../diff/model.js';

/**
 * Line range selection (SPEC §2.14): click-drag and shift-click, the same in unified and split modes.
 *
 * A line is addressed by its file line numbers, not its position in the model: context expansion
 * reindexes blocks (gaps disappear, adjacent hunks merge), so selection tied
 * to indices would highlight different lines after "Context ±20". File line numbers never change.
 *
 * Keys do not define line order (an added line has only a new number, a deleted line has
 * only an old one), so the range expands into a set of lines in the model's own order:
 * `selectedLines` finds its boundaries and returns everything between them.
 */

/** `c<old>:<new>` for context, `a<new>` for additions, `d<old>` for deletions. */
export type LineKey = string;

export interface LineSelection {
    readonly fileId: string;
    /** Starting line (may be below the focus, since dragging works in either direction). */
    readonly anchor: LineKey;
    readonly focus: LineKey;
}

const EMPTY: ReadonlySet<LineKey> = new Set();

/** `null` means the line has no numbers (malformed patch), so it cannot be selected. */
export function lineKey(line: DiffLine): LineKey | null {
    if (line.kind === 'add') {
        return line.newLine === null ? null : `a${String(line.newLine)}`;
    }
    if (line.kind === 'del') {
        return line.oldLine === null ? null : `d${String(line.oldLine)}`;
    }
    return line.oldLine === null || line.newLine === null
        ? null
        : `c${String(line.oldLine)}:${String(line.newLine)}`;
}

/** `null` means the attribute is not a line key (unrelated element under the cursor). */
export function parseLineKey(value: string | null | undefined): LineKey | null {
    return value === null || value === undefined || value === '' ? null : value;
}

/**
 * Model lines within the range: finds both boundaries in model order and selects everything
 * between them. Ignores a missing boundary, shrinking selection to
 * the other one instead of spreading over the whole file.
 */
export function selectedLines(model: DiffFileModel, selection: LineSelection | null): ReadonlySet<LineKey> {
    if (selection === null || model.content.kind !== 'text') {
        return EMPTY;
    }

    const order: LineKey[] = [];
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            const key = lineKey(line);
            if (key !== null) {
                order.push(key);
            }
        }
    }

    const anchor = order.indexOf(selection.anchor);
    const focus = order.indexOf(selection.focus);
    if (anchor < 0 && focus < 0) {
        return EMPTY;
    }

    const from = anchor < 0 ? focus : focus < 0 ? anchor : Math.min(anchor, focus);
    const to = anchor < 0 ? focus : focus < 0 ? anchor : Math.max(anchor, focus);
    return new Set(order.slice(from, to + 1));
}
