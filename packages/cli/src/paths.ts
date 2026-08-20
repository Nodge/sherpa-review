import os from 'node:os';
import path from 'node:path';

import { prKeySchema } from '@sherpa/protocol';

import { CliError } from './errors.js';

export function assertValidPrKey(prKey: string): string {
    if (!prKeySchema.safeParse(prKey).success) {
        throw new CliError(
            `sherpa: invalid PR key ${JSON.stringify(prKey)}.\n` +
                'Expected `<host>-<pr>` using letters, digits, dots, hyphens and underscores.',
        );
    }
    return prKey;
}

/** Sherpa state root: `SHERPA_DIR` for tests and development runs, otherwise `~/.sherpa`. */
export function sherpaDirFrom(env: Readonly<Record<string, string | undefined>>): string {
    return sherpaDirOverrideFrom(env) ?? path.join(os.homedir(), '.sherpa');
}

/**
 * Only an explicit state directory override, without a default. `up` needs it: the server does not read `SHERPA_DIR`,
 * so without passing `--sherpa-dir` it would write state somewhere other than where the CLI looks for it.
 */
export function sherpaDirOverrideFrom(env: Readonly<Record<string, string | undefined>>): string | undefined {
    const override = env.SHERPA_DIR?.trim();
    return override === undefined || override === '' ? undefined : override;
}

/** Discovery manifest written by the server (rpc-design §8). */
export function manifestPathFor(sherpaDir: string, prKey: string): string {
    return path.join(sherpaDir, 'servers', `${assertValidPrKey(prKey)}.json`);
}

/** The worker session identity lives in a PR state file because env does not survive separate harness calls. */
export function workerIdPathFor(sherpaDir: string, prKey: string): string {
    return path.join(sherpaDir, 'prs', assertValidPrKey(prKey), 'worker-id');
}
