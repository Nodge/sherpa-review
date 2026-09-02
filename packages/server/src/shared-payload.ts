import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { PrDiff } from '@sherpa/protocol';

import type { TaskRecord } from './queue.js';

/**
 * Shared task context (decision log 2026-09-02). Anything unchanged between tasks, such as the PR diff, file
 * text or a guide, is written once at a stable path under `payload/shared/`. The task directory
 * holds only task-specific data. The path itself signals sharing: the model can tell from it whether it has read this
 * file in this session. The protocol stays the same: tasks carry the same `contextFiles`.
 *
 * Tasks stay self-contained (rpc-design §4): the file is on disk, its path is in the task, and
 * a new session reads it as usual.
 *
 * Writes are synchronous. Files are written only a few times per session, and the synchronous path costs less than a state machine
 * around it. Writes are idempotent ("if it exists, don't overwrite it") and atomic (a temporary file plus
 * `rename`), so a task never receives a partially written file.
 */

/** Directory and file permissions match the rest of the payload (spec §6). */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Hash in the name: 8 hex digits distinguish text versions without making the path long. */
const HASH_LENGTH = 8;
/** Readable part of the filename. A hash follows anyway, and path length is finite. */
const NAME_LENGTH = 60;

export type FileSide = 'old' | 'new';

/** Shared diff key: the PR commit pair. A new push means a new key and directory. */
export function diffKeyOf(diff: PrDiff): string {
    return `${safeSegment(diff.baseCommit)}-${safeSegment(diff.headCommit)}`;
}

/**
 * Whether a task holds its payload: an open task is reading it, and the holder of a cancelled task doesn't yet know
 * about the cancellation (rpc-design §5) and may still finish reading. Everything else can be cleaned up.
 */
export function holdsPayload(task: TaskRecord): boolean {
    return task.status === 'queued' || task.status === 'leased' || task.workerId !== null;
}

export class SharedPayloadStore {
    private readonly sharedDir: string;
    /** Context paths for tasks still being read. Cleanup leaves their diff keys alone. */
    private readonly openContextFiles: () => Iterable<string>;
    /** Key of the last written diff: a key change triggers cleanup. */
    private diffKey: string | null = null;

    constructor(sharedDir: string, openContextFiles: () => Iterable<string>) {
        this.sharedDir = sharedDir;
        this.openContextFiles = openContextFiles;
    }

    /** Guide addressed by content hash. New server text won't give an old session the old path. */
    guide(name: string, content: string): string {
        const file = path.join(this.sharedDir, 'guides', `${name}-${hashOf(content)}.md`);
        this.write(file, content);
        return file;
    }

    /** Shared PR diff used by `route.skeleton`, `route.section` and unanchored chat questions. */
    prDiff(key: string, content: string): string {
        const file = path.join(this.diffDirOf(key), 'pr-diff.md');
        this.write(file, content);
        return file;
    }

    /** Full text for one file side. Two anchored questions about the same file share a path. */
    fileSide(key: string, fileId: string, side: FileSide, content: string): string {
        const file = path.join(this.diffDirOf(key), 'files', `${safeName(fileId)}.${side}.md`);
        this.write(file, content);
        return file;
    }

    /**
     * Removes diff directories that nothing references anymore. Tasks read their diffs to the end:
     * the route caches the diff per process, so queued sections can easily reference a different
     * key from a fresh chat question. Deleting everything except the current key is unsafe.
     *
     * `keepKey` is being materialized right now: its task is not yet in the queue.
     */
    sweepDiffKeys(keepKey?: string): void {
        const keep = this.referencedDiffKeys(this.openContextFiles());
        if (keepKey !== undefined) {
            keep.add(keepKey);
        }

        const root = path.join(this.sharedDir, 'diff');
        let entries: string[];
        try {
            entries = fs.readdirSync(root);
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!keep.has(entry)) {
                fs.rmSync(path.join(root, entry), { recursive: true, force: true });
            }
        }
    }

    /** Directory for a key. Changing the active key also cleans up keys no longer needed. */
    private diffDirOf(key: string): string {
        if (this.diffKey !== key) {
            this.sweepDiffKeys(key);
            this.diffKey = key;
        }
        return path.join(this.sharedDir, 'diff', key);
    }

    /** Diff keys referenced by the listed paths. Skips unrelated paths. */
    private referencedDiffKeys(contextFiles: Iterable<string>): Set<string> {
        const root = path.join(this.sharedDir, 'diff');
        const keys = new Set<string>();
        for (const file of contextFiles) {
            const relative = path.relative(root, file);
            if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
                continue;
            }
            const [key] = relative.split(path.sep);
            if (key !== undefined && key !== '') {
                keys.add(key);
            }
        }
        return keys;
    }

    private write(file: string, content: string): void {
        const dir = path.dirname(file);
        this.makeDir(dir);
        // A shared path is shared across time too. A file under a key is written once and never touched again.
        if (fs.existsSync(file)) {
            return;
        }

        const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
        fs.writeFileSync(temp, content, { mode: FILE_MODE });
        try {
            fs.renameSync(temp, file);
        } catch (error) {
            fs.rmSync(temp, { force: true });
            throw error;
        }
    }

    private makeDir(dir: string): void {
        fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
        // mkdir applies mode through umask, and the directories may already exist.
        let current = this.sharedDir;
        fs.chmodSync(current, DIR_MODE);
        for (const segment of path.relative(this.sharedDir, dir).split(path.sep)) {
            if (segment === '') {
                continue;
            }
            current = path.join(current, segment);
            fs.chmodSync(current, DIR_MODE);
        }
    }
}

function hashOf(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, HASH_LENGTH);
}

/** Filename from an external identifier: a readable part plus a hash of the original string. */
function safeName(id: string): string {
    return `${safeSegment(id).slice(0, NAME_LENGTH)}-${hashOf(id)}`;
}

function safeSegment(value: string): string {
    return value.replaceAll(/[^A-Za-z0-9._-]/g, '_');
}
