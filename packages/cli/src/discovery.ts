import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ServerManifest } from '@sherpa/protocol';
import { serverManifestSchema } from '@sherpa/protocol';

import type { CommandRunner } from './command.js';
import { runCommand } from './command.js';
import { CliError } from './errors.js';
import type { CliHostPlugin } from './hosts/plugin.js';
import { assertValidPrKey, manifestPathFor, sherpaDirFrom, workerIdPathFor } from './paths.js';

/** Everything the CLI needs to call the PR server. */
export interface ServerConnection {
    readonly prKey: string;
    readonly port: number;
    readonly token: string;
    readonly workerId: string;
}

/** Worker identity file permissions match the rest of the state (`docs/architecture.md §6`). */
const WORKER_ID_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;

/** Full discovery (`docs/protocol.md §8`): PR → manifest → port and token, plus worker identity. */
export async function connect(
    prKeyArg: string | undefined,
    env: Readonly<Record<string, string | undefined>>,
    hosts: readonly CliHostPlugin[],
    run?: CommandRunner,
): Promise<ServerConnection> {
    const prKey = await resolvePrKey(prKeyArg, env, hosts, run);
    const sherpaDir = sherpaDirFrom(env);
    const workerId = await resolveWorkerId(sherpaDir, prKey, env);

    return openConnection(sherpaDir, prKey, workerId);
}

/**
 * Connection with an explicit identity for `worker register`. The session declares the id, and the server
 * writes it to the state file after accepting registration. Otherwise two parallel sessions would race to write there.
 */
export async function connectAs(
    prKeyArg: string | undefined,
    env: Readonly<Record<string, string | undefined>>,
    workerId: string,
    hosts: readonly CliHostPlugin[],
    run?: CommandRunner,
): Promise<ServerConnection> {
    const prKey = await resolvePrKey(prKeyArg, env, hosts, run);
    return openConnection(sherpaDirFrom(env), prKey, workerId);
}

async function openConnection(sherpaDir: string, prKey: string, workerId: string): Promise<ServerConnection> {
    const manifest = await readServerManifest(sherpaDir, prKey);
    return { prKey, port: manifest.port, token: manifest.token, workerId };
}

/**
 * PR key: `--pr` → `SHERPA_PR` → current branch PR from plugins with `discoverPr`, in list order.
 * Explicit sources take priority over discovery. The session may have started from a different directory,
 * so a discovered PR must not silently replace the supplied one.
 */
export async function resolvePrKey(
    prKeyArg: string | undefined,
    env: Readonly<Record<string, string | undefined>>,
    hosts: readonly CliHostPlugin[],
    run: CommandRunner = runCommand,
): Promise<string> {
    const explicit = (prKeyArg ?? env.SHERPA_PR ?? '').trim();
    if (explicit !== '') {
        return assertValidPrKey(normalizePrKey(explicit, hosts));
    }

    const hints: string[] = [];
    const suggestions: string[] = [];
    for (const host of hosts) {
        if (host.discoverPr === undefined) {
            continue;
        }
        const discovered = await host.discoverPr.discover(run);
        if (discovered.kind === 'found') {
            return assertValidPrKey(discovered.prKey);
        }
        hints.push(discovered.hint);
        suggestions.push(host.discoverPr.suggestion);
    }
    throw new CliError(unclearWhichPr(hints, suggestions));
}

/**
 * A PR link or number also identifies a PR. The first plugin to recognize it converts it
 * to a key before any checks, and the session then uses the normalized key. If no plugin
 * recognizes it, the value stays as is: a ready-made key or an error that validation will catch.
 */
function normalizePrKey(value: string, hosts: readonly CliHostPlugin[]): string {
    for (const host of hosts) {
        const key = host.normalizeKey?.(value) ?? null;
        if (key !== null) {
            return key;
        }
    }
    return value;
}

/** Failed discovery asks the user for input, with reasons and ways to respond. */
function unclearWhichPr(hints: readonly string[], suggestions: readonly string[]): string {
    const tried =
        hints.length === 0
            ? 'Sherpa cannot detect the PR of the current directory.\n'
            : `Tried to detect it from the current directory: ${hints.join('; ')}.\n`;
    const ways = [
        'Run the command through the Sherpa skill (it fills the PR in)',
        'pass `--pr <pr key>`',
        ...suggestions,
    ];
    return (
        'sherpa: it is unclear which PR to connect to.\n' +
        tried +
        `${ways.slice(0, -1).join(', ')}, or ${ways.at(-1) ?? ''}.`
    );
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
        `sherpa: could not write ${filePath} — ${detail}.\n` +
        'Check the permissions on the Sherpa state directory and run the command again.'
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

function isAlreadyExists(error: unknown): boolean {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

export function serverUnavailable(prKey: string): string {
    return (
        `sherpa: the Sherpa server for PR ${prKey} is not found or not responding.\n` +
        'Run the Sherpa skill again — it will start the server and write the manifest.'
    );
}
