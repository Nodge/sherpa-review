import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { FileChangeType, FileDiff, FileImage, ImageSide } from '@sherpa/protocol';
import { IMAGE_BLOB_MAX_BYTES, imageMimeOf } from '@sherpa/protocol';

import { countPatchStats, splitPatchByFile } from '../../patch/split.js';

import type { LocalIterationFile } from './iterations-store.js';
import { isBinaryPatch, synthesizeAddPatch } from './patch.js';
import type { LocalVcs, NameStatusEntry, VcsInfo, VcsStatus } from './vcs.js';

/**
 * Snapshot of a local checkout's working tree: committed, staged, unstaged and untracked changes
 * in one diff against the base commit. Compute the snapshot in full, without incremental
 * updates: a diff in the project directory takes a fraction of a second, and convergence matters more. The snapshot
 * talks to the VCS only through `LocalVcs`: no commands or output parsing here.
 */

/**
 * Limit on untracked files in a snapshot. Never silently truncate the list, because some changes
 * would disappear from review. Exceeding the limit fails with an explanation instead of silently truncating.
 */
const MAX_UNTRACKED_FILES = 1_000;

/**
 * How many bytes of one file side the adapter will keep in memory and serve as text.
 * Remote host adapters use the same limit. Larger sides get `patch: null` and `getFileContent`
 * without contents: the diff endpoint response must have a size limit.
 */
export const MAX_FILE_BYTES = 2_000_000;

/** Project directory inside the checkout, shared context for all VCS calls. */
export interface LocalRepo {
    readonly vcs: LocalVcs;
    /** Project directory: cwd for VCS commands and root for paths returned by the adapter. */
    readonly projectDir: string;
    /** Checkout root: status paths and the argument for reading the old side are relative to it. */
    readonly root: string;
    /** Project directory relative to the checkout root. An empty string means the project is the root. */
    readonly prefix: string;
}

/** Project directory with its checkout root. Fail with a clear error outside a checkout. */
export async function openLocalRepo(vcs: LocalVcs, projectDir: string): Promise<LocalRepo> {
    const printed = (await vcs.root()).trim();
    if (printed === '') {
        throw new Error(`${projectDir} is not ${vcs.checkoutLabel}`);
    }

    // Resolve both sides through realpath: symlinks and `/var` → `/private/var` otherwise produce different paths,
    // leaving the project directory "outside" its own checkout.
    const root = await fs.realpath(printed);
    const real = await fs.realpath(projectDir);
    const prefix = path.relative(root, real);
    if (prefix.startsWith('..') || path.isAbsolute(prefix)) {
        throw new Error(`${real} is outside the ${vcs.kind} checkout ${root}`);
    }
    return { vcs, projectDir: real, root, prefix };
}

/** Cheap check for changes: checkout state without parsing the diff itself. */
export interface LocalProbe {
    readonly info: VcsInfo;
    readonly base: string;
    /** Base ref: explicit `--base` or the default base for this VCS. */
    readonly baseRef: string;
    readonly status: VcsStatus;
    /** Untracked files in the project directory, with paths relative to it. */
    readonly untracked: readonly string[];
    /**
     * Each file's mark (mtime and size) by absolute path at check time, before
     * taking the diff. It lets the snapshot detect a file rewritten during the operation.
     */
    readonly marks: ReadonlyMap<string, string>;
    /** Check fingerprint: branch, commits, changed files and each file's mtime. */
    readonly stamp: string;
}

/**
 * Checkout state without reading the diff: branch and HEAD, base, changed files and their mtime.
 * Recompute the base on every check because the base branch can move under the checkout.
 */
export async function probeLocal(repo: LocalRepo, explicitBase: string | null): Promise<LocalProbe> {
    const info = await repo.vcs.info();
    const { base, baseRef } = await resolveBase(repo, explicitBase);

    const status = await repo.vcs.status(repo.projectDir);
    const untracked = untrackedFilesOf(repo, status);

    const marks = new Map<string, string>();
    const mark = async (absPath: string): Promise<string> => {
        const value = await markOf(absPath);
        marks.set(absPath, value);
        return value;
    };

    const lines: string[] = [];
    for (const entry of status.changed) {
        lines.push(`${entry.status} ${entry.path} ${await mark(path.join(repo.root, entry.path))}`);
    }
    for (const file of untracked) {
        lines.push(`untracked ${file} ${await mark(path.join(repo.projectDir, file))}`);
    }

    return {
        info,
        base,
        baseRef,
        status,
        untracked,
        marks,
        stamp: JSON.stringify([info.branch, info.head, base, lines]),
    };
}

/**
 * The comparison base is always a commit. Resolve the ref on every check: the base branch
 * can move, so compare with its current commit, not the string the reviewer supplied.
 * Use an explicit base as is, and the default base through merge-base with the current branch.
 */
async function resolveBase(
    repo: LocalRepo,
    explicitBase: string | null,
): Promise<{ base: string; baseRef: string }> {
    if (explicitBase !== null) {
        return { base: await repo.vcs.revParse(explicitBase), baseRef: displayRef(explicitBase) };
    }
    const baseRef = await repo.vcs.defaultBaseRef();
    return { base: await repo.vcs.mergeBase(baseRef), baseRef };
}

/** How many characters of a full sha to show in the review header: forty will not fit. */
const SHA_DISPLAY_CHARS = 12;

/** Base ref for the header: as supplied by the reviewer, but shorten a full sha. */
function displayRef(ref: string): string {
    return /^[0-9a-f]{40}$/iu.test(ref) ? ref.slice(0, SHA_DISPLAY_CHARS) : ref;
}

/** Where to read file sides: paths relative to the checkout root and their origin. */
export interface SideSource {
    /** New-side path relative to the checkout root. */
    readonly rootPath: string;
    /** Old-side path relative to the checkout root. null means it matches the new side or is absent. */
    readonly oldRootPath: string | null;
    readonly changeType: FileChangeType;
    readonly untracked: boolean;
}

/** One snapshot file with internal adapter data: paths relative to the checkout root. */
export interface LocalFileEntry extends SideSource {
    readonly file: FileDiff;
}

export interface LocalSnapshot {
    readonly diffId: string;
    readonly baseCommit: string;
    /** Base ref used for the diff, also shown in review metadata. */
    readonly baseRef: string;
    /** Reviewed side: the working tree has no commit, so its diff fingerprint identifies it. */
    readonly headCommit: string;
    readonly createdAt: string;
    readonly branch: string;
    readonly login: string;
    /** Fingerprint of the check used to build the snapshot: polling uses it to detect an unchanged tree. */
    readonly stamp: string;
    readonly files: readonly FileDiff[];
    readonly entries: ReadonlyMap<string, LocalFileEntry>;
    readonly fileIdByPath: ReadonlyMap<string, string>;
    /** Content fingerprint for each file: detects changes to that file independently of the whole diff. */
    readonly fileHashByPath: ReadonlyMap<string, string>;
    /** Image-side bytes by `ImageSide.blobId`. Sides over the limit are excluded. */
    readonly blobs: ReadonlyMap<string, Uint8Array>;
    /** File records for iteration history, used to compute a slice between two iterations. */
    readonly iterationFiles: readonly LocalIterationFile[];
    /** New-side text file contents by blob address, written by history storage. */
    readonly textBlobs: ReadonlyMap<string, Uint8Array>;
}

/**
 * Snapshot from a completed check. `diffId` fingerprints the diff contents: while the diff is unchanged,
 * the iteration stays the same, and note and comment anchors stay in place.
 */
export async function buildLocalSnapshot(
    repo: LocalRepo,
    probe: LocalProbe,
    createdAt: string,
): Promise<LocalSnapshot> {
    const patchText = await repo.vcs.diff(probe.base);
    const nameStatus = await repo.vcs.nameStatus(probe.base);
    // Splitting needs the path list: paths with spaces cannot otherwise be parsed from a `diff --git` header.
    const chunks = splitPatchByFile(
        patchText,
        nameStatus.flatMap((entry) => (entry.oldPath === null ? [entry.path] : [entry.path, entry.oldPath])),
    );

    const fingerprint = createHash('sha256').update(probe.base).update('\n').update(patchText);
    const drafts: FileDraft[] = [];

    for (const entry of dedupeByPath(nameStatus)) {
        const chunk = chunks.get(entry.path) ?? null;
        const binary = chunk !== null && isBinaryPatch(chunk);
        // Read the new side here too: iteration history stores its contents, not its patch.
        const absPath = path.join(repo.root, joinRoot(repo.prefix, entry.path));
        const newSide: FileBytes =
            binary || entry.changeType === 'delete'
                ? { kind: 'missing' }
                : await stableNewSide(absPath, probe.marks.get(absPath));
        drafts.push(trackedDraft(entry, chunk, binary, newSide));
    }
    for (const file of probe.untracked) {
        const content = await readFileBytes(path.join(repo.projectDir, file), MAX_FILE_BYTES);
        if (content.kind === 'missing') {
            // The file disappeared between the check and the read: the next poll sees the tree without it.
            continue;
        }
        // A file over the limit contributes size and mtime to the fingerprint: no need to read it all,
        // but changing it must advance the iteration.
        fingerprint
            .update(file)
            .update('\n')
            .update(content.kind === 'bytes' ? content.bytes : content.mark);
        drafts.push(content.kind === 'bytes' ? untrackedDraft(file, content.bytes) : oversizedDraft(file, content));
    }

    const diffId = fingerprint.digest('hex');
    const entries = new Map<string, LocalFileEntry>();
    const fileIdByPath = new Map<string, string>();
    const fileHashByPath = new Map<string, string>();
    const files: FileDiff[] = [];
    const blobs = new Map<string, Uint8Array>();
    const iterationFiles: LocalIterationFile[] = [];
    const textBlobs = new Map<string, Uint8Array>();

    for (const draft of drafts) {
        iterationFiles.push(historyFileOf(draft, textBlobs));
        const sides: SideSource = {
            rootPath: joinRoot(repo.prefix, draft.path),
            oldRootPath: draft.oldPath === null ? null : joinRoot(repo.prefix, draft.oldPath),
            changeType: draft.changeType,
            untracked: draft.untracked,
        };
        const file: FileDiff = {
            fileId: `${diffId}:${draft.path}`,
            path: draft.path,
            oldPath: draft.oldPath,
            changeType: draft.changeType,
            binary: draft.binary,
            // Host review rules are not reproduced locally: there is nothing to dim.
            generated: false,
            additions: draft.additions,
            deletions: draft.deletions,
            patch: draft.patch,
            viewed: null,
            blameUrl: null,
            hostFileUrl: null,
            image: await imageOf(repo, probe.base, draft.path, sides, blobs),
        };
        files.push(file);
        entries.set(file.fileId, { file, ...sides });
        fileIdByPath.set(draft.path, file.fileId);
        fileHashByPath.set(draft.path, draft.fileHash);
    }

    return {
        diffId,
        baseCommit: probe.base,
        baseRef: probe.baseRef,
        // The working tree has no head commit: the diff itself identifies the reviewed side.
        headCommit: diffId,
        createdAt,
        branch: probe.info.branch,
        login: probe.info.login,
        stamp: probe.stamp,
        files,
        entries,
        fileIdByPath,
        fileHashByPath,
        blobs,
        iterationFiles,
        textBlobs,
    };
}

/**
 * New side of a tracked file for iteration history. The patch was taken earlier, in one diff at the start
 * of the snapshot, but contents are read now, and an agent or editor may rewrite the file in between.
 * Return a file whose mark differs from the check as missing: recording its text
 * would put a patch for one state and contents from another into one iteration. A slice using that
 * pair would show a changed file as unchanged and carry its viewed mark over.
 *
 * No `expected` mark means the check did not list the file as changed. Compare marks before and
 * after reading instead: this covers the file traversal, the longest part of the window.
 */
async function stableNewSide(absPath: string, expected: string | undefined): Promise<FileBytes> {
    const before = expected ?? (await markOf(absPath));
    const content = await readFileBytes(absPath, MAX_FILE_BYTES);
    if (content.kind !== 'bytes') {
        return content;
    }
    return (await markOf(absPath)) === before ? content : { kind: 'missing' };
}

/**
 * File as seen by iteration history: how its new side is represented and where its text lives.
 * Store text in blobs addressed by sha256 so identical file versions are not duplicated. No text means
 * `blob: null`, and a slice for this file shows no patch.
 */
function historyFileOf(draft: FileDraft, textBlobs: Map<string, Uint8Array>): LocalIterationFile {
    // A side over the size limit takes precedence over binary status: it was not read and has no text.
    const kind = draft.newSide.kind === 'oversized' ? 'oversized' : draft.binary ? 'binary' : 'text';
    let blob: string | null = null;
    if (kind === 'text' && draft.newSide.kind === 'bytes') {
        blob = hashOf(draft.newSide.bytes);
        textBlobs.set(blob, draft.newSide.bytes);
    }
    return { path: draft.path, changeType: draft.changeType, kind, hash: draft.fileHash, blob };
}

/** File contents: either bytes or the reason they are unavailable. */
export type FileBytes =
    | { readonly kind: 'bytes'; readonly bytes: Buffer }
    /** Side absent entirely: left of an added file, right of a deleted file, or a file missing from disk. */
    | { readonly kind: 'missing' }
    /** Side over the size limit: do not load it into memory. `mark` represents it in the diff fingerprint. */
    | { readonly kind: 'oversized'; readonly size: number; readonly mark: string };

/**
 * Contents of a file side. Propagate VCS read failures as errors: an absent side is a property
 * of the file itself, and a failed command must not pretend to be one.
 */
export async function readSideBytes(
    repo: LocalRepo,
    base: string,
    source: SideSource,
    side: 'old' | 'new',
    limit = MAX_FILE_BYTES,
): Promise<FileBytes> {
    if (side === 'new') {
        return source.changeType === 'delete'
            ? { kind: 'missing' }
            : readFileBytes(path.join(repo.root, source.rootPath), limit);
    }
    if (source.untracked || source.changeType === 'add') {
        return { kind: 'missing' };
    }

    const bytes = await repo.vcs.show(base, source.oldRootPath ?? source.rootPath);
    return bytes.length > limit
        ? { kind: 'oversized', size: bytes.length, mark: String(bytes.length) }
        : { kind: 'bytes', bytes };
}

interface FileDraft {
    readonly path: string;
    readonly oldPath: string | null;
    readonly changeType: FileChangeType;
    readonly binary: boolean;
    readonly patch: string | null;
    readonly additions: number;
    readonly deletions: number;
    readonly untracked: boolean;
    /** Fingerprint of what the reviewer sees at this path: the patch itself, not the side contents. */
    readonly fileHash: string;
    /**
     * New-side contents for iteration history. `missing` means the side is absent, binary
     * or could not be verified (`stableNewSide`).
     */
    readonly newSide: FileBytes;
}

/** sha256 of the file's representation in the diff. */
function hashOf(content: string | Uint8Array): string {
    return createHash('sha256').update(content).digest('hex');
}

function trackedDraft(
    entry: NameStatusEntry,
    chunk: string | null,
    binary: boolean,
    newSide: FileBytes,
): FileDraft {
    const patch = binary ? null : chunk;
    const stats = patch === null ? { additions: 0, deletions: 0 } : countPatchStats(patch);
    return {
        path: entry.path,
        oldPath: entry.oldPath,
        changeType: entry.changeType,
        binary,
        patch,
        additions: stats.additions,
        deletions: stats.deletions,
        untracked: false,
        // For a binary file this is the `Binary files … differ` line, the only thing visible in the UI.
        fileHash: hashOf(chunk ?? ''),
        newSide,
    };
}

/**
 * Untracked file over the size limit: there is nothing to display, but it must stay in the diff
 * so the reviewer sees that it appeared. With the same `binary: true` used for binary files, the UI says
 * "contents not shown".
 */
function oversizedDraft(file: string, side: Extract<FileBytes, { kind: 'oversized' }>): FileDraft {
    return {
        path: file,
        oldPath: null,
        changeType: 'add',
        binary: true,
        patch: null,
        additions: 0,
        deletions: 0,
        untracked: true,
        // Contents were not read: represent the file by the same size and mtime as in the diff fingerprint.
        fileHash: hashOf(side.mark),
        newSide: side,
    };
}

function untrackedDraft(file: string, content: Buffer): FileDraft {
    const patch = synthesizeAddPatch(file, content);
    const stats = patch === null ? { additions: 0, deletions: 0 } : countPatchStats(patch);
    return {
        path: file,
        oldPath: null,
        changeType: 'add',
        binary: patch === null,
        patch,
        additions: stats.additions,
        deletions: stats.deletions,
        untracked: true,
        // A binary file has no patch: its own bytes represent it.
        fileHash: hashOf(patch ?? content),
        newSide: patch === null ? { kind: 'missing' } : { kind: 'bytes', bytes: content },
    };
}

/**
 * Detect an image file by path extension, as other hosts do. Read side bytes
 * here too: the UI knows each side's size before requesting it, and `blobId` addresses the contents.
 */
async function imageOf(
    repo: LocalRepo,
    base: string,
    filePath: string,
    source: SideSource,
    blobs: Map<string, Uint8Array>,
): Promise<FileImage | null> {
    const mime = imageMimeOf(filePath);
    if (mime === null) {
        return null;
    }
    return {
        mime,
        before: sideOf(await imageSideBytes(repo, base, source, 'old'), blobs),
        after: sideOf(await imageSideBytes(repo, base, source, 'new'), blobs),
    };
}

/**
 * Image-side bytes. The limit here comes from the contract: the UI would not request a side larger
 * than `IMAGE_BLOB_MAX_BYTES`. A read failure hides the image without failing the snapshot.
 */
async function imageSideBytes(
    repo: LocalRepo,
    base: string,
    source: SideSource,
    side: 'old' | 'new',
): Promise<FileBytes> {
    try {
        return await readSideBytes(repo, base, source, side, IMAGE_BLOB_MAX_BYTES);
    } catch {
        return { kind: 'missing' };
    }
}

/** Image side from its bytes. `blobId` addresses the contents, so cache the bytes by it. */
function sideOf(content: FileBytes, blobs: Map<string, Uint8Array>): ImageSide | null {
    // Side absent or over the limit: there is no blob, and its id must not be invented because it addresses bytes.
    if (content.kind !== 'bytes') {
        return null;
    }
    const blobId = createHash('sha256').update(content.bytes).digest('hex');
    blobs.set(blobId, new Uint8Array(content.bytes));
    return { blobId, size: content.bytes.length };
}

/** One path, one record: `--name-status` produces no duplicates, but a diff with them would be invalid. */
function dedupeByPath(entries: readonly NameStatusEntry[]): NameStatusEntry[] {
    const byPath = new Map<string, NameStatusEntry>();
    for (const entry of entries) {
        byPath.set(entry.path, entry);
    }
    return [...byPath.values()];
}

/**
 * Untracked files in the project directory, as listed by the VCS: directory expansion and
 * ignore rules remain its responsibility. Fail if the file count exceeds the limit: silently truncating the list
 * would remove some new files from review without the reviewer knowing.
 */
function untrackedFilesOf(repo: LocalRepo, status: VcsStatus): string[] {
    const files: string[] = [];

    for (const rootPath of status.untracked) {
        const local = withinProject(repo.prefix, rootPath);
        if (local !== null) {
            files.push(local);
        }
    }

    if (files.length > MAX_UNTRACKED_FILES) {
        const kind = repo.vcs.kind;
        throw new Error(
            `the project directory has ${String(files.length)} untracked files, ` +
                `more than the ${String(MAX_UNTRACKED_FILES)} Sherpa reviews at once; ` +
                `add them to ${kind} or to .${kind}ignore, ` +
                'or point `sherpa up --local <path>` at a narrower directory',
        );
    }
    return files.sort((left, right) => left.localeCompare(right));
}

/** Checkout-relative path → project-relative path. null means the file is outside the project directory. */
function withinProject(prefix: string, rootPath: string): string | null {
    if (prefix === '') {
        return rootPath;
    }
    return rootPath.startsWith(`${prefix}/`) ? rootPath.slice(prefix.length + 1) : null;
}

function joinRoot(prefix: string, localPath: string): string {
    return prefix === '' ? localPath : `${prefix}/${localPath}`;
}

/**
 * File fingerprint for a cheap check. Use mtime and size together: a file can change within one millisecond
 * (editor, agent), and a change in length is visible even with the same mtime.
 */
async function markOf(absPath: string): Promise<string> {
    try {
        const stats = await fs.stat(absPath);
        return `${String(stats.mtimeMs)}:${String(stats.size)}`;
    } catch {
        return 'none';
    }
}

/** Read file contents from disk: check size before reading to avoid loading an entire dump into memory. */
async function readFileBytes(absPath: string, limit: number): Promise<FileBytes> {
    let size: number;
    let mtimeMs: number;
    try {
        ({ size, mtimeMs } = await fs.stat(absPath));
    } catch {
        return { kind: 'missing' };
    }
    if (size > limit) {
        return { kind: 'oversized', size, mark: `${String(size)} ${String(mtimeMs)}` };
    }

    try {
        return { kind: 'bytes', bytes: await fs.readFile(absPath) };
    } catch {
        return { kind: 'missing' };
    }
}
