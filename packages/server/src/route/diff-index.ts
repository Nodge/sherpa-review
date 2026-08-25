import type { PrDiff } from '@sherpa/protocol';

/**
 * Changed diff lines are the route validator's only basis for resolving anchors.
 * Scanning `@@` hunks in `FileDiff.patch` puts added lines on the `new` side and removed lines on `old`
 * (the same definition as SPEC §2.4 coverage math: `changed = added + removed`).
 *
 * The UI parser runs in a browser worker and builds a complete line model. This module
 * only needs changed line numbers. Both must read hunk structure
 * the same way because the model anchors to line numbers the reviewer sees in the UI. A single
 * offset error invalidates a correct anchor. The rules below therefore repeat
 * `packages/ui/src/diff/parse.ts` exactly: header line counts, the `\ ` marker,
 * empty lines and unknown prefixes count as context.
 */

/** A diff file for the validator: its id for anchor resolution and changed line numbers on each side. */
export interface ChangedFile {
    readonly fileId: string;
    readonly path: string;
    readonly old: ReadonlySet<number>;
    readonly new: ReadonlySet<number>;
}

/** Diff indexed by file path. The model uses paths, and this index resolves them to `fileId`. */
export type DiffIndex = ReadonlyMap<string, ChangedFile>;

/** `@@ -a,b +c,d @@` and its short form `@@ -a +c @@` (one line), as in the UI. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function indexDiff(diff: PrDiff): DiffIndex {
    const files = new Map<string, ChangedFile>();
    for (const file of diff.files) {
        // The first file with this path wins. Paths should not repeat within one iteration.
        if (files.has(file.path)) {
            continue;
        }
        files.set(file.path, {
            fileId: file.fileId,
            path: file.path,
            ...changedLines(file.patch),
        });
    }
    return files;
}

/** Changed patch line numbers. Binary files and files without text diffs have no changed lines. */
function changedLines(patch: string | null): { old: Set<number>; new: Set<number> } {
    const oldLines = new Set<number>();
    const newLines = new Set<number>();
    if (patch === null) {
        return { old: oldLines, new: newLines };
    }

    const lines = patch.split('\n');
    let index = 0;
    while (index < lines.length) {
        const header = HUNK_HEADER.exec(lines[index] ?? '');
        index += 1;
        if (header === null) {
            continue;
        }

        let oldLine = Number(header[1]);
        let newLine = Number(header[3]);
        // Header line counts limit the hunk body. Anything after them no longer advances line numbers.
        let restOld = header[2] === undefined ? 1 : Number(header[2]);
        let restNew = header[4] === undefined ? 1 : Number(header[4]);

        while (index < lines.length && (restOld > 0 || restNew > 0)) {
            const raw = lines[index] ?? '';
            // The hunk is truncated: the next header arrived before the declared lines ran out.
            if (HUNK_HEADER.test(raw) || raw.startsWith('diff --git ')) {
                break;
            }
            index += 1;

            // `\ No newline at end of file` is a metadata marker and does not count as a line.
            if (raw.startsWith('\\ ')) {
                continue;
            }
            const prefix = raw.slice(0, 1);
            if (prefix === '+') {
                newLines.add(newLine);
                newLine += 1;
                restNew -= 1;
            } else if (prefix === '-') {
                oldLines.add(oldLine);
                oldLine += 1;
                restOld -= 1;
            } else {
                // Context includes a space, an empty line (hosts trim trailing whitespace) and an unknown
                // prefix. Anything other than `+`/`-` advances both sides, just as in the UI.
                oldLine += 1;
                newLine += 1;
                restOld -= 1;
                restNew -= 1;
            }
        }
    }

    return { old: oldLines, new: newLines };
}

/** Changed lines on the requested side of a file. */
export function sideLines(file: ChangedFile, side: 'old' | 'new'): ReadonlySet<number> {
    return side === 'old' ? file.old : file.new;
}

/**
 * Whether a range touches at least one changed line on its side. Iterates over changed
 * lines because the model supplies the range length without any limit.
 */
export function touchesChangedLines(
    file: ChangedFile,
    side: 'old' | 'new',
    start: number,
    end: number,
): boolean {
    for (const line of sideLines(file, side)) {
        if (line >= start && line <= end) {
            return true;
        }
    }
    return false;
}
