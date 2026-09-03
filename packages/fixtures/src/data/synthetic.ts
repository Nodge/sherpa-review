import type { FileChangeType, FileDiff, HostId } from '@sherpa/protocol';

import { tsLines } from '../content.js';
import type { HunkSpec } from '../patch.js';
import { makeFileDiff } from '../patch.js';

/**
 * Generates synthetic PRs from identically shaped modules. Used to build `large` (64 files) and
 * `huge` (100 files, 20k+ lines for the performance run in requirements §7).
 *
 * Content is computed from the file index instead of stored, keeping megabytes out of the repository while
 * producing byte-for-byte identical results across runs. The index itself is the seed, with no `Math.random()`.
 */

/** File size in patch lines and the number of hunks they form. */
export interface SyntheticSize {
    additions: number;
    deletions: number;
    /** Hunks per file. Always one for add/delete, since the patch contains the whole file. */
    hunks: number;
}

export interface SyntheticParams {
    diffId: HostId;
    /** Root of module paths: `<root>/mod-01/service.ts`. */
    root: string;
    modules: number;
    filesPerModule: number;
    /** Filenames within a module, selected by `index % fileKinds.length`. */
    fileKinds: readonly string[];
    /** Generated file: its path gains a `generated/` segment, and its card collapses by default. */
    generatedAt: (index: number) => boolean;
    changeTypeAt: (index: number) => Extract<FileChangeType, 'add' | 'modify' | 'delete'>;
    sizeAt: (index: number) => SyntheticSize;
    /** Unchanged context lines at the start of each modification hunk. */
    context: number;
    viewedAt: (index: number, changeType: FileChangeType) => boolean;
    /** Insert long lines into the file for line-wrapping tests. */
    longLinesAt?: (index: number) => boolean;
    /** Text after the closing `@@`. The UI reads the entity header from it (SPEC §2.13). */
    sectionAt?: (moduleIndex: number) => string;
}

/** Changed-line range on one side, used by the route fixture to build anchors. */
export interface SyntheticRange {
    side: 'old' | 'new';
    start: number;
    end: number;
}

export interface SyntheticFile {
    file: FileDiff;
    moduleIndex: number;
    /** Changed lines only. Hunk context stays outside the ranges. */
    ranges: SyntheticRange[];
}

/** Unique part of a long URL that lets the test find the line after patch parsing. */
export const LONG_LINE_MARKER = 'wrap-fixture.invalid';

/** The first modification hunk starts here. Subsequent hunks have `HUNK_GAP` unchanged lines between them. */
const FIRST_HUNK_START = 12;
const HUNK_GAP = 9;

export function modulePathOf(root: string, moduleIndex: number): string {
    return `${root}/mod-${String(moduleIndex + 1).padStart(2, '0')}`;
}

/**
 * Long-line insertion: an extra-long URL on both sides, minified JSON, a line with
 * tabs and a line with trailing spaces. Line counts stay the same because existing lines are replaced.
 */
function injectLongLines(deletedLines: string[], addedLines: string[], deletions: number): void {
    deletedLines[0] = `-    const endpoint = "https://${LONG_LINE_MARKER}/payload/${'b'.repeat(600)}/orders";`;
    addedLines[0] = `+    const endpoint = "https://${LONG_LINE_MARKER}/payload/${'a'.repeat(600)}/orders";`;
    // Replace lines instead of inserting them to preserve the patch line count. Short files may lack trailing
    // positions, in which case only the long URLs are inserted.
    if (deletions + 2 >= addedLines.length) {
        return;
    }
    addedLines[deletions] = `+    const minifiedPayload = "${'eyJrZXkiOiJ2YWx1ZSIsImZsYWciOnRydWV9'.repeat(35)}";`;
    addedLines[deletions + 1] = `+\t\tconst tabbedTail = "${'tabbed-tail-'.repeat(100)}";`;
    addedLines[deletions + 2] = `+    const trailingWhitespace = "${'tail-'.repeat(180)}";   `;
}

/** Divide `total` lines among `parts` hunks, giving the remainder to the first hunks. */
function split(total: number, parts: number): number[] {
    const base = Math.floor(total / parts);
    const extra = total % parts;
    return Array.from({ length: parts }, (_, part) => base + (part < extra ? 1 : 0));
}

function pathAt(params: SyntheticParams, index: number, generated: boolean): string {
    const moduleIndex = Math.floor(index / params.filesPerModule);
    const kind = params.fileKinds[index % params.fileKinds.length] ?? 'service.ts';
    const base = modulePathOf(params.root, moduleIndex);
    return generated ? `${base}/generated/${kind}` : `${base}/${kind}`;
}

/**
 * Modification hunks: each has context, then deleted lines, then added lines. Lines
 * are sliced from the same two arrays as for a single-hunk file, so the number of hunks
 * changes only the layout, not the content.
 */
function modifyHunks(
    params: SyntheticParams,
    index: number,
    size: SyntheticSize,
    section: string | undefined,
): { hunks: HunkSpec[]; ranges: SyntheticRange[] } {
    const deletedLines = tsLines('-', size.deletions, index + 5);
    const addedLines = tsLines('+', size.additions, index + 11);
    if (params.longLinesAt?.(index) === true) {
        injectLongLines(deletedLines, addedLines, size.deletions);
    }

    const parts = Math.max(1, size.hunks);
    const deletionParts = split(size.deletions, parts);
    const additionParts = split(size.additions, parts);
    const hunks: HunkSpec[] = [];
    const ranges: SyntheticRange[] = [];

    let oldCursor = FIRST_HUNK_START;
    let newCursor = FIRST_HUNK_START;
    let deletedTaken = 0;
    let addedTaken = 0;
    for (let part = 0; part < parts; part += 1) {
        const deletions = deletionParts[part] ?? 0;
        const additions = additionParts[part] ?? 0;
        const context = tsLines(' ', params.context, index + 1);
        hunks.push({
            oldStart: oldCursor,
            newStart: newCursor,
            ...(section === undefined ? {} : { section }),
            lines: [
                ...context,
                ...deletedLines.slice(deletedTaken, deletedTaken + deletions),
                ...addedLines.slice(addedTaken, addedTaken + additions),
            ],
        });
        if (deletions > 0) {
            ranges.push({ side: 'old', start: oldCursor + params.context, end: oldCursor + params.context + deletions - 1 });
        }
        if (additions > 0) {
            ranges.push({ side: 'new', start: newCursor + params.context, end: newCursor + params.context + additions - 1 });
        }
        deletedTaken += deletions;
        addedTaken += additions;
        oldCursor += params.context + deletions + HUNK_GAP;
        newCursor += params.context + additions + HUNK_GAP;
    }
    return { hunks, ranges };
}

function fileAt(params: SyntheticParams, index: number): SyntheticFile {
    const moduleIndex = Math.floor(index / params.filesPerModule);
    const generated = params.generatedAt(index);
    const path = pathAt(params, index, generated);
    const changeType = params.changeTypeAt(index);
    const size = params.sizeAt(index);
    const viewed = params.viewedAt(index, changeType);

    if (changeType === 'add') {
        const file = makeFileDiff(params.diffId, {
            path,
            changeType,
            generated,
            ...(viewed ? { viewed } : {}),
            hunks: [{ oldStart: 0, newStart: 1, lines: tsLines('+', size.additions, index) }],
        });
        return {
            file,
            moduleIndex,
            ranges: size.additions === 0 ? [] : [{ side: 'new', start: 1, end: size.additions }],
        };
    }

    if (changeType === 'delete') {
        const file = makeFileDiff(params.diffId, {
            path,
            changeType,
            generated,
            ...(viewed ? { viewed } : {}),
            hunks: [{ oldStart: 1, newStart: 0, lines: tsLines('-', size.deletions, index + 3) }],
        });
        return {
            file,
            moduleIndex,
            ranges: size.deletions === 0 ? [] : [{ side: 'old', start: 1, end: size.deletions }],
        };
    }

    const { hunks, ranges } = modifyHunks(params, index, size, params.sectionAt?.(moduleIndex));
    return {
        file: makeFileDiff(params.diffId, { path, changeType, generated, viewed, hunks }),
        moduleIndex,
        ranges,
    };
}

/** Synthetic PR files in index order, together with the map of changed ranges. */
export function synthesizeFiles(params: SyntheticParams): SyntheticFile[] {
    const total = params.modules * params.filesPerModule;
    const files: SyntheticFile[] = [];
    for (let index = 0; index < total; index += 1) {
        files.push(fileAt(params, index));
    }
    return files;
}
