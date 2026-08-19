import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimManifest, isProcessAlive, readManifest } from './manifest.js';
import { manifestPathFor } from './paths.js';
import { deadPid, get, makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';
import { SERVER_VERSION } from './version.js';

const PR_KEY = 'github-quillmart--quillmart--12345';
const TEST_TIMEOUT_MS = 40_000;

const packageRoot = path.resolve(import.meta.dirname, '..');
const startPath = path.join(packageRoot, 'src', 'start.ts');

/** The line this is all for: the skill shows it to the reviewer. */
const UI_URL_PATTERN = /^UI: http:\/\/127\.0\.0\.1:(\d+)\/#token=([0-9a-f]+)$/mu;

interface LauncherResult {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

describe('start (server launch by the skill)', () => {
    let sherpaDir: string;
    let uiDir: string;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        uiDir = await makeFakeUiDir();
    });

    afterEach(async () => {
        await killDaemon(sherpaDir, PR_KEY);
        await removeTempSherpaDir(sherpaDir);
        await removeTempSherpaDir(uiDir);
    });

    it(
        'a cold start launches a daemon, prints the UI link and survives the command exit',
        async () => {
            const result = await runLauncher(['--pr', PR_KEY, '--sherpa-dir', sherpaDir, '--ui', uiDir]);

            expect(result.code).toBe(0);
            const url = UI_URL_PATTERN.exec(result.stdout);
            expect(url, result.stdout + result.stderr).not.toBeNull();

            const manifest = await readManifest(manifestPathFor(sherpaDir, PR_KEY));
            expect(manifest).not.toBeNull();
            expect(String(manifest?.port)).toBe(url?.[1]);
            expect(manifest?.token).toBe(url?.[2]);
            expect(manifest?.pid).not.toBe(process.pid);
            expect(isProcessAlive(manifest?.pid ?? 0)).toBe(true);

            const health = await get(manifest?.port ?? 0, '/healthz', manifest?.token);
            expect(health.status).toBe(200);
            expect(await health.json()).toMatchObject({ ok: true, prKey: PR_KEY, serverVersion: SERVER_VERSION });
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'a repeat launch finds the live server and does not start a second one',
        async () => {
            const first = await runLauncher(['--pr', PR_KEY, '--sherpa-dir', sherpaDir, '--ui', uiDir]);
            expect(first.code).toBe(0);
            const firstManifest = await readManifest(manifestPathFor(sherpaDir, PR_KEY));

            const second = await runLauncher(['--pr', PR_KEY, '--sherpa-dir', sherpaDir, '--ui', uiDir]);

            expect(second.code).toBe(0);
            expect(second.stdout).toContain('already running');
            expect(UI_URL_PATTERN.exec(second.stdout)?.[1]).toBe(String(firstManifest?.port));

            const secondManifest = await readManifest(manifestPathFor(sherpaDir, PR_KEY));
            expect(secondManifest?.pid).toBe(firstManifest?.pid);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'cleans up a stale manifest and starts the server again',
        async () => {
            const manifestPath = manifestPathFor(sherpaDir, PR_KEY);
            await fs.mkdir(path.dirname(manifestPath), { recursive: true });
            const stalePid = await deadPid();
            await claimManifest(manifestPath, {
                prKey: PR_KEY,
                port: 1,
                pid: stalePid,
                token: 'f'.repeat(64),
                serverVersion: SERVER_VERSION,
                protocolVersion: '0.1.0',
                createdAt: new Date().toISOString(),
            });

            const result = await runLauncher(['--pr', PR_KEY, '--sherpa-dir', sherpaDir, '--ui', uiDir]);

            expect(result.code).toBe(0);
            const manifest = await readManifest(manifestPath);
            expect(manifest?.pid).not.toBe(stalePid);
            expect(isProcessAlive(manifest?.pid ?? 0)).toBe(true);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'fails with instructions when the UI is not built and does not spawn a daemon',
        async () => {
            const missingUi = path.join(uiDir, 'no-such-directory');

            const result = await runLauncher(['--pr', PR_KEY, '--sherpa-dir', sherpaDir, '--ui', missingUi]);

            expect(result.code).toBe(1);
            expect(result.stderr).toContain('pnpm --filter @sherpa/ui build');
            expect(await readManifest(manifestPathFor(sherpaDir, PR_KEY))).toBeNull();
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'writes the daemon log without a token',
        async () => {
            const result = await runLauncher(['--pr', PR_KEY, '--sherpa-dir', sherpaDir, '--ui', uiDir]);
            expect(result.code).toBe(0);
            const token = UI_URL_PATTERN.exec(result.stdout)?.[2];
            expect(token).toBeDefined();

            const log = await fs.readFile(path.join(sherpaDir, 'prs', PR_KEY, 'server.log'), 'utf8');
            expect(log).toContain('start: PR ' + PR_KEY);
            expect(log).not.toContain(token);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'rejects an invalid PR key before launch',
        async () => {
            const result = await runLauncher(['--pr', '../escape', '--sherpa-dir', sherpaDir, '--ui', uiDir]);

            expect(result.code).toBe(1);
            expect(result.stderr).toContain('Invalid PR key');
        },
        TEST_TIMEOUT_MS,
    );
});

/** The launcher runs as a process because the task requires a separate daemon that survives its exit. */
async function runLauncher(args: readonly string[]): Promise<LauncherResult> {
    const child = spawn(process.execPath, ['--import', 'tsx', startPath, ...args], {
        cwd: packageRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
    });
    return { code, stdout, stderr };
}

/** The server requires an existing UI directory. Its contents do not matter. */
async function makeFakeUiDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-ui-'));
    await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>ui</title>\n');
    return dir;
}

/** The daemon outlives the test. Kill it using the manifest PID so it does not keep the port open. */
async function killDaemon(sherpaDir: string, prKey: string): Promise<void> {
    const manifest = await readManifest(manifestPathFor(sherpaDir, prKey));
    if (manifest === null) {
        return;
    }

    try {
        process.kill(manifest.pid, 'SIGTERM');
    } catch {
        return;
    }
    for (let attempt = 0; attempt < 100 && isProcessAlive(manifest.pid); attempt += 1) {
        await delay(20);
    }
    if (isProcessAlive(manifest.pid)) {
        process.kill(manifest.pid, 'SIGKILL');
    }
}
