import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { ServerManifest } from '@sherpa/protocol';

import { readManifestFile } from './discovery.js';
import { CliError } from './errors.js';
import { formatUiUrl } from './format.js';
import { manifestPathFor, serverLogPathFor } from './paths.js';

/** The server bundle is a sibling file in the skill directory, beside the CLI itself. */
const SERVER_BIN_NAME = 'sherpa-server.mjs';

/** How long to wait for the daemon to publish a live manifest. */
const STARTUP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

/** Liveness probe for the adjacent server. It is a local request, so a longer wait buys nothing. */
const HEALTH_PROBE_TIMEOUT_MS = 1_000;

/** Number of log lines to show when the daemon fails to start. */
const LOG_TAIL_LINES = 20;

/** State directory permissions: only the owner can see its contents (requirements §6). */
const STATE_DIR_MODE = 0o700;

/** How long to wait for exit after each signal in `terminateChild`. */
const TERMINATE_GRACE_MS = 2_000;
const EXIT_POLL_INTERVAL_MS = 20;

export interface EnsureServerOptions {
    readonly prKey: string;
    /** State root: the server does not read `SHERPA_DIR`. The CLI passes it the path. */
    readonly sherpaDir: string;
    /** Path to the running CLI file (`process.argv[1]`): the server bundle is beside it. */
    readonly entry: string | undefined;
    /** Explicit server bundle path from `SHERPA_SERVER_BIN`, for development scenarios. */
    readonly serverBin?: string | undefined;
    /** How long to wait for manifest publication. Shortened in tests. */
    readonly startupTimeoutMs?: number;
}

/** Spawned daemon and its spawn error, which arrives asynchronously as a separate event. */
interface Daemon {
    readonly process: ChildProcess;
    spawnError: Error | null;
}

/**
 * Ensures the PR server is running and returns a UI link for the reviewer. Idempotent: a live server for this PR
 * is found through the manifest (rpc-design §8) and reused, otherwise the server bundle starts as a daemon
 * that outlives the CLI. Neither pnpm nor a repository checkout is required.
 */
export async function ensureServer(options: EnsureServerOptions): Promise<string> {
    const manifestPath = manifestPathFor(options.sherpaDir, options.prKey);

    const running = await readManifestFile(manifestPath);
    if (running !== null && running.prKey === options.prKey && (await isManifestServerAlive(running))) {
        return formatUiUrl(running.port, running.token);
    }

    const serverBin = await resolveServerBin(options.entry, options.serverBin);
    const logPath = await prepareLogPath(options.sherpaDir, options.prKey);
    const daemon = await spawnDaemon(serverBin, options, logPath);

    const timeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    const manifest = await waitForLiveManifest(manifestPath, options.prKey, daemon, timeoutMs);
    if (manifest === null) {
        // Without a manifest, neither the next launch nor a person can find this daemon. Terminate it here.
        const reaped = await terminateChild(daemon.process);
        throw new CliError(await startupFailed(options.prKey, daemon, logPath, timeoutMs, reaped));
    }

    return formatUiUrl(manifest.port, manifest.token);
}

/**
 * Server bundle path. Normally a sibling file in the skill directory. The real path is resolved
 * through realpath because the skill directory is installed as a symlink (`~/.claude/skills/sherpa`).
 * `SHERPA_SERVER_BIN` overrides discovery for development runs and tests.
 */
export async function resolveServerBin(entry: string | undefined, override: string | undefined): Promise<string> {
    if (override !== undefined && override.trim() !== '') {
        const explicit = path.resolve(override.trim());
        if (!(await isFile(explicit))) {
            throw new CliError(
                `sherpa: SHERPA_SERVER_BIN points at ${explicit}, but there is no file there.\n` +
                    'Fix the path or unset the variable to take the server from the skill directory.',
            );
        }
        return explicit;
    }

    const neighbour = await neighbourServerBin(entry);
    if (neighbour === null || !(await isFile(neighbour))) {
        throw new CliError(INCOMPLETE_DISTRIBUTION);
    }
    return neighbour;
}

async function neighbourServerBin(entry: string | undefined): Promise<string | null> {
    if (entry === undefined || entry.trim() === '') {
        return null;
    }
    try {
        return path.join(path.dirname(await fs.realpath(entry)), SERVER_BIN_NAME);
    } catch {
        return null;
    }
}

/**
 * The manifest server really is running: its PID is alive AND `/healthz` responds with the same prKey
 * using the manifest token (otherwise anyone could own the port). The server uses the same check.
 */
export async function isManifestServerAlive(manifest: ServerManifest): Promise<boolean> {
    if (!isProcessAlive(manifest.pid)) {
        return false;
    }

    try {
        const response = await fetch(`http://127.0.0.1:${String(manifest.port)}/healthz`, {
            headers: { authorization: `Bearer ${manifest.token}` },
            signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
        });
        if (!response.ok) {
            return false;
        }

        const body: unknown = await response.json();
        return isRecord(body) && body.ok === true && body.prKey === manifest.prKey;
    } catch {
        return false;
    }
}

/** Checks whether a PID is alive. Signal 0 sends nothing and only checks for existence. */
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: the process exists but belongs to someone else. For this check, it counts as alive.
        return error instanceof Error && 'code' in error && error.code === 'EPERM';
    }
}

/**
 * Server daemon: detached + unref so it outlives the CLI. stdio goes to a log file,
 * which nothing reads at runtime, but the user can inspect when the server fails to start.
 * No token in the log: the CLI reads the manifest and builds the link with the token.
 */
async function spawnDaemon(serverBin: string, options: EnsureServerOptions, logPath: string): Promise<Daemon> {
    const args = [serverBin, '--pr', options.prKey, '--sherpa-dir', options.sherpaDir];

    const log = await fs.open(logPath, 'a');
    try {
        const child = spawn(process.execPath, args, {
            detached: true,
            stdio: ['ignore', log.fd, log.fd],
        });
        const daemon: Daemon = { process: child, spawnError: null };
        // Without a listener, an 'error' event (such as ENOENT on execPath) would crash the CLI with an exception.
        child.once('error', (error: Error) => {
            daemon.spawnError = error;
        });
        child.unref();
        return daemon;
    } finally {
        // spawn duplicated the descriptor into the child process. Our copy can now close.
        await log.close();
    }
}

/** Waits for the daemon to publish a manifest and answer `/healthz`. No point waiting if it died or failed to start. */
async function waitForLiveManifest(
    manifestPath: string,
    prKey: string,
    daemon: Daemon,
    timeoutMs: number,
): Promise<ServerManifest | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await delay(POLL_INTERVAL_MS);

        const manifest = await readManifestFile(manifestPath);
        if (manifest !== null && manifest.prKey === prKey && (await isManifestServerAlive(manifest))) {
            return manifest;
        }
        if (hasExited(daemon.process) || daemon.spawnError !== null) {
            return null;
        }
    }
    return null;
}

async function startupFailed(
    prKey: string,
    daemon: Daemon,
    logPath: string,
    timeoutMs: number,
    reaped: boolean,
): Promise<string> {
    const lines = [`sherpa: the server for PR ${prKey} did not start within ${String(Math.round(timeoutMs / 1000))} s.`];
    if (daemon.spawnError !== null) {
        lines.push(`The process could not be started: ${daemon.spawnError.message}`);
    }
    if (!reaped && daemon.process.pid !== undefined) {
        lines.push(`Process ${String(daemon.process.pid)} did not exit — kill it manually.`);
    }
    lines.push(
        `Log: ${logPath}`,
        await readLogTail(logPath),
        'Show this text to the user and stop — do not start the worker loop.',
    );
    return lines.join('\n');
}

async function prepareLogPath(sherpaDir: string, prKey: string): Promise<string> {
    const logPath = serverLogPathFor(sherpaDir, prKey);
    try {
        await fs.mkdir(path.dirname(logPath), { recursive: true, mode: STATE_DIR_MODE });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CliError(
            `sherpa: could not prepare the state directory for the log ${logPath} — ${detail}.\n` +
                'Check the permissions on the Sherpa state directory and call the command again.',
        );
    }
    return logPath;
}

/** Log tail: the error at the end matters, not the full launch history. */
async function readLogTail(logPath: string): Promise<string> {
    let text: string;
    try {
        text = await fs.readFile(logPath, 'utf8');
    } catch {
        return '(log is empty)';
    }
    const tail = text.split('\n').slice(-LOG_TAIL_LINES).join('\n').trim();
    return tail === '' ? '(the log is empty)' : tail;
}

/**
 * Terminates the child process with SIGTERM, then SIGKILL if it does not exit within the allotted time.
 * Needed for a daemon that never published a manifest: there is nothing to find it by later,
 * and a detached process outlives the CLI and keeps the port open.
 * Returns false if the process survives even SIGKILL.
 */
export async function terminateChild(child: ChildProcess, graceMs = TERMINATE_GRACE_MS): Promise<boolean> {
    if (hasExited(child)) {
        return true;
    }

    child.kill('SIGTERM');
    if (await waitForExit(child, graceMs)) {
        return true;
    }

    child.kill('SIGKILL');
    return waitForExit(child, graceMs);
}

/** unref detaches the process from the event loop, but exit events still reach us. */
export function hasExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!hasExited(child) && Date.now() < deadline) {
        await delay(EXIT_POLL_INTERVAL_MS);
    }
    return hasExited(child);
}

const INCOMPLETE_DISTRIBUTION =
    `sherpa: the skill distribution is incomplete — ${SERVER_BIN_NAME} must sit next to sherpa.mjs.\n` +
    'Reinstall the Sherpa skill as a whole (the directory with SKILL.md and bin/). ' +
    'Show this text to the user and stop — do not start the worker loop.';

async function isFile(filePath: string): Promise<boolean> {
    try {
        return (await fs.stat(filePath)).isFile();
    } catch {
        return false;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
