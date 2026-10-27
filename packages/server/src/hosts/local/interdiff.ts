import type { FileChangeType, FileDiff, PrDiff } from '@sherpa/protocol';
import { structuredPatch } from 'diff';

import { countPatchStats } from '../../patch/split.js';

import type { LocalIterationFile, LocalIterationRecord, LocalIterationsStore } from './iterations-store.js';

/**
 * Slice between two working-tree iterations: changes from `base` to `head`. The old side
 * of patches is the `base` iteration head, the new side is the `head` head, as `line-map.ts` expects.
 *
 * Computed from iteration history: the index holds the file list, and blobs hold the new-side
 * content. jsdiff builds the patch, then headers are added in the git format used by
 * `splitPatchByFile` and the UI parser.
 */

/** Context lines around a change, matching the `git diff` default. */
const CONTEXT_LINES = 3;

/** File mode in add/delete headers: the local adapter does not manage permissions. */
const FILE_MODE = '100644';

export async function localInterdiff(
    store: Pick<LocalIterationsStore, 'blob'>,
    base: LocalIterationRecord,
    head: LocalIterationRecord,
): Promise<PrDiff> {
    const meta = { diffId: head.diffId, baseCommit: base.headCommit, headCommit: head.headCommit };
    if (base.diffId === head.diffId) {
        return { ...meta, files: [] };
    }

    const byPath = (record: LocalIterationRecord): Map<string, LocalIterationFile> =>
        new Map(record.files.map((file) => [file.path, file]));
    const left = byPath(base);
    const right = byPath(head);
    const paths = [...new Set([...left.keys(), ...right.keys()])].sort((one, other) => one.localeCompare(other));

    const files: FileDiff[] = [];
    for (const path of paths) {
        const file = await sliceFile(store, base, head, path, present(left.get(path)), present(right.get(path)));
        if (file !== null) {
            files.push(file);
        }
    }
    return { ...meta, files };
}

/**
 * File on one side of the slice. Null means absent on that side. A file deleted in the working tree
 * is absent in its iteration: `changeType: 'delete'` describes the tree.
 */
function present(file: LocalIterationFile | undefined): LocalIterationFile | null {
    return file === undefined || file.changeType === 'delete' ? null : file;
}

async function sliceFile(
    store: Pick<LocalIterationsStore, 'blob'>,
    base: LocalIterationRecord,
    head: LocalIterationRecord,
    path: string,
    left: LocalIterationFile | null,
    right: LocalIterationFile | null,
): Promise<FileDiff | null> {
    if (left === null && right === null) {
        return null;
    }
    if (left !== null && right !== null && left.hash === right.hash) {
        return null;
    }

    const changeType: FileChangeType = left === null ? 'add' : right === null ? 'delete' : 'modify';
    const oldText = await sideText(store, left);
    const newText = await sideText(store, right);
    // If either side has no text (binary, over the limit, or missing blob), there is nothing to show.
    const patch =
        oldText === null || newText === null ? null : unifiedPatch(path, oldText, newText, changeType);
    const stats = patch === null ? { additions: 0, deletions: 0 } : countPatchStats(patch);

    return {
        fileId: sliceFileId(base.diffId, head.diffId, path),
        path,
        oldPath: null,
        changeType,
        binary: patch === null,
        // Host review rules are not reproduced locally, just as for the iteration itself.
        generated: false,
        additions: stats.additions,
        deletions: stats.deletions,
        patch,
        viewed: null,
        blameUrl: null,
        hostFileUrl: null,
        // No images in a slice: carryover and banners consume it, not the reviewer.
        image: null,
    };
}

/** Side text: null means present but not representable as text, `''` means the side is absent. */
async function sideText(
    store: Pick<LocalIterationsStore, 'blob'>,
    file: LocalIterationFile | null,
): Promise<string | null> {
    if (file === null) {
        return '';
    }
    if (file.kind !== 'text' || file.blob === null) {
        return null;
    }
    return store.blob(file.blob);
}

/**
 * Opaque slice file id. Intentionally distinct from iteration `fileId`: this is a different diff,
 * and viewed marks or comments must not be anchored to it.
 */
export function sliceFileId(baseDiffId: string, headDiffId: string, path: string): string {
    return `slice:${baseDiffId.slice(0, 12)}:${headDiffId.slice(0, 12)}:${path}`;
}

/** Single-file unified diff in git format: header, sides and `@@ -a,b +c,d @@` hunks. */
function unifiedPatch(path: string, oldText: string, newText: string, changeType: FileChangeType): string {
    const header = [`diff --git a/${path} b/${path}`];
    if (changeType === 'add') {
        header.push(`new file mode ${FILE_MODE}`, '--- /dev/null', `+++ b/${path}`);
    } else if (changeType === 'delete') {
        header.push(`deleted file mode ${FILE_MODE}`, `--- a/${path}`, '+++ /dev/null');
    } else {
        header.push(`--- a/${path}`, `+++ b/${path}`);
    }

    const { hunks } = structuredPatch(path, path, oldText, newText, undefined, undefined, {
        context: CONTEXT_LINES,
    });
    return [...header, ...hunks.flatMap(renderHunk), ''].join('\n');
}

interface StructuredHunk {
    readonly oldStart: number;
    readonly oldLines: number;
    readonly newStart: number;
    readonly newLines: number;
    readonly lines: readonly string[];
}

/** Hunk as patch lines. An empty side starts at zero, as git writes it, unlike jsdiff. */
function renderHunk(hunk: StructuredHunk): string[] {
    const oldStart = hunk.oldLines === 0 ? 0 : hunk.oldStart;
    const newStart = hunk.newLines === 0 ? 0 : hunk.newStart;
    const head =
        `@@ -${String(oldStart)},${String(hunk.oldLines)} ` +
        `+${String(newStart)},${String(hunk.newLines)} @@`;
    return [head, ...hunk.lines];
}
