import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

/**
 * An "idempotency key → comment ID" map. GitHub does not support retry keys, and Sherpa's draft
 * buffer retries writes minutes later and survives server restarts, so
 * the adapter keeps the mapping itself.
 *
 * Storage contains derived data. If reading or writing fails, a retry creates a second comment
 * at worst. The review does not fail because of it.
 */

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** Entry limit. The draft buffer lives for one PR, so nothing will retry old keys. */
const MAX_ENTRIES = 500;

const storeSchema = z.record(z.string(), z.string());

export interface IdempotencyStore {
    get(key: string): string | null;
    set(key: string, commentId: string): void;
}

/** In-memory storage for tests and any host without a state directory. */
export function memoryIdempotencyStore(): IdempotencyStore {
    const entries = new Map<string, string>();
    return {
        get: (key) => entries.get(key) ?? null,
        set: (key, commentId) => {
            entries.set(key, commentId);
        },
    };
}

/** File storage at `~/.sherpa/prs/<key>/github-drafts.json` (0600, atomic write). */
export function fileIdempotencyStore(filePath: string): IdempotencyStore {
    let entries: Map<string, string> | null = null;

    const load = (): Map<string, string> => {
        entries ??= new Map(Object.entries(read(filePath)));
        return entries;
    };

    return {
        get: (key) => load().get(key) ?? null,
        set: (key, commentId) => {
            const loaded = load();
            loaded.delete(key);
            loaded.set(key, commentId);
            while (loaded.size > MAX_ENTRIES) {
                const oldest = loaded.keys().next();
                if (oldest.done === true) {
                    break;
                }
                loaded.delete(oldest.value);
            }
            write(filePath, loaded);
        },
    };
}

function read(filePath: string): Record<string, string> {
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch {
        return {};
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    const store = storeSchema.safeParse(parsed);
    return store.success ? store.data : {};
}

function write(filePath: string, entries: ReadonlyMap<string, string>): void {
    const temporary = `${filePath}.${String(process.pid)}.tmp`;
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
        fs.writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`, {
            mode: FILE_MODE,
        });
        // writeFileSync respects umask and applies mode only on creation, so set it explicitly afterwards.
        fs.chmodSync(temporary, FILE_MODE);
        fs.renameSync(temporary, filePath);
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        process.stderr.write(
            `sherpa-server: could not write the GitHub draft retry map: ${messageOf(error)}\n`,
        );
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
