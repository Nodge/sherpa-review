import type { DiffFileModel, DiffLine } from '../diff/model.js';

/**
 * Line range selection (SPEC §2.14): click-drag and shift-click, the same in unified and split modes.
 *
 * A line is addressed by its file line numbers, not its position in the model: context expansion
 * reindexes blocks (gaps disappear, adjacent hunks merge), so selection tied
 * to indexes would highlight other lines after a gap control is clicked. Line numbers stay the same.
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

interface OrderedLine {
    readonly key: LineKey;
    readonly line: DiffLine;
}

function orderedLines(model: DiffFileModel): OrderedLine[] {
    if (model.content.kind !== 'text') {
        return [];
    }

    const order: OrderedLine[] = [];
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            const key = lineKey(line);
            if (key !== null) {
                order.push({ key, line });
            }
        }
    }
    return order;
}

function selectionBounds(order: readonly OrderedLine[], selection: LineSelection): { from: number; to: number } | null {
    const anchor = order.findIndex((entry) => entry.key === selection.anchor);
    const focus = order.findIndex((entry) => entry.key === selection.focus);
    if (anchor < 0 && focus < 0) {
        return null;
    }

    return {
        from: anchor < 0 ? focus : focus < 0 ? anchor : Math.min(anchor, focus),
        to: anchor < 0 ? focus : focus < 0 ? anchor : Math.max(anchor, focus),
    };
}

/**
 * Model lines within the range: finds both boundaries in model order and selects everything
 * between them. Ignores a missing boundary, shrinking selection to
 * the other one instead of spreading over the whole file.
 */
export function selectedLines(model: DiffFileModel, selection: LineSelection | null): ReadonlySet<LineKey> {
    if (selection === null) {
        return EMPTY;
    }

    const order = orderedLines(model);
    const bounds = selectionBounds(order, selection);
    return bounds === null ? EMPTY : new Set(order.slice(bounds.from, bounds.to + 1).map((entry) => entry.key));
}

/** For a mixed d/a range, takes only existing numbers on the selected side. */
export function selectedLineRange(
    model: DiffFileModel,
    selection: LineSelection | null,
    side: 'old' | 'new',
): { line: number; size: number } | null {
    if (selection === null) {
        return null;
    }

    const order = orderedLines(model);
    const bounds = selectionBounds(order, selection);
    if (bounds === null) {
        return null;
    }

    let first: number | null = null;
    let last: number | null = null;
    for (const entry of order.slice(bounds.from, bounds.to + 1)) {
        const line = side === 'old' ? entry.line.oldLine : entry.line.newLine;
        if (line !== null) {
            first = first === null ? line : Math.min(first, line);
            last = last === null ? line : Math.max(last, line);
        }
    }
    return first === null || last === null ? null : { line: first, size: last - first + 1 };
}
