import type { FileDiff } from '@sherpa/protocol';

import { fuzzyMatch } from '../palette/fuzzy.js';
import type { FileReadState, ReadState } from '../progress/read-state.js';
import { readStateOf } from '../progress/read-state.js';
import type { RouteMarginFile } from '../route/margin-model.js';
import { inTreeOrder } from './file-order.js';

/**
 * Full diff left-panel file tree (docs/design/SPEC-elements.md §2.20,
 * docs/design/README.md §10). Pure module. Building, aggregation, collapse and search run
 * without React or the DOM. Rendering only draws the prepared rows.
 *
 * Chains of directories containing a single directory combine into one row (`services/orders`,
 * `api/v3`), so a tree of two dozen files fits the panel instead of taking one row
 * per path segment. A directory with a single file does not combine with its file.
 * File rows show only the name (docs/design/SPEC-theming-2026-09-12.md §6a).
 */

/** Directories with more than this many children collapse by default (docs/design/SPEC-elements.md §2.20). */
export const BULK_DIRECTORY_CHILDREN = 20;

/** Top-level indentation: the left 26px hold the stop marker (docs/design/SPEC-theming-2026-09-12.md §6a). */
export const TREE_INDENT_BASE = 26;
export const TREE_INDENT_STEP = 10;

/**
 * Rows at the same level start in the same column: directory chevron and file checkbox.
 * A combined chain is one level.
 */
export function rowIndent(row: Pick<TreeRow, 'depth'>, indentStep = TREE_INDENT_STEP): number {
    return TREE_INDENT_BASE + row.depth * indentStep;
}

export interface TreeFileRow {
    readonly kind: 'file';
    /** File path, also the row key. */
    readonly path: string;
    /** Filename. Directories have their own rows (docs/design/SPEC-theming-2026-09-12.md §6a). */
    readonly label: string;
    readonly depth: number;
    readonly fileId: string;
    readonly additions: number;
    readonly deletions: number;
    readonly generated: boolean;
    /** Host links for the file menu (docs/design/SPEC-elements.md §2.11). null means the host has none. */
    readonly hostFileUrl: string | null;
    readonly blameUrl: string | null;
    /** Unmerged file: `conflict` tag on the row and exclusion from coverage (docs/design/SPEC-elements.md §4.1). */
    readonly conflict: boolean;
    /** The file is in the extra `pci` lens, shown as a tag in its row (docs/design/README.md §10). */
    readonly pci: boolean;
    /** File reading progress (docs/design/SPEC-elements.md §2.12): three states and counts for the tooltip. */
    readonly read: FileReadState;
    /** Route in the margins (docs/design/README.md §10): stop badge or hatch. null means no route. */
    readonly route: RouteMarginFile | null;
}

export interface TreeDirRow {
    readonly kind: 'dir';
    readonly path: string;
    readonly label: string;
    readonly depth: number;
    readonly additions: number;
    readonly deletions: number;
    readonly files: number;
    /** Fully read files in the subtree. `partial` does not count. */
    readonly readFiles: number;
    /** The whole subtree is generated, so dim it like files (docs/design/README.md §10). */
    readonly generated: boolean;
    /**
     * Root directory without any of my files (docs/design/README.md §10, "foreign roots").
     * Always `false` without an ownership lens. There is no basis for dimming.
     */
    readonly foreign: boolean;
    readonly collapsed: boolean;
}

export type TreeRow = TreeFileRow | TreeDirRow;

export interface FileTree {
    /** Visible rows in traversal order. Contents of collapsed directories are excluded. */
    readonly rows: readonly TreeRow[];
    /** All tree directories, including those hidden by collapsed ancestors, are ⌥-click targets. */
    readonly directories: ReadonlySet<string>;
    /** Directories collapsed by default due to size. The reviewer's explicit choice takes priority. */
    readonly bulkDirectories: ReadonlySet<string>;
}

export interface FileTreeInput {
    readonly files: readonly FileDiff[];
    /** Files in the `pci` lens. An empty set means no tags. */
    readonly pciFileIds: ReadonlySet<string>;
    /** Ownership-lens files. null means no lens, so roots outside the ownership zone are not computed. */
    readonly mineFileIds: ReadonlySet<string> | null;
    /** File read-state. Files missing from the map use their own defaults. */
    readonly readState: ReadonlyMap<string, FileReadState>;
    /** Route in the margins (docs/design/README.md §10). null means no route and no row badges. */
    readonly routeFiles: ReadonlyMap<string, RouteMarginFile> | null;
    /** Reviewer's explicit choice: path → collapsed. Missing keys use the default. */
    readonly collapsed: ReadonlyMap<string, boolean>;
}

interface Node {
    readonly segment: string;
    readonly path: string;
    readonly dirs: Map<string, Node>;
    readonly files: TreeFileRow[];
    additions: number;
    deletions: number;
    fileCount: number;
    readCount: number;
    generatedCount: number;
    mineCount: number;
}

function makeNode(segment: string, path: string): Node {
    return {
        segment,
        path,
        dirs: new Map(),
        files: [],
        additions: 0,
        deletions: 0,
        fileCount: 0,
        readCount: 0,
        generatedCount: 0,
        mineCount: 0,
    };
}

interface EmitContext {
    readonly rows: TreeRow[];
    readonly directories: Set<string>;
    readonly bulkDirectories: Set<string>;
    readonly collapsed: ReadonlyMap<string, boolean>;
    readonly mineKnown: boolean;
}

/**
 * Tree rows in traversal order. `inTreeOrder` sets the order. Files are already placed into nodes
 * in that order, so each node's directories and files follow insertion order. There is nothing
 * to sort during traversal.
 */
export function buildFileTree(input: FileTreeInput): FileTree {
    const root = makeNode('', '');

    for (const file of inTreeOrder(input.files)) {
        const segments = file.path.split('/');
        const name = segments.pop() ?? file.path;
        const read = input.readState.get(file.fileId) ?? readStateOf({ file, record: null });
        const mine = input.mineFileIds?.has(file.fileId) ?? false;

        let node = root;
        const chain: Node[] = [root];
        for (const segment of segments) {
            let next = node.dirs.get(segment);
            if (next === undefined) {
                next = makeNode(segment, node.path === '' ? segment : `${node.path}/${segment}`);
                node.dirs.set(segment, next);
            }
            node = next;
            chain.push(node);
        }

        node.files.push({
            kind: 'file',
            path: file.path,
            label: name,
            depth: 0,
            fileId: file.fileId,
            additions: file.additions,
            deletions: file.deletions,
            generated: file.generated,
            hostFileUrl: file.hostFileUrl,
            blameUrl: file.blameUrl,
            conflict: file.changeType === 'conflict',
            pci: input.pciFileIds.has(file.fileId),
            read,
            route: input.routeFiles?.get(file.fileId) ?? null,
        });

        for (const ancestor of chain) {
            ancestor.additions += file.additions;
            ancestor.deletions += file.deletions;
            ancestor.fileCount += 1;
            ancestor.readCount += read.state === 'read' ? 1 : 0;
            ancestor.generatedCount += file.generated ? 1 : 0;
            ancestor.mineCount += mine ? 1 : 0;
        }
    }

    const context: EmitContext = {
        rows: [],
        directories: new Set(),
        bulkDirectories: new Set(),
        collapsed: input.collapsed,
        mineKnown: input.mineFileIds !== null,
    };
    emit(root, 0, '', true, context);
    return { rows: context.rows, directories: context.directories, bulkDirectories: context.bulkDirectories };
}

/**
 * Traversal that combines chains. `prefix` holds combined ancestor segments. `visible: false` means
 * rows are not emitted (inside a collapsed directory), but the subtree still needs traversal.
 * Its directories must appear in `directories` and the size-based defaults.
 */
function emit(node: Node, depth: number, prefix: string, visible: boolean, context: EmitContext): void {
    for (const dir of node.dirs.values()) {
        const chain = prefix === '' ? dir.segment : `${prefix}/${dir.segment}`;
        const onlyDir = dir.dirs.size === 1 && dir.files.length === 0;

        // A "directory → only directory" chain renders as one row. The intermediate node has no
        // row of its own. Its segment moves into the descendant's label. A directory
        // with a single file is excluded from the chain. File rows show only the name,
        // otherwise the path takes the whole row from it (docs/design/SPEC-theming-2026-09-12.md §6a).
        if (onlyDir) {
            emit(dir, depth, chain, visible, context);
            continue;
        }

        context.directories.add(dir.path);
        const children = dir.dirs.size + dir.files.length;
        if (children > BULK_DIRECTORY_CHILDREN) {
            context.bulkDirectories.add(dir.path);
        }
        const collapsed = context.collapsed.get(dir.path) ?? children > BULK_DIRECTORY_CHILDREN;

        if (visible) {
            context.rows.push({
                kind: 'dir',
                path: dir.path,
                label: chain,
                depth,
                additions: dir.additions,
                deletions: dir.deletions,
                files: dir.fileCount,
                readFiles: dir.readCount,
                generated: dir.generatedCount === dir.fileCount,
                // Roots outside the ownership zone only apply at the top level (docs/design/README.md §10). Deeper down,
                // the files themselves already make ownership visible, so no extra dimming is needed.
                foreign: depth === 0 && context.mineKnown && dir.mineCount === 0,
                collapsed,
            });
        }
        emit(dir, depth + 1, '', visible && !collapsed, context);
    }

    // A combined directory chain has no files of its own (otherwise it is not a chain), so
    // a file label is always its name, with nothing added from `prefix`.
    if (visible) {
        for (const file of node.files) {
            context.rows.push({ ...file, depth });
        }
    }
}

/**
 * Row key for React and the virtualizer. One path can belong to both a directory and a file
 * (a file without an extension beside its directory: `src/a` and `src/a/b.ts`), so the path alone is not enough.
 */
export function rowKey(row: TreeRow): string {
    return `${row.kind}:${row.path}`;
}

/**
 * Row label split into a directory chain and the final segment (docs/design/SPEC-elements.md §1.2). The path
 * truncates from the left while the filename with its extension stays intact. The separator moves into the name, so
 * no neutral character remains at the left truncation edge to disrupt the order.
 */
export function splitLabel(label: string): { readonly dir: string; readonly name: string } {
    const cut = label.lastIndexOf('/');
    return cut < 0 ? { dir: '', name: label } : { dir: label.slice(0, cut), name: label.slice(cut) };
}

/** Directory collapse state with defaults applied. The reviewer's explicit choice takes priority. */
export function isCollapsed(tree: FileTree, collapsed: ReadonlyMap<string, boolean>, path: string): boolean {
    return collapsed.get(path) ?? tree.bulkDirectories.has(path);
}

/**
 * Toggle a directory. ⌥-click (`subtree`) applies the new state to the whole subtree,
 * including directories hidden by collapsed ancestors (docs/design/SPEC-elements.md §2.20).
 */
export function toggleDirectory(
    tree: FileTree,
    collapsed: ReadonlyMap<string, boolean>,
    path: string,
    subtree: boolean,
): Map<string, boolean> {
    const value = !isCollapsed(tree, collapsed, path);
    const next = new Map(collapsed).set(path, value);
    if (subtree) {
        for (const candidate of tree.directories) {
            if (candidate.startsWith(`${path}/`)) {
                next.set(candidate, value);
            }
        }
    }
    return next;
}

/**
 * Query filtering (docs/design/SPEC-elements.md §2.20): substring in the path or fuzzy match on the
 * filename. An empty query matches everything.
 */
export function matchesQuery(path: string, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (needle === '') {
        return true;
    }

    const haystack = path.toLowerCase();
    if (haystack.includes(needle)) {
        return true;
    }
    return fuzzyMatch(haystack.slice(haystack.lastIndexOf('/') + 1), needle);
}

export function filterByQuery(files: readonly FileDiff[], query: string): readonly FileDiff[] {
    return query.trim() === '' ? files : files.filter((file) => matchesQuery(file.path, query));
}

/** Three read-state checkbox styles (docs/design/SPEC-elements.md §2.12, §2.20): full, half, empty. */
export type ReadSummary = 'none' | 'partial' | 'full';

/** Read-state checkbox in row markup. */
export function readBox(state: ReadState): ReadSummary {
    if (state === 'read') {
        return 'full';
    }
    return state === 'partial' ? 'partial' : 'none';
}
