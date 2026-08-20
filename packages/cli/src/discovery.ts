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
    const workerId = await resolveWorkerId(sherpaDir, prKey, env);

    return openConnection(sherpaDir, prKey, workerId);
}

/**
 * Connects with an explicit identity for `worker register`. The state file is overwritten only
 * after the server accepts registration, otherwise a rejected session would erase the live one's id.
 */
export async function connectAs(
    prKeyArg: string | undefined,
    env: Readonly<Record<string, string | undefined>>,
    workerId: string,
): Promise<ServerConnection> {
    const prKey = resolvePrKey(prKeyArg, env);
    return openConnection(sherpaDirFrom(env), prKey, workerId);
}

async function openConnection(sherpaDir: string, prKey: string, workerId: string): Promise<ServerConnection> {
    const manifest = await readServerManifest(sherpaDir, prKey);
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
    const manifest = await readManifestFile(manifestPathFor(sherpaDir, prKey));
    if (manifest?.prKey !== prKey) {
        throw new CliError(serverUnavailable(prKey));
    }
    return manifest;
}

/** Manifest at a path. Missing, invalid and schema-invalid all return `null` (fail-closed). */
export async function readManifestFile(manifestPath: string): Promise<ServerManifest | null> {
    let raw: string;
    try {
        raw = await fs.readFile(manifestPath, 'utf8');
    } catch {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    const manifest = serverManifestSchema.safeParse(parsed);
    return manifest.success ? manifest.data : null;
}

/**
 * Fresh session identity for `worker register`. Reconnection means a new worker, so the previous session's id
 * from the file isn't reused. The debug `SHERPA_WORKER_ID` still takes priority. Otherwise register
 * would register one id while subsequent commands used another.
 */
export function freshWorkerId(env: Readonly<Record<string, string | undefined>>): string {
    return workerIdOverride(env) ?? randomUUID();
}

/**
 * Debug identity pinned through `SHERPA_WORKER_ID`. null means unset.
 * The pin overrides any CLI guesses. All session commands will use it.
 */
export function workerIdOverride(env: Readonly<Record<string, string | undefined>>): string | null {
    const override = env.SHERPA_WORKER_ID?.trim();
    return override === undefined || override === '' ? null : override;
}

/** Previous session's worker for this PR, read from the state file. null if absent. Does not create the file. */
export async function storedWorkerId(
    env: Readonly<Record<string, string | undefined>>,
    prKey: string,
): Promise<string | null> {
    return readWorkerIdFile(workerIdPathFor(sherpaDirFrom(env), prKey));
}

/** Saves the session worker. Other commands read the id here. */
export async function storeWorkerId(
    env: Readonly<Record<string, string | undefined>>,
    prKey: string,
    workerId: string,
): Promise<void> {
    const filePath = workerIdPathFor(sherpaDirFrom(env), prKey);
    try {
        await fs.mkdir(path.dirname(filePath), { recursive: true, mode: STATE_DIR_MODE });
        await writeWorkerIdFile(filePath, workerId);
    } catch (error) {
        throw new CliError(workerIdNotWritable(filePath, error));
    }
}

/**
 * Worker session identity: debug override from env, otherwise the PR state file.
 * Creates the file if missing, as the session may have started without `worker register`.
 */
export async function resolveWorkerId(
    sherpaDir: string,
    prKey: string,
    env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
    const override = workerIdOverride(env);
    if (override !== null) {
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
        throw new CliError(workerIdNotWritable(filePath, error));
    }
}

function workerIdNotWritable(filePath: string, error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    return (
        `sherpa: could not write ${filePath}: ${detail}.\n` +
        'Check permissions on the Sherpa state directory and run the command again.'
    );
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

/** Race-free overwrite: the server has accepted the id, and it is the only valid one for this session. */
async function writeWorkerIdFile(filePath: string, workerId: string): Promise<void> {
    await fs.writeFile(filePath, `${workerId}\n`, { mode: WORKER_ID_FILE_MODE });
    await fs.chmod(filePath, WORKER_ID_FILE_MODE);
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
