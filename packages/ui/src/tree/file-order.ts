import type { PrDiff } from '@sherpa/protocol';

/**
 * All UI views share the file tree order. Depth-first traversal, with directories before files
 * at each level and both groups alphabetical. The host order is never used.
 * The diff is sorted into this order as it enters the UI (`fetchReviewDiff`), so the tree,
 * cards, navigation keys and palette all follow the same order.
 */

const collator = new Intl.Collator();

/** Compares paths by segment. A directory precedes a file with the same name (`src/a` and `src/a/b.ts`). */
function compareSegments(left: readonly string[], right: readonly string[]): number {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const leftDir = index < left.length - 1;
        const rightDir = index < right.length - 1;
        if (leftDir !== rightDir) {
            return leftDir ? -1 : 1;
        }
        const order = collator.compare(left[index] ?? '', right[index] ?? '');
        if (order !== 0) {
            return order;
        }
    }
    return left.length - right.length;
}

/** Files in tree order. */
export function inTreeOrder<T extends { readonly path: string }>(files: readonly T[]): T[] {
    return files
        .map((file) => ({ file, segments: file.path.split('/') }))
        .sort((left, right) => compareSegments(left.segments, right.segments))
        .map(({ file }) => file);
}

/** Diff with files in tree order. */
export function withTreeOrder(diff: PrDiff): PrDiff {
    return { ...diff, files: inTreeOrder(diff.files) };
}
