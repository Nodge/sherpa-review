import type { TreeRow } from './file-tree.js';

/**
 * Tree keyboard controls (docs/design/SPEC-elements.md §2.20): ↑/↓ navigate, →/← expand and collapse, ⏎ opens a file.
 * Pure reducer: takes a key and a flat list of visible rows, returns an intent.
 * This lets tests check behaviour without the DOM. The component only executes the command.
 */

export type TreeCommand =
    | { readonly kind: 'focus'; readonly index: number }
    | { readonly kind: 'setCollapsed'; readonly path: string; readonly collapsed: boolean }
    | { readonly kind: 'open'; readonly fileId: string };

/** `null` means the key does not belong to the tree, so the event passes on. */
export function treeKeyCommand(key: string, rows: readonly TreeRow[], index: number): TreeCommand | null {
    if (rows.length === 0) {
        return null;
    }
    const current = rows[index];

    switch (key) {
        case 'ArrowDown':
            return { kind: 'focus', index: Math.min(index + 1, rows.length - 1) };
        case 'ArrowUp':
            // From "nothing selected" (-1), ↑ moves to the first row, not a negative index.
            return { kind: 'focus', index: index <= 0 ? 0 : index - 1 };
        case 'ArrowRight':
            if (current === undefined) {
                return { kind: 'focus', index: 0 };
            }
            if (current.kind !== 'dir') {
                return null;
            }
            return current.collapsed
                ? { kind: 'setCollapsed', path: current.path, collapsed: false }
                : { kind: 'focus', index: Math.min(index + 1, rows.length - 1) };
        case 'ArrowLeft': {
            if (current === undefined) {
                return { kind: 'focus', index: 0 };
            }
            if (current.kind === 'dir' && !current.collapsed) {
                return { kind: 'setCollapsed', path: current.path, collapsed: true };
            }
            const parent = parentIndex(rows, index);
            return parent === null ? null : { kind: 'focus', index: parent };
        }
        case 'Enter':
            if (current === undefined) {
                return null;
            }
            return current.kind === 'file'
                ? { kind: 'open', fileId: current.fileId }
                : { kind: 'setCollapsed', path: current.path, collapsed: !current.collapsed };
        default:
            return null;
    }
}

/** Nearest row above with a smaller depth. null means the row is already at the top level. */
function parentIndex(rows: readonly TreeRow[], index: number): number | null {
    const depth = rows[index]?.depth;
    if (depth === undefined || depth === 0) {
        return null;
    }
    for (let i = index - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (row !== undefined && row.depth < depth) {
            return i;
        }
    }
    return null;
}
