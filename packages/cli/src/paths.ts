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
    const override = env.SHERPA_DIR?.trim();
    return override === undefined || override === '' ? path.join(os.homedir(), '.sherpa') : override;
}

/** Discovery manifest written by the server (rpc-design §8). */
export function manifestPathFor(sherpaDir: string, prKey: string): string {
    return path.join(sherpaDir, 'servers', `${assertValidPrKey(prKey)}.json`);
}

/** The worker session identity lives in a PR state file because env does not survive separate harness calls. */
export function workerIdPathFor(sherpaDir: string, prKey: string): string {
    return path.join(sherpaDir, 'prs', assertValidPrKey(prKey), 'worker-id');
}
