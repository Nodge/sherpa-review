import os from 'node:os';
import path from 'node:path';

import { CliError } from './errors.js';

/**
 * The PR key alphabet copies the server one (`packages/server/src/paths.ts`). The key is used
 * in state paths, so the CLI must validate it itself instead of relying on the server.
 */
const PR_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertValidPrKey(prKey: string): string {
    if (!PR_KEY_PATTERN.test(prKey)) {
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
