import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test as base } from '@playwright/test';
import { FakeWorker } from '@sherpa/cli/fake-worker';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const UI_DIST = path.join(REPO_ROOT, 'packages/ui/dist');
/** `global-setup` builds the CLI bundle. The fake worker uses the same artifact as production. */
const CLI_BUNDLE = path.join(REPO_ROOT, 'packages/cli/dist/sherpa.mjs');
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;

type FixturePrKey = 'fixture-medium' | 'fixture-large';

export interface SherpaServerHandle {
    readonly prKey: FixturePrKey;
    readonly sherpaDir: string;
    readonly url: string;
    /** This server's agent session, using the same shell commands the model calls in the harness. */
    readonly worker: FakeWorker;
    readonly stop: () => Promise<void>;
}

type LaunchSherpa = (prKey: FixturePrKey) => Promise<SherpaServerHandle>;

interface SherpaFixtures {
    readonly launchSherpa: LaunchSherpa;
}

/** Playwright fixture: each server gets its own temporary root and normal SIGTERM teardown. */
export const test = base.extend<SherpaFixtures>({
    launchSherpa: async ({ browserName: _browserName }, use) => {
        const handles: SherpaServerHandle[] = [];
        await use(async (prKey) => {
            const handle = await startSherpaServer(prKey);
            handles.push(handle);
            return handle;
        });
        for (const handle of handles.reverse()) {
            await handle.stop();
        }
    },
});

export { expect };

async function startSherpaServer(prKey: FixturePrKey): Promise<SherpaServerHandle> {
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-'));
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
                    await rm(sherpaDir, { recursive: true, force: true });
                    await rm(workDir, { recursive: true, force: true });
                }
            },
        };
    } catch (error) {
        await stopChild(child).catch(() => undefined);
        await rm(sherpaDir, { recursive: true, force: true });
        await rm(workDir, { recursive: true, force: true });
        throw error;
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
