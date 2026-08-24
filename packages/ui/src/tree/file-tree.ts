import type { FileDiff } from '@sherpa/protocol';

import { fuzzyMatch } from '../palette/fuzzy.js';
import type { FileReadState, ReadState } from '../progress/read-state.js';
import { readStateOf } from '../progress/read-state.js';

/**
 * File tree in the left panel of the full diff (SPEC §2.20, README §10). Pure module:
 * building, aggregates, collapsing and search run without React or the DOM. Rendering only draws
 * the prepared rows.
 *
 * Directory chains with a single child collapse into one row (`services/orders`,
 * `api/v3`), so a tree of 18 files fits in the panel instead of taking one row
 * per path segment.
 */

/** Directories with more children than this start collapsed (SPEC §2.20). */
export const BULK_DIRECTORY_CHILDREN = 20;

export interface TreeFileRow {
    readonly kind: 'file';
    /** File path, also the row key. */
    readonly path: string;
    /** Filename with the collapsed directory chain attached. */
    readonly label: string;
    readonly depth: number;
    readonly fileId: string;
    readonly additions: number;
    readonly deletions: number;
    readonly generated: boolean;
    /** The file belongs to the extra `pci` lens, shown as a row tag (README §10). */
    readonly pci: boolean;
    /** File reading progress (SPEC §2.12): three states and tooltip counts. */
    readonly read: FileReadState;
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
    /** The entire subtree is generated, so it dims like generated files (README §10). */
    readonly generated: boolean;
    /**
     * Root directory with none of my files (README §10, "foreign roots").
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
 * Tree rows in traversal order. Within a directory, directories come before files,
 * each group alphabetically. The host has its own diff file order, which does not suit the tree.
 */
export function buildFileTree(input: FileTreeInput): FileTree {
    const root = makeNode('', '');

    for (const file of input.files) {
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
            pci: input.pciFileIds.has(file.fileId),
            read,
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
    const dirs = [...node.dirs.values()].sort((a, b) => a.segment.localeCompare(b.segment));

    for (const dir of dirs) {
        const chain = prefix === '' ? dir.segment : `${prefix}/${dir.segment}`;
        const onlyDir = dir.dirs.size === 1 && dir.files.length === 0 ? [...dir.dirs.values()][0] : undefined;
        const onlyFile = dir.dirs.size === 0 && dir.files.length === 1 ? dir.files[0] : undefined;

        // A "one directory → one child" chain renders as one row. The intermediate node has no row
        // of its own, and its segment moves into the descendant's label.
        if (onlyDir !== undefined) {
            emit(dir, depth, chain, visible, context);
            continue;
        }
        if (onlyFile !== undefined) {
            if (visible) {
                context.rows.push({ ...onlyFile, label: `${chain}/${onlyFile.label}`, depth });
            }
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
                // A "foreign root" only applies at the top level (README §10). Further down,
                // the files themselves already make ownership visible, so no extra dimming is needed.
                foreign: depth === 0 && context.mineKnown && dir.mineCount === 0,
                collapsed,
            });
        }
        emit(dir, depth + 1, '', visible && !collapsed, context);
    }

    if (visible) {
        for (const file of [...node.files].sort((a, b) => a.label.localeCompare(b.label))) {
            context.rows.push({ ...file, label: prefix === '' ? file.label : `${prefix}/${file.label}`, depth });
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
 * Row label split into a directory chain and the final segment (SPEC §1.2). The path
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
 * including directories hidden under a collapsed parent (SPEC §2.20).
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
 * Filter by query (SPEC §2.20): a path substring or a fuzzy match against the
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

/** Directory reading summary (SPEC §2.20): all read → ✓, some read → half-filled box. */
export type ReadSummary = 'none' | 'partial' | 'full';

export function readSummary(row: TreeDirRow): ReadSummary {
    if (row.readFiles === 0) {
        return 'none';
    }
    return row.readFiles === row.files ? 'full' : 'partial';
}

/** Read-state box in the row: the same three forms as the directory summary (SPEC §2.12). */
export function readBox(state: ReadState): ReadSummary {
    if (state === 'read') {
        return 'full';
    }
    return state === 'partial' ? 'partial' : 'none';
}
