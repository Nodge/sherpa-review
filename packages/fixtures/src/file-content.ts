import type { FileContent, FileDiff } from '@sherpa/protocol';

import { contextLineAt } from './content.js';

/**
 * Full file text on both sides of the diff supports "Expand context" (`docs/design/SPEC-elements.md §2.13`).
 *
 * There is no need to store full files in the repository. Hunk lines come from the patch, and anything
 * the patch leaves out is generated from the line number (`contextLineAt`). This gives two
 * invariants the UI relies on: numbering agrees with the patch (a hunk context line
 * appears in the text at its exact line number), and unchanged parts match in both versions.
 * The old side uses the new-side line number to generate its content (see `deltaAt`).
 */

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Unchanged lines the fixture appends after the last hunk. The file does not end there. */
function tailLength(path: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < path.length; i += 1) {
        hash ^= path.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return 8 + (hash % 25);
}

interface HunkBounds {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
}

interface ParsedPatch {
    /** Line number → text, separately for each side. */
    old: Map<number, string>;
    new: Map<number, string>;
    hunks: HunkBounds[];
}

function parsePatch(patch: string): ParsedPatch {
    const parsed: ParsedPatch = { old: new Map(), new: new Map(), hunks: [] };
    const lines = patch.split('\n');
    let hunk: HunkBounds | null = null;
    let oldLine = 0;
    let newLine = 0;

    for (const raw of lines) {
        const header = HUNK_HEADER_RE.exec(raw);
        if (header !== null) {
            oldLine = Number(header[1]);
            newLine = Number(header[3]);
            hunk = { oldStart: oldLine, oldEnd: oldLine, newStart: newLine, newEnd: newLine };
            parsed.hunks.push(hunk);
            continue;
        }
        if (hunk === null) {
            continue;
        }

        const prefix = raw.slice(0, 1);
        const text = raw.slice(1);
        if (prefix === '+') {
            parsed.new.set(newLine, text);
            newLine += 1;
        } else if (prefix === '-') {
            parsed.old.set(oldLine, text);
            oldLine += 1;
        } else if (prefix === ' ') {
            parsed.old.set(oldLine, text);
            parsed.new.set(newLine, text);
            oldLine += 1;
            newLine += 1;
        } else {
            // A header tail from the next file is impossible in a fixture patch (patches are per-file),
            // and a trailing empty line is not a hunk line.
            continue;
        }
        hunk.oldEnd = oldLine;
        hunk.newEnd = newLine;
    }
    return parsed;
}

/**
 * New-side line-number offset relative to the old side at `oldLine`: before the first hunk, it is that
 * hunk's own offset. After that, it is the accumulated offset of preceding hunks. The old side uses it
 * to get unchanged-line text from the same place as the new side.
 */
function deltaAt(hunks: readonly HunkBounds[], oldLine: number): number {
    const first = hunks[0];
    if (first === undefined) {
        return 0;
    }
    let delta = first.newStart - first.oldStart;
    for (const hunk of hunks) {
        if (hunk.oldEnd <= oldLine) {
            delta = hunk.newEnd - hunk.oldEnd;
        }
    }
    return delta;
}

function build(known: ReadonlyMap<number, string>, total: number, path: string, delta: (line: number) => number): string {
    const lines: string[] = [];
    for (let line = 1; line <= total; line += 1) {
        lines.push(known.get(line) ?? contextLineAt(path, line + delta(line)));
    }
    return lines.join('\n');
}

function lastKey(map: ReadonlyMap<number, string>): number {
    let max = 0;
    for (const key of map.keys()) {
        max = Math.max(max, key);
    }
    return max;
}

/**
 * File text on both sides. `null` means no content (binary). The patch contains added and deleted files
 * in full, so nothing is generated for them. The missing side is `null`,
 * and the present side contains exactly the patch lines.
 */
export function fileContentOf(file: FileDiff): FileContent | null {
    if (file.binary) {
        return null;
    }

    const patch = file.patch === null ? null : parsePatch(file.patch);
    if (file.changeType === 'add') {
        const newText = patch === null ? '' : build(patch.new, lastKey(patch.new), file.path, () => 0);
        return { oldText: null, newText };
    }
    if (file.changeType === 'delete') {
        const oldText = patch === null ? '' : build(patch.old, lastKey(patch.old), file.path, () => 0);
        return { oldText, newText: null };
    }

    // Modification (including a mode-only change): the file extends past the patch, with an unchanged tail
    // after the last hunk and an unchanged beginning before the first.
    const newTotal = (patch === null ? 0 : lastKey(patch.new)) + tailLength(file.path);
    const finalDelta = patch === null ? 0 : deltaAt(patch.hunks, Number.MAX_SAFE_INTEGER);
    const oldTotal = newTotal - finalDelta;

    return {
        oldText: build(patch?.old ?? new Map(), oldTotal, file.path, (line) =>
            patch === null ? 0 : deltaAt(patch.hunks, line),
        ),
        newText: build(patch?.new ?? new Map(), newTotal, file.path, () => 0),
    };
}
