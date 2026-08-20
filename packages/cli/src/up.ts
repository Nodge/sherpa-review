import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CliError } from './errors.js';

/** Marker file for the Sherpa workspace root. */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

/** How long to wait for the startup command: it starts a daemon and returns immediately. */
const SERVER_START_TIMEOUT_MS = 60_000;

/** How long to wait after SIGTERM before killing a hung startup process. */
const KILL_GRACE_MS = 2_000;

/** Number of output lines to show when server startup fails. */
const OUTPUT_TAIL_LINES = 30;

/** Information the server startup command needs. */
export interface ServerStartOptions {
    /** Sherpa checkout root, from which the server package starts. */
    readonly root: string;
    readonly prKey: string;
    /** State directory from `SHERPA_DIR`, if set: the server does not read this variable itself. */
    readonly sherpaDir: string | undefined;
}

/** Server startup result: output is shown to the user unchanged, so stdout and stderr are merged. */
export interface ServerStartResult {
    readonly code: number;
    readonly output: string;
}

/** PR server startup, replaced in unit tests to avoid running real pnpm. */
export type ServerStarter = (options: ServerStartOptions) => Promise<ServerStartResult>;

/**
 * Finds the Sherpa checkout root from the CLI file. The bundle lives in `<root>/packages/{cli/dist,skill/bin}`,
 * and the skill directory is installed as a symlink (`~/.claude/skills/sherpa`), so first resolve the real path,
 * then walk up to the directory with `pnpm-workspace.yaml`.
 */
export async function findRepoRoot(entryPath: string | undefined): Promise<string> {
    if (entryPath === undefined || entryPath.trim() === '') {
        throw new CliError(NOT_IN_CHECKOUT);
    }

    let dir: string;
    try {
        dir = path.dirname(await fs.realpath(entryPath));
    } catch {
        throw new CliError(NOT_IN_CHECKOUT);
    }

    for (;;) {
        if (await isFile(path.join(dir, WORKSPACE_MARKER))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new CliError(NOT_IN_CHECKOUT);
        }
        dir = parent;
    }
}

/**
 * Starts the PR server and returns a string with the UI link.
 * The startup command is idempotent: it finds a live server for this PR through the manifest (rpc-design §8).
 */
export async function ensureServer(start: ServerStarter, options: ServerStartOptions): Promise<string> {
    const result = await start(options);
    if (result.code !== 0) {
        throw new CliError(
            `sherpa: could not start the Sherpa server for PR ${options.prKey}. Startup command output:\n` +
                `${tailOf(result.output)}\n` +
                'Show this text to the user and stop — do not start the worker loop.',
        );
    }

    const uiUrl = extractUiUrl(result.output);
    if (uiUrl === null) {
        throw new CliError(
            `sherpa: server for PR ${options.prKey} started, but its output has no UI link. ` +
                'CLI and server versions probably differ. Startup command output:\n' +
                `${tailOf(result.output)}\n` +
                'Update the Sherpa skill together with the server. Show this text to the user and stop.',
        );
    }
    return uiUrl;
}

/** UI link in server startup output: the stable `UI: <url>` line (see the server's `launch.ts`). */
export function extractUiUrl(output: string): string | null {
    return /^UI: (\S+)\s*$/mu.exec(output)?.[1] ?? null;
}

/** Command and timeout for server startup, replaced in timeout tests. */
export interface SpawnStartConfig {
    readonly command: string;
    readonly timeoutMs: number;
}

const PNPM_START: SpawnStartConfig = { command: 'pnpm', timeoutMs: SERVER_START_TIMEOUT_MS };

/** Real server startup: `pnpm -C <root> --filter @sherpa/server start --pr <key>`. */
export const spawnServerStart: ServerStarter = async (options) => spawnServerStartWith(options, PNPM_START);

/** The same startup with a replaceable command and timeout, for testing spawn errors. */
export const spawnServerStartWith = async (
    options: ServerStartOptions,
    config: SpawnStartConfig,
): Promise<ServerStartResult> => {
    const args = ['-C', options.root, '--filter', '@sherpa/server', 'start', '--pr', options.prKey];
    if (options.sherpaDir !== undefined) {
        args.push('--sherpa-dir', options.sherpaDir);
    }

    return new Promise<ServerStartResult>((resolve, reject) => {
        const child = spawn(config.command, args, { cwd: options.root, stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks: string[] = [];
        let settled = false;

        const collect = (chunk: Buffer): void => {
            chunks.push(chunk.toString('utf8'));
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);

        const settle = (action: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            action();
        };

        // Return the timeout response immediately, without waiting for `close`: pnpm may ignore
        // SIGTERM, and its child may keep inherited pipes open, so `close` may never fire.
        const timer: NodeJS.Timeout = setTimeout(() => {
            settle(() => {
                reject(new CliError(startTimedOut(options.prKey, chunks.join(''), config.timeoutMs)));
            });
            terminate(child);
        }, config.timeoutMs);

        child.once('error', (error: Error) => {
            settle(() => {
                reject(new CliError(spawnFailed(error, options.root)));
            });
        });
        child.once('close', (code: number | null) => {
            settle(() => {
                resolve({ code: code ?? 1, output: chunks.join('') });
            });
        });
    });
};

/** Terminates a hung startup process, gently first, then forcefully after a grace period so the CLI cannot wait forever. */
function terminate(child: ChildProcess): void {
    child.kill('SIGTERM');

    const hardKill = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    hardKill.unref();
    child.once('close', () => {
        clearTimeout(hardKill);
    });
}

const NOT_IN_CHECKOUT =
    'sherpa: could not find the Sherpa repository checkout: no directory above the CLI file has `pnpm-workspace.yaml`.\n' +
    'Run sherpa from a Sherpa repository checkout (`<root>/packages/skill/bin/sherpa.mjs`, ' +
    'a symlink to the skill directory also works).';

function spawnFailed(error: Error, root: string): string {
    return (
        `sherpa: could not start pnpm in ${root}: ${error.message}.\n` +
        'The Sherpa server starts through pnpm: install it (`npm i -g pnpm`) and run `pnpm install` ' +
        'in the Sherpa checkout. Show this text to the user and stop.'
    );
}

function startTimedOut(prKey: string, output: string, timeoutMs: number): string {
    return (
        `sherpa: server for PR ${prKey} did not start within ${String(Math.round(timeoutMs / 1000))} s. ` +
        `Startup command output:\n${tailOf(output)}\n` +
        'Show this text to the user and stop — do not start the worker loop.'
    );
}

/** Output tail: the model does not need long build logs, only the end with the error. */
function tailOf(output: string): string {
    const trimmed = output.trim();
    if (trimmed === '') {
        return '(no output)';
    }
    return trimmed.split('\n').slice(-OUTPUT_TAIL_LINES).join('\n');
}

async function isFile(filePath: string): Promise<boolean> {
    try {
        return (await fs.stat(filePath)).isFile();
    } catch {
        return false;
    }
}
