import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { PROTOCOL_VERSION, WORKER_ENDPOINTS, workerRegisterResponseSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isProcessAlive, readManifest } from './manifest.js';
import { manifestPathFor } from './paths.js';
import { get, makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

/**
 * Fixture host key: this suite tests the process, not the adapter. Live review hosts
 * is forbidden in tests (docs/testing.md). A live-host key would make route warm-up fetch the diff over the network.
 */
const PR_KEY = 'fixture-medium';
const TEST_TIMEOUT_MS = 40_000;
const STARTUP_TIMEOUT_MS = 15_000;

const packageRoot = path.resolve(import.meta.dirname, '..');
/** Built once in globalSetup (`src/bundle.global-setup.ts`). Only runs here. */
const bundlePath = path.join(packageRoot, 'dist', 'sherpa-server.mjs');
/**
 * Distribution version from the root package.json: the build embeds it in the bundle, while `SERVER_VERSION`
 * in this process is zero (the development default), so it cannot be used for comparison.
 */
const releaseVersion = (
    JSON.parse(readFileSync(path.join(packageRoot, '../../package.json'), 'utf8')) as { version: string }
).version;

/**
 * Server bundle as the skill distribution sees it: a separate process running plain node, state in tmp,
 * UI embedded inside. Neither a checkout nor `ui/dist` is present beside the process.
 */
describe('server bundle', () => {
    let sherpaDir: string;
    let workDir: string;
    let child: ChildProcess | null;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        // A launch directory with neither a checkout nor a built UI.
        workDir = await makeTempSherpaDir();
        child = null;
    });

    afterEach(async () => {
        if (child !== null && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
        }
        await removeTempSherpaDir(sherpaDir);
        await removeTempSherpaDir(workDir);
    });

    function launch(...args: string[]): ChildProcess {
        child = spawn(process.execPath, [bundlePath, ...args], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
        return child;
    }

    it(
        'starts in a separate process and serves the embedded UI from memory',
        async () => {
            launch('--pr', PR_KEY, '--sherpa-dir', sherpaDir);

            const manifest = await waitForManifest(sherpaDir);
            expect(manifest.pid).not.toBe(process.pid);
            expect(isProcessAlive(manifest.pid)).toBe(true);

            const health = await get(manifest.port, '/healthz', manifest.token);
            expect(health.status).toBe(200);
            expect(await health.json()).toMatchObject({ ok: true, prKey: PR_KEY, serverVersion: releaseVersion });

            // Static assets need no token: they contain no secrets (docs/protocol.md §8).
            const index = await get(manifest.port, '/');
            expect(index.status).toBe(200);
            expect(index.headers.get('content-type')).toContain('text/html');
            const html = await index.text();
            expect(html).toContain('<div id="root">');

            for (const [asset, contentType] of [
                [assetHref(html, '.js'), 'text/javascript'],
                [assetHref(html, '.css'), 'text/css'],
                // The favicon is the product mark: the bundle treats it as an asset just like scripts and styles.
                [assetHref(html, '.svg'), 'image/svg+xml'],
            ] as const) {
                const response = await get(manifest.port, asset);
                expect(response.status, asset).toBe(200);
                expect(response.headers.get('content-type'), asset).toContain(contentType);
                expect((await response.text()).length, asset).toBeGreaterThan(0);
            }
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'worker endpoint responds and the process stops on SIGTERM',
        async () => {
            const server = launch('--pr', PR_KEY, '--sherpa-dir', sherpaDir);
            const manifest = await waitForManifest(sherpaDir);

            const response = await fetch(`http://127.0.0.1:${String(manifest.port)}${WORKER_ENDPOINTS.register}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${manifest.token}`,
                },
                body: JSON.stringify({
                    protocolVersion: PROTOCOL_VERSION,
                    cliVersion: '0.0.0',
                    workerId: 'session-from-bundle',
                    harness: 'claude-code',
                }),
            });
            expect(response.status).toBe(200);
            expect(workerRegisterResponseSchema.parse(await response.json()).kind).toBe('registered');

            server.kill('SIGTERM');
            await waitFor(async () => (await readManifest(manifestPathFor(sherpaDir, PR_KEY))) === null);
            // The signal handler removes the manifest, then the process exits. On a busy
            // machine there is a gap between the two, so wait for exit instead of checking immediately after manifest removal.
            await waitFor(() => Promise.resolve(!isProcessAlive(manifest.pid)));
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'shuts down when idle: removes the manifest and logs the reason',
        async () => {
            // The threshold is shortened with an undocumented variable. The test cannot wait a quarter of an hour.
            child = spawn(process.execPath, [bundlePath, '--pr', PR_KEY, '--sherpa-dir', sherpaDir], {
                cwd: workDir,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, SHERPA_IDLE_SECONDS: '2' },
            });

            const { code, stdout } = await collectExit(child);
            expect(code).toBe(0);
            expect(stdout).toContain('start: PR');
            expect(stdout).toContain('idle shutdown: 2 s');
            expect(await readManifest(manifestPathFor(sherpaDir, PR_KEY))).toBeNull();
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'prints usage and exits with a nonzero code when the PR key is missing',
        async () => {
            const server = launch();
            const { code, stderr } = await collectExit(server);

            expect(code).toBe(1);
            expect(stderr).toContain('--pr');
        },
        TEST_TIMEOUT_MS,
    );

    it('does not import node:sqlite statically', async () => {
        const source = await readFile(bundlePath, 'utf8');

        // Static ESM imports resolve during linking. On Node without node:sqlite the process would die with
        // a raw error before checkNodeVersion could explain what to do.
        expect(source).not.toMatch(/^import[^\n]*node:sqlite/mu);
    });

    it(
        'explains what to do on an unsupported Node version',
        async () => {
            // Override the runtime version in a wrapper: there is no way to run the bundle itself on that Node version.
            const wrapper = path.join(workDir, 'old-node.mjs');
            await writeFile(
                wrapper,
                `Object.defineProperty(process.versions, 'node', { value: '22.12.0' });\n` +
                    `await import(${JSON.stringify(pathToFileURL(bundlePath).href)});\n`,
                'utf8',
            );

            child = spawn(process.execPath, [wrapper, '--pr', PR_KEY, '--sherpa-dir', sherpaDir], {
                cwd: workDir,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const { code, stderr } = await collectExit(child);

            expect(code).toBe(1);
            expect(stderr).toContain('22.13');
            expect(stderr).toContain('22.12.0');
            expect(await readManifest(manifestPathFor(sherpaDir, PR_KEY))).toBeNull();
        },
        TEST_TIMEOUT_MS,
    );
});

async function collectExit(
    server: ChildProcess,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    server.stdout?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => (stdout += chunk));
    server.stderr?.setEncoding('utf8');
    server.stderr?.on('data', (chunk: string) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve) => server.once('close', resolve));
    return { code, stdout, stderr };
}

/** Asset link from index.html: Vite build filenames contain a hash and change. */
function assetHref(html: string, extension: string): string {
    const match = new RegExp(`/assets/[^"']+\\${extension}`, 'u').exec(html);
    if (match === null) {
        throw new Error(`no link to a ${extension} asset in index.html`);
    }
    return match[0];
}

async function waitForManifest(sherpaDir: string): Promise<{ port: number; pid: number; token: string }> {
    const manifestPath = manifestPathFor(sherpaDir, PR_KEY);
    let manifest = await readManifest(manifestPath);
    await waitFor(async () => {
        manifest = await readManifest(manifestPath);
        return manifest !== null;
    });
    if (manifest === null) {
        throw new Error('server bundle did not publish a manifest');
    }
    return manifest;
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await condition()) {
            return;
        }
        await delay(50);
    }
    throw new Error('condition was not met within the allotted time');
}
