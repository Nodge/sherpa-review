/**
 * Line range arithmetic for anchor deduplication (`docs/design/SPEC-elements.md §4.3`:
 * two stops claiming
 * one range). Uses intervals instead of individual lines because the model supplies anchor lengths.
 */

/** Inclusive line range on one side of a file. */
export interface LineRange {
    readonly start: number;
    readonly end: number;
}

export function rangesOverlap(left: LineRange, right: LineRange): boolean {
    return left.start <= right.end && right.start <= left.end;
}

/** Intersection of a range with a set of pieces. Result pieces are sorted and do not overlap. */
export function intersectRanges(range: LineRange, others: readonly LineRange[]): LineRange[] {
    return others
        .filter((other) => rangesOverlap(range, other))
        .sort((left, right) => left.start - right.start)
        .map((other) => ({
            start: Math.max(range.start, other.start),
            end: Math.min(range.end, other.end),
        }));
}

/**
 * The remainder of a range after subtracting occupied pieces. An empty result means the whole range is occupied.
 * Two or more pieces mean subtraction split the range (they stay separate, with nothing to merge).
 */
export function subtractRanges(range: LineRange, occupied: readonly LineRange[]): LineRange[] {
    const sorted = occupied
        .filter((busy) => rangesOverlap(range, busy))
        .sort((left, right) => left.start - right.start);

    const rest: LineRange[] = [];
    let cursor = range.start;
    for (const busy of sorted) {
        if (busy.start > cursor) {
            rest.push({ start: cursor, end: Math.min(busy.start - 1, range.end) });
        }
        cursor = Math.max(cursor, busy.end + 1);
        if (cursor > range.end) {
            break;
        }
    }
    if (cursor <= range.end) {
        rest.push({ start: cursor, end: range.end });
    }
    return rest;
}
