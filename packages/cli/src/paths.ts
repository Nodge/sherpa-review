import os from 'node:os';
import path from 'node:path';

import { prKeySchema } from '@sherpa/protocol';

import { CliError } from './errors.js';

export function assertValidPrKey(prKey: string): string {
    if (!prKeySchema.safeParse(prKey).success) {
        throw new CliError(
            `sherpa: invalid PR key ${JSON.stringify(prKey)}.\n` +
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
 * Explicit server bundle path from `SHERPA_SERVER_BIN`, undefined if unset.
 * Normally the server is a sibling file in the skill directory. The override is for development runs.
 */
export function serverBinOverrideFrom(env: Readonly<Record<string, string | undefined>>): string | undefined {
    const override = env.SHERPA_SERVER_BIN?.trim();
    return override === undefined || override === '' ? undefined : override;
}

/** Discovery manifest written by the server (rpc-design §8). */
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
