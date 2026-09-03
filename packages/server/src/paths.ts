import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { prKeySchema } from '@sherpa/protocol';

/** Default Sherpa state root, overridden in tests and development launches. */
export const DEFAULT_SHERPA_DIR = path.join(os.homedir(), '.sherpa');

/** State directory permissions: only the owner can read the contents (tokens, drafts, history) (spec §6). */
const DIR_MODE = 0o700;

export function assertValidPrKey(prKey: string): string {
    if (!prKeySchema.safeParse(prKey).success) {
        throw new Error(
            `Invalid PR key: ${JSON.stringify(prKey)}. ` +
                'Expected `<host>-<pr>` using letters, digits, dots, hyphens and underscores.',
        );
    }
    return prKey;
}

/**
 * Global UI settings (M3-T16): one file per user, next to `servers/` and `prs/`.
 * Shared across PRs: each PR server listens on a random port, leaving browser `localStorage` empty each time.
 */
export function settingsPathFor(sherpaDir: string): string {
    return path.join(sherpaDir, 'settings.json');
}

/**
 * Update check cache (M5-T9): one file per user next to settings.
 * Restarting servers for any PR must not hit the review host more than once every 30 minutes.
 */
export function updateCheckPathFor(sherpaDir: string): string {
    return path.join(sherpaDir, 'update-check.json');
}

/** Discovery manifest directory (rpc-design §8). */
export function serversDirOf(sherpaDir: string): string {
    return path.join(sherpaDir, 'servers');
}

/** State directory for one PR: SQLite file and anything added later (spec §1/C2). */
export function prStateDirOf(sherpaDir: string, prKey: string): string {
    return path.join(sherpaDir, 'prs', assertValidPrKey(prKey));
}

export function manifestPathFor(sherpaDir: string, prKey: string): string {
    return path.join(serversDirOf(sherpaDir), `${assertValidPrKey(prKey)}.json`);
}

export function databasePathFor(sherpaDir: string, prKey: string): string {
    return path.join(prStateDirOf(sherpaDir, prKey), 'sherpa.db');
}

/** PR task payload root. Route and chat writers get separate subdirectories. */
export function payloadDirOf(sherpaDir: string, prKey: string): string {
    return path.join(prStateDirOf(sherpaDir, prKey), 'payload');
}

/** Route generation payload: one removable subdirectory per generation. */
export function routePayloadDirOf(sherpaDir: string, prKey: string): string {
    return path.join(payloadDirOf(sherpaDir, prKey), 'route');
}

/** Chat question payload: a separate immutable subdirectory for each task. */
export function chatPayloadDirOf(sherpaDir: string, prKey: string): string {
    return path.join(payloadDirOf(sherpaDir, prKey), 'chat');
}

/**
 * Shared task context: content that stays the same between tasks (diff, files, guides) lives here
 * at a stable path, so the model can tell from the path that it has already read the file in this session.
 */
export function sharedPayloadDirOf(sherpaDir: string, prKey: string): string {
    return path.join(payloadDirOf(sherpaDir, prKey), 'shared');
}

/**
 * PR worker identity file: the server writes it at registration, and the CLI reads it because env does not
 * survive separate harness calls. The path must match `workerIdPathFor` in the CLI.
 */
export function workerIdPathFor(sherpaDir: string, prKey: string): string {
    return path.join(prStateDirOf(sherpaDir, prKey), 'worker-id');
}

/** Creates the directory and its parents, setting 0700 on each level within `sherpaDir`. */
export async function ensurePrivateDir(sherpaDir: string, dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });

    // mkdir applies mode with umask, and directories may already exist, so set permissions explicitly.
    for (const level of levelsWithin(sherpaDir, dir)) {
        await fs.chmod(level, DIR_MODE);
    }
}

/** Paths from `sherpaDir` (inclusive) to `dir` (inclusive). */
function levelsWithin(sherpaDir: string, dir: string): string[] {
    const relative = path.relative(sherpaDir, dir);
    const levels = [sherpaDir];
    if (relative === '' || relative.startsWith('..')) {
        return levels;
    }

    let current = sherpaDir;
    for (const segment of relative.split(path.sep)) {
        current = path.join(current, segment);
        levels.push(current);
    }
    return levels;
}
