import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';
import { expect, test as base } from '@playwright/test';
import { FakeWorker } from '@sherpa/cli/fake-worker';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const UI_DIST = path.join(REPO_ROOT, 'packages/ui/dist');
/** `global-setup` builds the CLI bundle. The fake worker uses the same artifact as production. */
const CLI_BUNDLE = path.join(REPO_ROOT, 'packages/cli/dist/sherpa.mjs');
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;

type FixturePrKey = 'fixture-medium' | 'fixture-large' | 'fixture-huge' | 'fixture-empty';

export interface SherpaServerHandle {
    readonly prKey: FixturePrKey;
    readonly sherpaDir: string;
    readonly url: string;
    /** This server's agent session, using the same shell commands the model calls in the harness. */
    readonly worker: FakeWorker;
    readonly stop: () => Promise<void>;
}

export interface LaunchOptions {
    /**
     * Shared state root for several servers, used to check that global settings
     * apply across all PRs. The test creates and removes the directory. The fixture leaves it alone.
     */
    readonly sherpaDir?: string;
    /** Distribution directory (`--install-dir`): determines the update command in the toast (M5-T9). */
    readonly installDir?: string;
    /**
     * The onboarding tour (M5-T8) starts for users who have not completed it, which means
     * any clean state root. It would interfere with specs for everything else, so by default
     * the fixture marks the tour complete. `'pending'` leaves the clean root as is.
     */
    readonly onboarding?: 'done' | 'pending';
}

type LaunchSherpa = (prKey: FixturePrKey, options?: LaunchOptions) => Promise<SherpaServerHandle>;

interface SherpaFixtures {
    readonly launchSherpa: LaunchSherpa;
}

/** Playwright fixture: each server gets its own temporary root and normal SIGTERM teardown. */
export const test = base.extend<SherpaFixtures>({
    launchSherpa: async ({ browserName: _browserName }, use) => {
        const handles: SherpaServerHandle[] = [];
        await use(async (prKey, options) => {
            const handle = await startSherpaServer(prKey, options);
            handles.push(handle);
            return handle;
        });
        for (const handle of handles.reverse()) {
            await handle.stop();
        }
    },
});

export { expect };

/** Server bearer token, stored in the fragment of the URL printed by `sherpa up`. */
export function sherpaToken(server: SherpaServerHandle): string {
    const token = new URLSearchParams(new URL(server.url).hash.slice(1)).get('t');
    if (token === null || token === '') {
        throw new Error(`no token in the fragment of ${server.url}`);
    }
    return token;
}

/** Headers for calling server endpoints directly, bypassing the UI and using the same token. */
export function sherpaAuth(server: SherpaServerHandle): Record<string, string> {
    return { Authorization: `Bearer ${sherpaToken(server)}` };
}

/**
 * Dev endpoint `POST /api/dev/fixture/advance-iteration` (`UI_DEV_ENDPOINTS`): the fixture PR
 * "receives a push", making the next declared iteration active. It leaves the tab alone.
 * The iteration change reaches it over SSE.
 */
export async function advanceIteration(page: Page, server: SherpaServerHandle): Promise<void> {
    const url = new URL('/api/dev/fixture/advance-iteration', server.url).href;
    const response = await page.request.post(url, { headers: sherpaAuth(server) });
    expect(response.status(), await response.text()).toBe(200);
}

/**
 * Dev endpoint `POST /api/dev/update-available` (`UI_DEV_ENDPOINTS`): the fixture server "learns"
 * about a new version in main. No network calls are made, since checks are disabled for fixtures.
 */
export async function announceUpdate(
    page: Page,
    server: SherpaServerHandle,
    update: { version: string; whatsNew: string | null; releasedAt: string | null },
): Promise<void> {
    const url = new URL('/api/dev/update-available', server.url).href;
    const response = await page.request.post(url, { headers: sherpaAuth(server), data: update });
    expect(response.status(), await response.text()).toBe(200);
}

/** URL fragment parameter. The UI stores iteration selection and filters there. */
export function fragmentParam(page: Page, key: string): Promise<string | null> {
    return page.evaluate((name) => new URLSearchParams(location.hash.slice(1)).get(name), key);
}

/** Diff file as seen by a test. The contract describes the full response, tests need only a few fields. */
export interface DiffFileSummary {
    readonly fileId: string;
    readonly path: string;
}

/**
 * Iteration diff fetched without the UI. Without `diffId`, use the active iteration. With it, use the named iteration's saved patch
 * (after a force-push, this is all that remains, since the host no longer has the iteration).
 */
export async function diffOf(
    page: Page,
    server: SherpaServerHandle,
    diffId?: string,
): Promise<readonly DiffFileSummary[]> {
    const url = new URL('/api/ui/review/diff', server.url);
    if (diffId !== undefined) {
        url.searchParams.set('diffId', diffId);
    }
    const response = await page.request.get(url.href, { headers: sherpaAuth(server) });
    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as {
        readonly diff: { readonly files: readonly DiffFileSummary[] };
    };
    return body.diff.files;
}

/** A read file range, with its side and line bounds named as in the contract. */
export interface SeenRange {
    readonly side: 'old' | 'new';
    readonly start: number;
    readonly end: number;
}

export interface FileProgress {
    readonly fileId: string;
    readonly viewed: boolean | null;
    readonly seenRanges: readonly SeenRange[];
}

export interface ReviewProgress {
    readonly files: readonly FileProgress[];
    /** Stop marks from this iteration's latest snapshot. If absent, no snapshot was built for it. */
    readonly stops: readonly { readonly stopId: string; readonly viewed: boolean }[];
}

/** Iteration reading progress fetched without the UI. Without `diffId`, use the active iteration. */
export async function progressOf(
    page: Page,
    server: SherpaServerHandle,
    diffId?: string,
): Promise<ReviewProgress> {
    const url = new URL('/api/ui/review/progress', server.url);
    if (diffId !== undefined) {
        url.searchParams.set('diffId', diffId);
    }
    const response = await page.request.get(url.href, { headers: sherpaAuth(server) });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as ReviewProgress;
}

/**
 * Read ranges of an iteration keyed by file path. Each iteration has its own `fileId`, so this is the only way
 * to compare progress across iterations.
 */
export async function seenRangeKeys(
    page: Page,
    server: SherpaServerHandle,
    diffId: string,
): Promise<string[]> {
    const paths = new Map((await diffOf(page, server, diffId)).map((file) => [file.fileId, file.path]));
    return (await progressOf(page, server, diffId)).files
        .flatMap((file) =>
            file.seenRanges.map(
                (range) =>
                    `${paths.get(file.fileId) ?? file.fileId}:${range.side}:${String(range.start)}-${String(range.end)}`,
            ),
        )
        .sort();
}

async function startSherpaServer(prKey: FixturePrKey, options?: LaunchOptions): Promise<SherpaServerHandle> {
    const ownsSherpaDir = options?.sherpaDir === undefined;
    const sherpaDir = options?.sherpaDir ?? (await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-')));
    if (options?.onboarding !== 'pending') {
        await seedOnboardingDone(sherpaDir);
    }
    const workDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-work-'));
    const child = spawn(
        'pnpm',
        [
            '--filter',
            '@sherpa/server',
            'dev',
            '--pr',
            prKey,
            '--sherpa-dir',
            sherpaDir,
            '--ui',
            UI_DIST,
            ...(options?.installDir === undefined ? [] : ['--install-dir', options.installDir]),
        ],
        {
            cwd: REPO_ROOT,
            stdio: ['pipe', 'pipe', 'pipe'],
        },
    );

    try {
        const url = await readUiUrl(child);
        let stopped = false;
        return {
            prKey,
            sherpaDir,
            url,
            worker: new FakeWorker({ bundlePath: CLI_BUNDLE, sherpaDir, prKey, workDir }),
            stop: async () => {
                if (stopped) {
                    return;
                }
                stopped = true;
                try {
                    await stopChild(child);
                } finally {
                    if (ownsSherpaDir) {
                        await rm(sherpaDir, { recursive: true, force: true });
                    }
                    await rm(workDir, { recursive: true, force: true });
                }
            },
        };
    } catch (error) {
        await stopChild(child).catch(() => undefined);
        if (ownsSherpaDir) {
            await rm(sherpaDir, { recursive: true, force: true });
        }
        await rm(workDir, { recursive: true, force: true });
        throw error;
    }
}

/**
 * Mark the tour complete in `<sherpaDir>/settings.json`. Leave an existing file alone, since this is a second
 * server for the same "user", and the first server wrote its settings.
 */
async function seedOnboardingDone(sherpaDir: string): Promise<void> {
    const settings = { onboarding: { completedAt: '2026-01-01T00:00:00.000Z', step: 0 } };
    try {
        await writeFile(path.join(sherpaDir, 'settings.json'), `${JSON.stringify(settings, null, 4)}\n`, {
            flag: 'wx',
            mode: 0o600,
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
    }
}

function readUiUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            fail(`The server did not print the UI URL within ${String(START_TIMEOUT_MS)} ms`);
        }, START_TIMEOUT_MS);

        const cleanup = (): void => {
            clearTimeout(timer);
            child.stdout.off('data', onStdout);
            child.stderr.off('data', onStderr);
            child.off('error', onError);
            child.off('exit', onExit);
        };
        const succeed = (url: string): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(url);
        };
        const fail = (message: string): void => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(new Error(`${message}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        };
        const onStdout = (chunk: Buffer): void => {
            stdout += chunk.toString('utf8');
            const match = /UI:\s+(http:\/\/127\.0\.0\.1:\d+\/#t=[^\s]+)/.exec(stdout);
            if (match?.[1] !== undefined) {
                succeed(match[1]);
            }
        };
        const onStderr = (chunk: Buffer): void => {
            stderr += chunk.toString('utf8');
        };
        const onError = (error: Error): void => {
            fail(`Failed to start the server: ${error.message}`);
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
            fail(`The server exited before it was ready: code=${String(code)} signal=${String(signal)}`);
        };

        child.stdout.on('data', onStdout);
        child.stderr.on('data', onStderr);
        child.once('error', onError);
        child.once('exit', onExit);
    });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }

    child.kill('SIGTERM');
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`The server did not exit within ${String(STOP_TIMEOUT_MS)} ms after SIGTERM`));
        }, STOP_TIMEOUT_MS);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
