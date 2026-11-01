import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Task } from '@sherpa/protocol';
import { prKeySchema } from '@sherpa/protocol';

import { CliError } from './errors.js';

export function assertValidPrKey(prKey: string): string {
    if (!prKeySchema.safeParse(prKey).success) {
        throw new CliError(
            `sherpa-review: invalid PR key ${JSON.stringify(prKey)}.\n` +
                'Expected the form `<host>-<pr>` made of letters, digits, dot, dash and underscore.',
        );
    }
    return prKey;
}

/** Sherpa state root: `SHERPA_DIR` for tests and development runs, otherwise `~/.sherpa`. */
export function sherpaDirFrom(env: Readonly<Record<string, string | undefined>>): string {
    return sherpaDirOverrideFrom(env) ?? path.join(os.homedir(), '.sherpa');
}

/** Explicit state root from `SHERPA_DIR`, without a default. undefined means unset. */
function sherpaDirOverrideFrom(env: Readonly<Record<string, string | undefined>>): string | undefined {
    const override = env.SHERPA_DIR?.trim();
    return override === undefined || override === '' ? undefined : override;
}

/**
 * Explicit server module path from `SHERPA_SERVER_BIN`. undefined means unset.
 * The server is normally a sibling file in the package's `bin/`. Development runs need the override. `up` also uses it
 * to pass the discovered module to the daemon.
 */
export function serverBinOverrideFrom(env: Readonly<Record<string, string | undefined>>): string | undefined {
    const override = env.SHERPA_SERVER_BIN?.trim();
    return override === undefined || override === '' ? undefined : override;
}

/** Discovery manifest written by the server (`docs/protocol.md §8`). */
export function manifestPathFor(sherpaDir: string, prKey: string): string {
    return path.join(sherpaDir, 'servers', `${assertValidPrKey(prKey)}.json`);
}

/** State directory for one PR: worker identity, server log and anything added later. */
function prStateDirOf(sherpaDir: string, prKey: string): string {
    return path.join(sherpaDir, 'prs', assertValidPrKey(prKey));
}

/**
 * Worker session identity lives in a PR state file because env doesn't survive separate harness calls.
 * The CLI reads it, and the server writes it at registration (`workerIdPathFor` in the server package). The path is shared.
 */
export function workerIdPathFor(sherpaDir: string, prKey: string): string {
    return path.join(prStateDirOf(sherpaDir, prKey), 'worker-id');
}

/** Server daemon log. The server writes it, the CLI reads it when the server fails to start. */
export function serverLogPathFor(sherpaDir: string, prKey: string): string {
    return path.join(prStateDirOf(sherpaDir, prKey), 'server.log');
}

/**
 * Result file root in the system temporary directory (`tmpRoot` is usually `os.tmpdir()`).
 * On Linux this is shared `/tmp`. uid in the name separates users, the CLI checks ownership and permissions itself.
 */
export function taskResultRootFor(tmpRoot: string): string {
    const uid = process.getuid?.();
    return path.join(tmpRoot, uid === undefined ? 'sherpa' : `sherpa-${String(uid)}`);
}

/**
 * Result directory for one worker session: a hash of the state root and workerId. Each server instance has
 * its own task numbering, so matching numbers from different sessions and servers don't end up in the same file.
 */
export function taskResultDirFor(tmpRoot: string, sherpaDir: string, prKey: string, workerId: string): string {
    const session = createHash('sha256').update(`${sherpaDir}\n${workerId}`).digest('hex').slice(0, 16);
    return path.join(taskResultRootFor(tmpRoot), assertValidPrKey(prKey), session);
}

/**
 * Result file for one task attempt in the session directory. The CLI assigns the path so sessions don't share
 * a file. `json` means the task has a result schema, otherwise the answer is markdown.
 */
export function taskResultFileFor(dir: string, task: Pick<Task, 'id' | 'attempt' | 'resultSchemaFile'>): string {
    const ext = task.resultSchemaFile === undefined ? 'md' : 'json';
    return path.join(dir, `${String(task.id)}-${String(task.attempt)}.${ext}`);
}
