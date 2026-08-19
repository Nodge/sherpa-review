import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Default built UI: `packages/ui/dist` beside the server package. */
const DEFAULT_UI_DIR = path.resolve(import.meta.dirname, '../../ui/dist');

/** Shared instructions for a missing UI build, used in development launches, the skill and errors. */
export const UI_BUILD_HINT = 'build the UI: `pnpm --filter @sherpa/ui build`';

export function readOption(argv: readonly string[], name: string): string | null {
    const index = argv.indexOf(name);
    if (index === -1) {
        return null;
    }
    return argv[index + 1] ?? null;
}

/**
 * UI directory: an explicit `--ui` (fails if missing, so a typo does not pass silently)
 * or the default build, if it exists.
 */
export async function resolveUiDir(option: string | null): Promise<string | null> {
    if (option !== null) {
        const dir = path.resolve(option);
        if (!(await isDirectory(dir))) {
            throw new Error(`UI directory ${dir} does not exist. ${UI_BUILD_HINT}.`);
        }
        return dir;
    }
    return (await isDirectory(DEFAULT_UI_DIR)) ? DEFAULT_UI_DIR : null;
}

export async function isDirectory(dir: string): Promise<boolean> {
    try {
        return (await fs.stat(dir)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * The only line the skill shows the reviewer. Keep its format stable.
 * The token is in the fragment. It is not sent to the server but survives a page reload.
 */
export function formatUiUrl(port: number, token: string): string {
    return `UI: http://127.0.0.1:${String(port)}/#token=${token}`;
}

/** How long to wait for exit after each signal in `terminateChild`. */
const TERMINATE_GRACE_MS = 2_000;
const EXIT_POLL_INTERVAL_MS = 20;

/**
 * Terminates the child process with SIGTERM, then SIGKILL if it does not exit within the allotted time.
 * Needed for a daemon that never published a manifest. There is no way to find it later,
 * and a detached process will outlive the launcher and keep occupying the port.
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
