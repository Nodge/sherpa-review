import type { FileChangeType, FileDiff, HostId } from '@sherpa/protocol';

/**
 * Builds unified diffs for fixtures. Uses the `git diff` format (file header, `@@ -a,b +c,d @@`,
 * lines prefixed with ' ' / '+' / '-'): the real UI diff parser (M1-T5) will parse it,
 * so fixtures must contain valid diffs, not just text resembling a diff.
 *
 * Always derives `additions`/`deletions` counts from the patch itself, so they cannot disagree.
 */

/** Hunk line with its prefix: ' ' for context, '+' for added, '-' for deleted. */
export type PatchLine = string;

export interface HunkSpec {
    /** First hunk line number in the old file version (1-based, 0 if there is no old version). */
    oldStart: number;
    newStart: number;
    /** Text after the closing `@@`. The UI extracts the entity header from it (SPEC §2.13). */
    section?: string;
    lines: readonly PatchLine[];
}

export interface FileSpec {
    path: string;
    /** Previous path for move/copy. */
    oldPath?: string;
    changeType: FileChangeType;
    binary?: boolean;
    generated?: boolean;
    /** null means the host does not support viewed marks (see `capabilities.fileViewedSync`). */
    viewed?: boolean | null;
    /** Link to blame on the host website, absent by default. */
    blameUrl?: string;
    /** Link to the file in the PR on the host website, absent by default. */
    hostFileUrl?: string;
    hunks?: readonly HunkSpec[];
    /** File mode in the git header, defaults to a regular file. */
    mode?: string;
    /** Previous mode: if different from `mode`, the patch includes `old mode`/`new mode` lines. */
    oldMode?: string;
}

const DEFAULT_MODE = '100644';

/**
 * FNV-1a: stable "blob hashes" and path-based ids keep fixtures independent of build order.
 * A deterministic fingerprint, not a cryptographic hash. Also used for the route snapshot
 * `contentHash`: Node's `crypto` is unavailable here, since the package also loads in the browser.
 */
export function hashHex(input: string, length: number): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    let out = '';
    let state = hash;
    while (out.length < length) {
        out += state.toString(16).padStart(8, '0');
        state = Math.imul(state ^ 0x9e3779b9, 0x01000193) >>> 0;
    }
    return out.slice(0, length);
}

/**
 * Opaque diff item id. Its shape follows the host format (`eid:1:<base64>`, M1-T1 spike):
 * consumers must not parse it, and its appearance makes this clear.
 */
export function makeFileId(diffId: HostId, path: string): HostId {
    return `eid:1:${base64url(`${diffId}/${path}`)}`;
}

/**
 * base64url without `Buffer`: the fixture package also loads in the browser (state gallery, e2e),
 * where Node's `Buffer` is unavailable.
 */
function base64url(value: string): string {
    const bytes = new TextEncoder().encode(value);
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function countLines(lines: readonly PatchLine[]): { additions: number; deletions: number; context: number } {
    let additions = 0;
    let deletions = 0;
    let context = 0;
    for (const line of lines) {
        const prefix = line.slice(0, 1);
        if (prefix === '+') {
            additions += 1;
        } else if (prefix === '-') {
            deletions += 1;
        } else if (prefix === ' ') {
            context += 1;
        } else {
            throw new Error(`hunk line without a ' ', '+' or '-' prefix: ${JSON.stringify(line)}`);
        }
    }
    return { additions, deletions, context };
}

function renderHunk(hunk: HunkSpec): string {
    const { additions, deletions, context } = countLines(hunk.lines);
    const oldCount = context + deletions;
    const newCount = context + additions;
    const oldStart = oldCount === 0 ? 0 : hunk.oldStart;
    const newStart = newCount === 0 ? 0 : hunk.newStart;
    const section = hunk.section === undefined ? '' : ` ${hunk.section}`;
    const header = `@@ -${String(oldStart)},${String(oldCount)} +${String(newStart)},${String(newCount)} @@${section}`;
    return [header, ...hunk.lines].join('\n');
}

/** Mode change: git shows it as separate header lines, even when content is unchanged. */
function isModeChanged(spec: FileSpec): boolean {
    const mode = spec.mode ?? DEFAULT_MODE;
    return (spec.oldMode ?? mode) !== mode;
}

function renderFileHeader(spec: FileSpec): string[] {
    const mode = spec.mode ?? DEFAULT_MODE;
    const from = spec.oldPath ?? spec.path;
    const blobA = hashHex(`old:${from}`, 7);
    const blobB = hashHex(`new:${spec.path}`, 7);
    const lines = [`diff --git a/${from} b/${spec.path}`];
    const modeChanged = isModeChanged(spec);
    const hasHunks = (spec.hunks ?? []).length > 0;

    switch (spec.changeType) {
        case 'add':
            lines.push(`new file mode ${mode}`, `index 0000000..${blobB}`, '--- /dev/null', `+++ b/${spec.path}`);
            break;
        case 'delete':
            lines.push(`deleted file mode ${mode}`, `index ${blobA}..0000000`, `--- a/${from}`, '+++ /dev/null');
            break;
        case 'move':
        case 'copy': {
            const verb = spec.changeType === 'move' ? 'rename' : 'copy';
            lines.push(
                'similarity index 92%',
                `${verb} from ${from}`,
                `${verb} to ${spec.path}`,
                `index ${blobA}..${blobB} ${mode}`,
                `--- a/${from}`,
                `+++ b/${spec.path}`,
            );
            break;
        }
        case 'modify':
        case 'conflict':
            if (modeChanged) {
                lines.push(`old mode ${String(spec.oldMode)}`, `new mode ${mode}`);
            }
            if (hasHunks) {
                // git writes the mode in the `index` line only when it has not changed.
                lines.push(
                    modeChanged ? `index ${blobA}..${blobB}` : `index ${blobA}..${blobB} ${mode}`,
                    `--- a/${from}`,
                    `+++ b/${spec.path}`,
                );
            }
            break;
    }
    return lines;
}

/**
 * Builds a `FileDiff`. The patch is null for binary files and files without a text diff (empty files):
 * this matches the host response. The UI shows these files as single-line notices (SPEC §2.14).
 * A mode change without content changes has a patch consisting only of headers, without hunks.
 */
export function makeFileDiff(diffId: HostId, spec: FileSpec): FileDiff {
    const hunks = spec.hunks ?? [];
    const binary = spec.binary ?? false;
    const totals = countLines(hunks.flatMap((hunk) => hunk.lines));
    const hasPatch = !binary && (hunks.length > 0 || isModeChanged(spec));

    return {
        fileId: makeFileId(diffId, spec.path),
        path: spec.path,
        oldPath: spec.oldPath ?? null,
        changeType: spec.changeType,
        binary,
        generated: spec.generated ?? false,
        additions: totals.additions,
        deletions: totals.deletions,
        patch: hasPatch ? [...renderFileHeader(spec), ...hunks.map(renderHunk), ''].join('\n') : null,
        viewed: spec.viewed === undefined ? false : spec.viewed,
        blameUrl: spec.blameUrl ?? null,
        hostFileUrl: spec.hostFileUrl ?? null,
    };
}

/** Total `+`/`−` across a set of files. Fixtures use this function to check their declared sizes. */
export function totalChanges(files: readonly FileDiff[]): { additions: number; deletions: number } {
    return files.reduce(
        (acc, file) => ({ additions: acc.additions + file.additions, deletions: acc.deletions + file.deletions }),
        { additions: 0, deletions: 0 },
    );
}
