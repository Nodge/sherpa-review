import fs from 'node:fs/promises';
import path from 'node:path';

import type { AnchorPosition, ReviewUser, ThreadPin, Verdict } from '@sherpa/protocol';
import { anchorPositionSchema, reviewUserSchema, threadPinSchema, verdictSchema } from '@sherpa/protocol';
import { z } from 'zod';

/**
 * Local review comment storage. It has no remote host: threads live
 * in a PR state file (`~/.sherpa/prs/<key>/local-review.json`), or in memory in tests.
 */

/** Thread file permissions match the rest of the state (`docs/architecture.md §6`). */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Per-process write counter to give temporary files distinct names. */
let writeSequence = 0;

export interface LocalComment {
    id: string;
    /** Author: the checkout user for a reviewer, a bot with a model label for an agent reply. */
    author: ReviewUser;
    body: string;
    draft: boolean;
    createdAt: string;
    editedAt: string | null;
    /** Write retry key from the draft buffer. null means the write supplied none. */
    idempotencyKey: string | null;
    replies: LocalComment[];
}

export interface LocalAnchor {
    path: string;
    position: AnchorPosition | null;
}

export interface LocalThread {
    id: string;
    /** The anchor keeps path and position: `fileId` lasts one iteration and is recomputed when returned. */
    anchor: LocalAnchor | null;
    /** `fileId` at creation time, used when returning a thread whose path has left the active diff. */
    fileId: string | null;
    /** File fingerprint at creation time. null means a PR discussion with no file. */
    fileHash: string | null;
    resolved: boolean;
    resolvedBy: string | null;
    pinnedTo: ThreadPin | null;
    root: LocalComment;
}

/** Verdict from the last publication and the iteration where it was given. */
export interface LocalVerdict {
    verdict: Verdict;
    diffId: string;
}

/**
 * Publication round: a verdict and threads that received comments in this publication.
 * `pending` waits for the agent, `done` means the agent replied and left the round summary in `summary`.
 */
export interface LocalRound {
    id: string;
    verdict: Verdict;
    diffId: string;
    headCommit: string;
    createdAt: string;
    threadIds: string[];
    status: 'pending' | 'done';
    summary: string | null;
}

export interface LocalReviewData {
    /** Monotonic id counter for comments and rounds, preserved across restart in the file. */
    nextId: number;
    verdict: LocalVerdict | null;
    threads: LocalThread[];
    rounds: LocalRound[];
}

/** Access to threads of one local review, replaced with in-memory storage in tests. */
export interface LocalThreadsStore {
    read(): Promise<LocalReviewData>;
    write(data: LocalReviewData): Promise<void>;
}

/** Files written before `avatarUrl` lack the key: without `default` the schema would reject them. */
const localAuthorSchema = reviewUserSchema.extend({ avatarUrl: reviewUserSchema.shape.avatarUrl.default(null) });

const commentSchema: z.ZodType<LocalComment> = z.object({
    id: z.string().min(1),
    author: localAuthorSchema,
    body: z.string(),
    draft: z.boolean(),
    createdAt: z.iso.datetime(),
    editedAt: z.iso.datetime().nullable(),
    idempotencyKey: z.string().nullable(),
    get replies() {
        return z.array(commentSchema);
    },
});

const reviewDataSchema = z.object({
    nextId: z.number().int().min(1),
    verdict: z.object({ verdict: verdictSchema, diffId: z.string().min(1) }).nullable(),
    threads: z.array(
        z.object({
            id: z.string().min(1),
            anchor: z
                .object({ path: z.string().min(1), position: anchorPositionSchema.nullable() })
                .nullable(),
            fileId: z.string().min(1).nullable(),
            fileHash: z.string().min(1).nullable(),
            resolved: z.boolean(),
            resolvedBy: z.string().nullable(),
            pinnedTo: threadPinSchema.nullable(),
            root: commentSchema,
        }),
    ),
    rounds: z.array(
        z.object({
            id: z.string().min(1),
            verdict: verdictSchema,
            diffId: z.string().min(1),
            headCommit: z.string().min(1),
            createdAt: z.iso.datetime(),
            threadIds: z.array(z.string().min(1)),
            status: z.enum(['pending', 'done']),
            summary: z.string().nullable(),
        }),
    ),
});

export function emptyReviewData(): LocalReviewData {
    return { nextId: 1, verdict: null, threads: [], rounds: [] };
}

/**
 * File-backed threads. Write atomically with a temporary file alongside it and `rename`: half a JSON file on disk
 * would cost the reviewer all comments. If schema validation fails, report an error with the path instead of resetting:
 * silently overwriting someone else's text is worse than failing.
 */
export function fileThreadsStore(filePath: string): LocalThreadsStore {
    return {
        read: async () => {
            let raw: string;
            try {
                raw = await fs.readFile(filePath, 'utf8');
            } catch {
                return emptyReviewData();
            }

            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                throw new Error(`${filePath} is not valid JSON — move it aside to start the review over`);
            }
            const data = reviewDataSchema.safeParse(parsed);
            if (!data.success) {
                throw new Error(`${filePath} does not match the local review format`);
            }
            return data.data;
        },
        write: async (data) => {
            await fs.mkdir(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
            // Use a unique temporary filename for each write: two concurrent writes with a shared name
            // would take the file from each other, and the second would fail on `rename` after the file was moved.
            writeSequence += 1;
            const temporary = `${filePath}.${String(process.pid)}.${String(writeSequence)}.tmp`;
            try {
                await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: FILE_MODE });
                // writeFile applies mode subject to umask, so set permissions explicitly.
                await fs.chmod(temporary, FILE_MODE);
                await fs.rename(temporary, filePath);
            } catch (error) {
                await fs.rm(temporary, { force: true });
                throw error;
            }
        },
    };
}

/** In-memory storage: tests can recreate the host with the same state. */
export function memoryThreadsStore(initial: LocalReviewData = emptyReviewData()): LocalThreadsStore {
    let data = initial;
    return {
        read: () => Promise.resolve(structuredClone(data)),
        write: (next) => {
            data = structuredClone(next);
            return Promise.resolve();
        },
    };
}
