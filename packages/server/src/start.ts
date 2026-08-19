import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { ServerManifest } from '@sherpa/protocol';

import { ServerAlreadyRunningError } from './errors.js';
import { formatUiUrl, hasExited, readOption, resolveUiDir, terminateChild, UI_BUILD_HINT } from './launch.js';
import { cleanStaleManifests, isManifestServerAlive, readManifest } from './manifest.js';
import {
    assertValidPrKey,
    DEFAULT_SHERPA_DIR,
    ensurePrivateDir,
    manifestPathFor,
    prStateDirOf,
    serversDirOf,
} from './paths.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';

/** How long to wait for the daemon to publish a live manifest. */
const STARTUP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 200;

/** Number of log lines to show when the daemon fails to start. */
const LOG_TAIL_LINES = 20;

const USAGE = 'Usage: start --pr <PR key> [--sherpa-dir <path>] [--ui <dist path>]';

/** Spawned daemon and its spawn error, which arrives asynchronously as a separate event. */
interface Daemon {
    readonly process: ChildProcess;
    spawnError: Error | null;
}

/**
 * Starts the server for the skill: `pnpm --filter @sherpa/server start --pr <key>`.
 * Idempotent: finds a live server for this PR through the manifest (rpc-design §8) and reuses it,
 * otherwise launches a daemon that survives the command exit. Both cases print the UI link to stdout.
 * The internal `--daemon` mode is the server itself, started by the launcher.
 */
async function main(argv: readonly string[]): Promise<number> {
    const prKey = readOption(argv, '--pr');
    if (prKey === null) {
        process.stderr.write(`${USAGE}\n`);
        return 1;
    }
    try {
        assertValidPrKey(prKey);
    } catch (error) {
        process.stderr.write(`${messageOf(error)}\n`);
        return 1;
    }

    // The daemon inherits the launcher's cwd, so resolve the relative state path to an absolute path here.
    const sherpaDir = path.resolve(readOption(argv, '--sherpa-dir') ?? DEFAULT_SHERPA_DIR);
    const uiOption = readOption(argv, '--ui');

    return argv.includes('--daemon')
        ? runDaemon(prKey, sherpaDir, uiOption)
        : runLauncher(prKey, sherpaDir, uiOption);
}

async function runLauncher(prKey: string, sherpaDir: string, uiOption: string | null): Promise<number> {
    // Cleaning up stale manifests is the skill launcher's responsibility (rpc-design §8).
    await cleanStaleManifests(serversDirOf(sherpaDir));

    const manifestPath = manifestPathFor(sherpaDir, prKey);
    const running = await readManifest(manifestPath);
    if (running !== null && (await isManifestServerAlive(running))) {
        printReady(`server for PR ${prKey} is already running (PID ${String(running.pid)})`, running);
        return 0;
    }

    // The skill needs a UI. Fail immediately instead of starting a server with nothing to show.
    let uiDir: string | null;
    try {
        uiDir = await resolveUiDir(uiOption);
    } catch (error) {
        process.stderr.write(`sherpa: ${messageOf(error)}\n`);
        return 1;
    }
    if (uiDir === null) {
        process.stderr.write(`sherpa: UI is not built. ${UI_BUILD_HINT}.\n`);
        return 1;
    }

    const logPath = await prepareLogPath(sherpaDir, prKey);
    const daemon = await spawnDaemon(prKey, sherpaDir, uiDir, logPath);

    const manifest = await waitForLiveManifest(manifestPath, daemon);
    if (manifest === null) {
        // Without a manifest, neither the next launch nor a person can find this daemon. Terminate it here.
        const reaped = await terminateChild(daemon.process);
        const lines = [`sherpa: server for PR ${prKey} did not start within ${String(STARTUP_TIMEOUT_MS / 1000)} s.`];
        if (daemon.spawnError !== null) {
            lines.push(`Could not start the process: ${daemon.spawnError.message}`);
        }
        if (!reaped && daemon.process.pid !== undefined) {
            lines.push(`Process ${String(daemon.process.pid)} has not exited. Terminate it manually.`);
        }
        lines.push(`Log: ${logPath}`, await readLogTail(logPath), '');
        process.stderr.write(lines.join('\n'));
        return 1;
    }

    printReady(`server for PR ${prKey} started (PID ${String(manifest.pid)}, log ${logPath})`, manifest);
    return 0;
}

/** Readiness: a human-readable line and a stable UI link line for the skill to show. */
function printReady(status: string, manifest: ServerManifest): void {
    process.stdout.write([`sherpa: ${status}`, formatUiUrl(manifest.port, manifest.token), ''].join('\n'));
}

/**
 * Respawns itself with `--daemon`, passing `process.execArgv`. Otherwise, running under tsx
 * would lose the loader and the daemon would fail to read TypeScript.
 */
async function spawnDaemon(prKey: string, sherpaDir: string, uiDir: string, logPath: string): Promise<Daemon> {
    const entry = process.argv[1] ?? import.meta.filename;
    const args = [
        ...process.execArgv,
        entry,
        '--daemon',
        '--pr',
        prKey,
        '--sherpa-dir',
        sherpaDir,
        '--ui',
        uiDir,
    ];

    const log = await fs.open(logPath, 'a');
    try {
        // Daemon stdio goes to a log file. It outlives the launcher, and nobody reads the daemon's stdio.
        const child = spawn(process.execPath, args, {
            detached: true,
            stdio: ['ignore', log.fd, log.fd],
        });
        const daemon: Daemon = { process: child, spawnError: null };
        // Without a listener, the 'error' event (e.g. ENOENT for execPath) would crash the launcher with an exception.
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
async function waitForLiveManifest(manifestPath: string, daemon: Daemon): Promise<ServerManifest | null> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await delay(POLL_INTERVAL_MS);

        const manifest = await readManifest(manifestPath);
        if (manifest !== null && (await isManifestServerAlive(manifest))) {
            return manifest;
        }
        if (hasExited(daemon.process) || daemon.spawnError !== null) {
            return null;
        }
    }
    return null;
}

async function prepareLogPath(sherpaDir: string, prKey: string): Promise<string> {
    const stateDir = prStateDirOf(sherpaDir, prKey);
    await ensurePrivateDir(sherpaDir, stateDir);
    return path.join(stateDir, 'server.log');
}

async function readLogTail(logPath: string): Promise<string> {
    let text: string;
    try {
        text = await fs.readFile(logPath, 'utf8');
    } catch {
        return '(log is empty)';
    }
    return text.split('\n').slice(-LOG_TAIL_LINES).join('\n').trim();
}

/**
 * The server itself: runs until SIGINT/SIGTERM, logs the port and events.
 * The log has no token because the file outlives the server. The launcher prints the link with the token.
 */
async function runDaemon(prKey: string, sherpaDir: string, uiOption: string | null): Promise<number> {
    let server: SherpaServer;
    try {
        const uiDir = await resolveUiDir(uiOption);
        server = await startServer(uiDir === null ? { prKey, sherpaDir } : { prKey, sherpaDir, uiDir });
    } catch (error) {
        // Two launchers raced. Another server has already claimed the manifest, so this daemon exits.
        const prefix = error instanceof ServerAlreadyRunningError ? 'not starting' : 'startup error';
        writeLog(`${prefix}: ${messageOf(error)}`);
        return 1;
    }

    writeLog(
        `start: PR ${server.prKey}, port ${String(server.port)}, PID ${String(process.pid)}, ` +
            `manifest ${manifestPathFor(sherpaDir, server.prKey)}`,
    );

    const stop = (signal: NodeJS.Signals): void => {
        writeLog(`${signal}: shutting down`);
        void server
            .close()
            .then(() => {
                process.exitCode = 0;
            })
            .catch((error: unknown) => {
                writeLog(`shutdown error: ${messageOf(error)}`);
                process.exitCode = 1;
            });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    return 0;
}

function writeLog(text: string): void {
    process.stdout.write(`${new Date().toISOString()} sherpa-server: ${text}\n`);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const code = await main(process.argv.slice(2));
if (code !== 0) {
    process.exitCode = code;
}
