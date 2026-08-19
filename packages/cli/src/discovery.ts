import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ServerManifest } from '@sherpa/protocol';
import { serverManifestSchema } from '@sherpa/protocol';

import { CliError } from './errors.js';
import { assertValidPrKey, manifestPathFor, sherpaDirFrom, workerIdPathFor } from './paths.js';

/** Everything the CLI needs to call the PR server. */
export interface ServerConnection {
    readonly prKey: string;
    readonly port: number;
    readonly token: string;
    readonly workerId: string;
}

/** Worker identity file permissions match the rest of the state (spec §6). */
const WORKER_ID_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;

/** Full discovery (rpc-design §8): PR → manifest → port and token, plus worker identity. */
export async function connect(
    prKeyArg: string | undefined,
    env: Readonly<Record<string, string | undefined>>,
): Promise<ServerConnection> {
    const prKey = resolvePrKey(prKeyArg, env);
    const sherpaDir = sherpaDirFrom(env);
    const manifest = await readServerManifest(sherpaDir, prKey);
    const workerId = await resolveWorkerId(sherpaDir, prKey, env);

    return { prKey, port: manifest.port, token: manifest.token, workerId };
}

/** PR comes from `--pr` or `SHERPA_PR`. Resolution from cwd arrives with the host adapter in M1. */
export function resolvePrKey(
    prKeyArg: string | undefined,
    env: Readonly<Record<string, string | undefined>>,
): string {
    const raw = (prKeyArg ?? env.SHERPA_PR ?? '').trim();
    if (raw === '') {
        throw new CliError(
            'sherpa: cannot determine which PR to connect to.\n' +
                'Run the command through the Sherpa skill (it supplies the PR) or pass `--pr <key>`.',
        );
    }
    return assertValidPrKey(raw);
}

/**
 * Server manifest. Any problem produces the same user-facing error: the manifest is missing,
 * invalid or for a different PR. Cleaning up stale manifests is the skill's job, not the CLI's.
 */
export async function readServerManifest(sherpaDir: string, prKey: string): Promise<ServerManifest> {
    const manifestPath = manifestPathFor(sherpaDir, prKey);

    let raw: string;
    try {
        raw = await fs.readFile(manifestPath, 'utf8');
    } catch {
        throw new CliError(serverUnavailable(prKey));
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new CliError(serverUnavailable(prKey));
    }

    const manifest = serverManifestSchema.safeParse(parsed);
    if (!manifest.success || manifest.data.prKey !== prKey) {
        throw new CliError(serverUnavailable(prKey));
    }
    return manifest.data;
}

/**
 * Worker session identity: debug override from env, otherwise the PR state file.
 * Creates the file if missing (in T6, `worker register` takes over writing, reading stays here).
 */
export async function resolveWorkerId(
    sherpaDir: string,
    prKey: string,
    env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
    const override = env.SHERPA_WORKER_ID?.trim();
    if (override !== undefined && override !== '') {
        return override;
    }

    const filePath = workerIdPathFor(sherpaDir, prKey);
    const stored = await readWorkerIdFile(filePath);
    if (stored !== null) {
        return stored;
    }

    try {
        return await createWorkerIdFile(filePath);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CliError(
            `sherpa: failed to write ${filePath}: ${detail}.\n` +
                'Check permissions on the Sherpa state directory and run the command again.',
        );
    }
}

/** null means the file is missing or empty (an unfinished write from the previous run). */
async function readWorkerIdFile(filePath: string): Promise<string | null> {
    try {
        const stored = (await fs.readFile(filePath, 'utf8')).trim();
        return stored === '' ? null : stored;
    } catch {
        return null;
    }
}

/**
 * Creates the file exclusively (`wx`). On the first run, several sessions may find no file at once,
 * and otherwise each would leave with its own id, while the last one stayed on disk. One
 * workerId would claim tasks and another would submit them. The loser of the race takes the winner's id.
 */
async function createWorkerIdFile(filePath: string): Promise<string> {
    const workerId = randomUUID();
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: STATE_DIR_MODE });

    try {
        await fs.writeFile(filePath, `${workerId}\n`, { mode: WORKER_ID_FILE_MODE, flag: 'wx' });
    } catch (error) {
        if (!isAlreadyExists(error)) {
            throw error;
        }
        const winner = await readWorkerIdFile(filePath);
        if (winner !== null) {
            return winner;
        }
        await fs.writeFile(filePath, `${workerId}\n`, { mode: WORKER_ID_FILE_MODE });
    }

    // writeFile applies mode only on creation and subject to umask. Set the permissions explicitly afterward.
    await fs.chmod(filePath, WORKER_ID_FILE_MODE);
    return workerId;
}

function isAlreadyExists(error: unknown): boolean {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

export function serverUnavailable(prKey: string): string {
    return (
        `sherpa: Sherpa server for PR ${prKey} was not found or is not responding.\n` +
        'Restart the Sherpa skill. It will start the server and write the manifest.'
    );
}
