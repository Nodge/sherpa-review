import fs from 'node:fs/promises';
import path from 'node:path';

import type { FileChangeType } from '@sherpa/protocol';
import { fileChangeTypeSchema } from '@sherpa/protocol';
import { z } from 'zod';

/**
 * Local review iteration history. Working trees have no record of past iterations outside our
 * storage: each new snapshot is appended here, and this history supplies the slice between two
 * iterations (for carrying over progress, note anchors and affected stops).
 *
 * Disk layout under `~/.sherpa/prs/<key>/local-iterations/`: `index.json` lists iterations,
 * and `blobs/<sha256>` holds new-side text file content. Blobs are content-addressed,
 * so identical file versions are not duplicated, and a file unchanged between iterations
 * is stored once.
 */

/** History file and directory permissions match the rest of the state (`docs/architecture.md §6`). */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * History limit: keep this many iterations, drop the rest from the index and delete their blobs.
 * A working-tree review lasts hours, with an iteration for every edit. Without a limit,
 * the directory would grow throughout the review, and nobody needs a slice with the hundred-thousandth iteration.
 */
export const MAX_LOCAL_ITERATIONS = 100;

/** Per-process write counter to give temporary files distinct names. */
let writeSequence = 0;

/** New-side representation: text, binary content or size over the limit. */
export type LocalIterationFileKind = 'text' | 'binary' | 'oversized';

export interface LocalIterationFile {
    readonly path: string;
    readonly changeType: FileChangeType;
    readonly kind: LocalIterationFileKind;
    /** File fingerprint in the diff (snapshot `fileHash`): tells whether this particular file changed. */
    readonly hash: string;
    /** sha256 of new-side content, the blob address. Null if the new side is absent or not text. */
    readonly blob: string | null;
}

/** One working-tree iteration: metadata and enough file information to compute a slice. */
export interface LocalIterationRecord {
    readonly diffId: string;
    readonly baseCommit: string;
    readonly headCommit: string;
    readonly createdAt: string;
    readonly files: readonly LocalIterationFile[];
}

/** Iteration history for one local review. Tests substitute an in-memory store. */
export interface LocalIterationsStore {
    /** History in creation order. The last entry is the active iteration. */
    read(): Promise<LocalIterationRecord[]>;
    /** Appends an iteration and returns history after writing, within the limit and without unused blobs. */
    append(record: LocalIterationRecord, blobs: ReadonlyMap<string, Uint8Array>): Promise<LocalIterationRecord[]>;
    /** New-side text by blob address. Null if the history has no such blob. */
    blob(hash: string): Promise<string | null>;
}

const fileSchema = z.object({
    path: z.string().min(1),
    changeType: fileChangeTypeSchema,
    kind: z.enum(['text', 'binary', 'oversized']),
    hash: z.string().min(1),
    blob: z.string().min(1).nullable(),
});

const indexSchema = z.array(
    z.object({
        diffId: z.string().min(1),
        baseCommit: z.string().min(1),
        headCommit: z.string().min(1),
        createdAt: z.iso.datetime(),
        files: z.array(fileSchema),
    }),
);

/**
 * History after appending an iteration: if the same `diffId` exists (an edit was reverted), remove the old
 * entry and append the new one. Otherwise the list would have two iterations with one id, which the server
 * uses to key everything: progress, snapshots and note anchors.
 */
export function appendToHistory(
    history: readonly LocalIterationRecord[],
    record: LocalIterationRecord,
): LocalIterationRecord[] {
    const kept = history.filter((known) => known.diffId !== record.diffId);
    return [...kept, record].slice(-MAX_LOCAL_ITERATIONS);
}

/** Blob addresses referenced by history. Everything else in `blobs/` is garbage. */
function referencedBlobs(history: readonly LocalIterationRecord[]): Set<string> {
    const referenced = new Set<string>();
    for (const record of history) {
        for (const file of record.files) {
            if (file.blob !== null) {
                referenced.add(file.blob);
            }
        }
    }
    return referenced;
}

/**
 * File-backed history. Write the index atomically (temporary file and `rename`), and blobs before the index:
 * cleanup can handle an orphaned blob, but an index entry pointing to an unwritten blob would break
 * the slice. If the index cannot be read or fails its schema, throw an error with the path instead of starting over:
 * an empty list would erase history on the first write.
 */
export function fileIterationsStore(dir: string): LocalIterationsStore {
    const indexPath = path.join(dir, 'index.json');
    const blobsDir = path.join(dir, 'blobs');
    const blobPath = (hash: string): string => path.join(blobsDir, hash);

    const read = async (): Promise<LocalIterationRecord[]> => {
        let raw: string;
        try {
            raw = await fs.readFile(indexPath, 'utf8');
        } catch (error) {
            // No index yet means no history. Propagate any other read failure: `append`
            // starts with `read`, and an empty list in place of an unreadable index would erase history.
            if (!isMissing(error)) {
                throw error;
            }
            return [];
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new Error(`${indexPath} is not valid JSON — move the directory aside to start over`);
        }
        const index = indexSchema.safeParse(parsed);
        if (!index.success) {
            throw new Error(`${indexPath} does not match the local iteration history format`);
        }
        return index.data;
    };

    return {
        read,
        append: async (record, blobs) => {
            const next = appendToHistory(await read(), record);
            await fs.mkdir(blobsDir, { recursive: true, mode: DIR_MODE });

            for (const file of record.files) {
                const bytes = file.blob === null ? undefined : blobs.get(file.blob);
                if (file.blob === null || bytes === undefined) {
                    continue;
                }
                await writeAtomic(blobPath(file.blob), Buffer.from(bytes));
            }
            await writeAtomic(indexPath, Buffer.from(`${JSON.stringify(next, null, 2)}\n`));

            // Clean up after writing the index: a blob with no references is no longer needed.
            const referenced = referencedBlobs(next);
            let stored: string[];
            try {
                stored = await fs.readdir(blobsDir);
            } catch {
                stored = [];
            }
            for (const name of stored) {
                if (!referenced.has(name)) {
                    await fs.rm(path.join(blobsDir, name), { force: true });
                }
            }
            return next;
        },
        blob: async (hash) => {
            try {
                return await fs.readFile(blobPath(hash), 'utf8');
            } catch {
                return null;
            }
        },
    };
}

/** Whether the read failure means "file absent" rather than "could not read". */
function isMissing(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Writes the whole file via an adjacent temporary file and `rename`, with explicit permissions. */
async function writeAtomic(filePath: string, content: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
    writeSequence += 1;
    const temporary = `${filePath}.${String(process.pid)}.${String(writeSequence)}.tmp`;
    try {
        await fs.writeFile(temporary, content, { mode: FILE_MODE });
        // writeFile applies mode subject to umask, so set the permissions explicitly afterwards.
        await fs.chmod(temporary, FILE_MODE);
        await fs.rename(temporary, filePath);
    } catch (error) {
        await fs.rm(temporary, { force: true });
        throw error;
    }
}

/** In-memory store: tests can recreate a host with the same history. */
export function memoryIterationsStore(initial: readonly LocalIterationRecord[] = []): LocalIterationsStore {
    let history = [...initial];
    const blobs = new Map<string, string>();

    return {
        read: () => Promise.resolve(history.map((record) => structuredClone(record))),
        append: (record, incoming) => {
            history = appendToHistory(history, structuredClone(record));
            for (const file of record.files) {
                const bytes = file.blob === null ? undefined : incoming.get(file.blob);
                if (file.blob !== null && bytes !== undefined) {
                    blobs.set(file.blob, Buffer.from(bytes).toString('utf8'));
                }
            }
            const referenced = referencedBlobs(history);
            for (const hash of [...blobs.keys()]) {
                if (!referenced.has(hash)) {
                    blobs.delete(hash);
                }
            }
            return Promise.resolve(history.map((known) => structuredClone(known)));
        },
        blob: (hash) => Promise.resolve(blobs.get(hash) ?? null),
    };
}
