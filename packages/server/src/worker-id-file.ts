import fs from 'node:fs';
import path from 'node:path';

import { RpcFailure } from './errors.js';

/** Identity file and state directory permissions match the rest of PR state (docs/architecture.md §6). */
const WORKER_ID_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;

/**
 * Publishes the slot owner to a PR state file: subsequent session calls read their identity
 * from it, because env does not survive between harness calls.
 *
 * The server writes the file, not the CLI: with slot takeover, both concurrent sessions
 * get a successful `register`, so the order of writes to the shared file would depend on the race between network
 * responses. The file could retain an evicted session id, while the winning slot would use
 * another id and hit `worker_conflict`. Here there is one writer, and the synchronous write runs in the same
 * endpoint immediately after claiming the slot, so write order matches registration order, and the
 * file is already correct by the time the response arrives.
 */
export function writeWorkerIdFile(filePath: string, workerId: string): void {
    try {
        // Server startup creates the PR state directory. Recreate it in case it was deleted under us.
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: STATE_DIR_MODE });
        fs.writeFileSync(filePath, `${workerId}\n`, { mode: WORKER_ID_FILE_MODE });
        // writeFileSync applies mode only when creating a file and subject to umask, so set permissions explicitly.
        fs.chmodSync(filePath, WORKER_ID_FILE_MODE);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new RpcFailure(
            'internal',
            // The CLI adds the next step based on the error code. Here, only state what happened and where to look.
            `The worker slot is taken by this session, but its identity file ${filePath} could not be ` +
                `written: ${detail}. Without it the next commands of this session would run under ` +
                'another identity — check the permissions on the Sherpa state directory.',
        );
    }
}
