/**
 * Target selection for navigation keys (docs/design/SPEC-elements.md §5: `j`/`k`, `n`/`p`). Both views compute the target
 * the same way, using their own entry list and "viewed" flag, so selection itself
 * lives here, separate from scrolling and React.
 */

/**
 * List neighbour without wrapping. At the end of the list, `null` makes the view do nothing. When there is no current
 * entry (no scrolling yet, or the entry was filtered out), the first entry becomes the target.
 */
export function neighbourId<T>(
    items: readonly T[],
    currentId: string | null,
    direction: 1 | -1,
    idOf: (item: T) => string,
): string | null {
    if (items.length === 0) {
        return null;
    }
    const index = currentId === null ? -1 : items.findIndex((item) => idOf(item) === currentId);
    if (index < 0) {
        const first = items[0];
        return first === undefined ? null : idOf(first);
    }
    const next = items[index + direction];
    return next === undefined ? null : idOf(next);
}

/**
 * Nearest unviewed entry in the given direction, wrapping the search from the end of the list
 * to the start (docs/design/SPEC-elements.md §5, `n`/`p`). `null` means there are no unviewed entries at all.
 */
export function unreadNeighbourId<T>(
    items: readonly T[],
    currentId: string | null,
    direction: 1 | -1,
    idOf: (item: T) => string,
    unread: (item: T) => boolean,
): string | null {
    const count = items.length;
    if (count === 0) {
        return null;
    }
    const found = currentId === null ? -1 : items.findIndex((item) => idOf(item) === currentId);
    // No current entry. Search from an edge, forward from the start or backward from the end.
    const start = found < 0 ? (direction === 1 ? -1 : count) : found;
    for (let step = 1; step <= count; step += 1) {
        const index = (((start + direction * step) % count) + count) % count;
        const item = items[index];
        if (item !== undefined && unread(item)) {
            return idOf(item);
        }
    }
    return null;
}
