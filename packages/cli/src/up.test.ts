import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from './errors.js';
import { manifestPathFor } from './paths.js';
import { ensureServer, hasExited, loadServerModule, resolveServerBin, terminateChild } from './up.js';

const PR_KEY = 'pr-777';

/**
 * Bundled CLI (`src/bundle.global-setup.ts`): the daemon is the same CLI running `sherpa server`, so
 * the test spawns the real bundle and replaces only the server module.
 */
const CLI_BUNDLE = path.resolve(import.meta.dirname, '..', 'dist', 'sherpa.mjs');

/** Short manifest wait: failure cases should not cost ten seconds per test. */
const STARTUP_TIMEOUT_MS = 1_500;

describe('server module discovery', () => {
    let workDir: string;
    let binDir: string;

    beforeEach(async () => {
        // Real tmp instead of an fs mock: the symlink case requires an actual symlink.
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-bin-'));
        binDir = path.join(workDir, 'skill', 'bin');
        await fs.mkdir(binDir, { recursive: true });
        await fs.writeFile(path.join(binDir, 'sherpa.mjs'), '// CLI\n');
        await fs.writeFile(path.join(binDir, 'sherpa-server.mjs'), '// server\n');
    });

    afterEach(async () => {
        await fs.rm(workDir, { recursive: true, force: true });
    });

    it('uses the adjacent file next to the CLI itself', async () => {
        await expect(resolveServerBin(path.join(binDir, 'sherpa.mjs'), undefined)).resolves.toBe(
            path.join(await fs.realpath(binDir), 'sherpa-server.mjs'),
        );
    });

    it('finds the module through a symlink to the skill directory', async () => {
        // This is how the skill is installed: `~/.claude/skills/sherpa -> <distribution>`.
        const link = path.join(workDir, 'skills-sherpa');
        await fs.symlink(path.join(workDir, 'skill'), link, 'dir');

        await expect(resolveServerBin(path.join(link, 'bin', 'sherpa.mjs'), undefined)).resolves.toBe(
            path.join(await fs.realpath(binDir), 'sherpa-server.mjs'),
        );
    });

    it('reports an incomplete distribution when the adjacent server is missing', async () => {
        const lonely = path.join(workDir, 'sherpa.mjs');
        await fs.writeFile(lonely, '// CLI\n');

        await expect(resolveServerBin(lonely, undefined)).rejects.toThrow('skill distribution is incomplete');
    });

    it('returns the same error for an empty or nonexistent launch path without a stack trace', async () => {
        await expect(resolveServerBin(undefined, undefined)).rejects.toThrow(CliError);
        await expect(resolveServerBin('   ', undefined)).rejects.toThrow('skill distribution is incomplete');
        await expect(resolveServerBin(path.join(workDir, 'nonexistent.mjs'), undefined)).rejects.toThrow(
            'skill distribution is incomplete',
        );
    });

    it('SHERPA_SERVER_BIN overrides discovery and reports a separate error for a nonexistent path', async () => {
        const custom = path.join(workDir, 'custom-server.mjs');
        await fs.writeFile(custom, '// server\n');

        await expect(resolveServerBin(path.join(binDir, 'sherpa.mjs'), custom)).resolves.toBe(custom);
        await expect(
            resolveServerBin(path.join(binDir, 'sherpa.mjs'), path.join(workDir, 'nonexistent.mjs')),
        ).rejects.toThrow('SHERPA_SERVER_BIN');
    });

    it('reports an incomplete distribution for a module without runServer', async () => {
        const broken = path.join(workDir, 'without-runServer.mjs');
        await fs.writeFile(broken, 'export const runServer = 42;\n');

        await expect(loadServerModule(broken)).rejects.toThrow('skill distribution is incomplete');
    });

    it('reports the path and cause for a broken server module instead of asking to retry', async () => {
        const truncated = path.join(workDir, 'incomplete.mjs');
        await fs.writeFile(truncated, 'export async function runServer(argv) {\n');

        const error: unknown = await loadServerModule(truncated).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).message).toContain(`${truncated} failed to load`);
        expect((error as CliError).message).toContain('do not start the worker loop');
    });

    it('loads a module with runServer and calls it with the arguments unchanged', async () => {
        const file = path.join(workDir, 'echo-server.mjs');
        await fs.writeFile(file, 'export async function runServer(argv) { return argv.length; }\n');

        const loaded = await loadServerModule(file);

        await expect(loaded.runServer(['--pr', PR_KEY])).resolves.toBe(2);
    });
});

describe('server startup in `up`', () => {
    let workDir: string;
    let sherpaDir: string;
    const spawned: ChildProcess[] = [];

    beforeEach(async () => {
        workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-up-'));
        sherpaDir = path.join(workDir, 'state');
        await fs.mkdir(path.join(sherpaDir, 'servers'), { recursive: true });
    });

    afterEach(async () => {
        for (const child of spawned.splice(0)) {
            if (!hasExited(child)) {
                child.kill('SIGKILL');
            }
        }
        await killManifestServer(sherpaDir);
        await fs.rm(workDir, { recursive: true, force: true });
    });

    /**
     * Replaces the server module. The daemon is a real CLI process because the test checks daemonization
     * and waiting. The layout matches the distribution (`<root>/bin/`), which the CLI uses to derive `--install-dir`.
     * `body` is the body of the exported `runServer(argv)`.
     */
    async function fakeServer(body: string): Promise<string> {
        const binDir = path.join(workDir, 'skill', 'bin');
        await fs.mkdir(binDir, { recursive: true });
        const file = path.join(binDir, 'sherpa-server.mjs');
        await fs.writeFile(file, `export async function runServer(argv) {\n${body}\nreturn 0;\n}\n`);
        return file;
    }

    /** A server that does the essentials: listens on a port, answers `/healthz` and publishes a manifest. */
    const WORKING_SERVER = `
        const http = await import('node:http');
        const fs = await import('node:fs/promises');
        const path = await import('node:path');

        const prKey = argv[argv.indexOf('--pr') + 1];
        const sherpaDir = argv[argv.indexOf('--sherpa-dir') + 1];
        const installDir = argv[argv.indexOf('--install-dir') + 1];
        const repoIndex = argv.indexOf('--repo');
        const repo = repoIndex === -1 ? null : argv[repoIndex + 1];
        const baseIndex = argv.indexOf('--base');
        const base = baseIndex === -1 ? null : argv[baseIndex + 1];
        const branchIndex = argv.indexOf('--branch');
        const branch = branchIndex === -1 ? null : argv[branchIndex + 1];
        const verdictsIndex = argv.indexOf('--verdicts');
        const verdicts = verdictsIndex === -1 ? null : argv[verdictsIndex + 1];
        const token = 'f'.repeat(64);

        let slowFirstHealth = argv.includes('--slow-first-health');
        const server = http.createServer((req, res) => {
            const respond = () => {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true, prKey, pid: process.pid, serverVersion: '0.1.0', protocolVersion: '0.1.0' }));
            };
            if (slowFirstHealth) {
                slowFirstHealth = false;
                setTimeout(respond, 1_200);
                return;
            }
            respond();
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

        console.log('start: PR ' + prKey);
        const manifest = {
            prKey,
            installDir,
            repo,
            base,
            branch,
            verdicts,
            port: server.address().port,
            pid: process.pid,
            token,
            protocolVersion: '0.1.0',
            serverVersion: '0.1.0',
            createdAt: new Date().toISOString(),
        };
        await fs.mkdir(path.join(sherpaDir, 'servers'), { recursive: true });
        await fs.writeFile(path.join(sherpaDir, 'servers', prKey + '.json'), JSON.stringify(manifest));
    `;

    async function up(
        serverBin: string,
        local?: { repo: string; base?: string; branch?: string; verdicts?: string },
        nodeFlags?: readonly string[],
    ) {
        return ensureServer({
            prKey: PR_KEY,
            sherpaDir,
            entry: CLI_BUNDLE,
            serverBin,
            startupTimeoutMs: STARTUP_TIMEOUT_MS,
            ...(nodeFlags === undefined ? {} : { nodeFlags }),
            ...(local === undefined
                ? {}
                : { repo: local.repo, base: local.base, branch: local.branch, verdicts: local.verdicts }),
        });
    }

    async function waitForManifest(): Promise<TestManifest> {
        for (let attempt = 0; attempt < 100; attempt += 1) {
            try {
                return await readManifest(sherpaDir);
            } catch {
                await delay(20);
            }
        }
        throw new Error('server did not publish a manifest');
    }

    it('passes the supplied Node flags to the daemon and drops flags the runtime does not recognize', async () => {
        const guarded = `
            if (!process.execArgv.includes('--no-warnings') || process.execArgv.includes('--no-such-node-flag')) {
                console.error('runtime flags: ' + process.execArgv.join(' '));
                process.exit(3);
            }
            ${WORKING_SERVER}
        `;

        const result = await up(await fakeServer(guarded), undefined, ['--no-warnings', '--no-such-node-flag']);

        expect(result.started).toBe(true);
    });

    it('runs the same CLI as `sherpa server` and passes the server module in SHERPA_SERVER_BIN', async () => {
        const recording = `
            const fsSync = await import('node:fs');
            const sherpaDirArg = argv[argv.indexOf('--sherpa-dir') + 1];
            fsSync.writeFileSync(
                sherpaDirArg + '/daemon.json',
                JSON.stringify({ argv: process.argv.slice(1), serverBin: process.env.SHERPA_SERVER_BIN }),
            );
            ${WORKING_SERVER}
        `;
        const serverBin = await fakeServer(recording);

        await up(serverBin);

        const daemon = JSON.parse(await fs.readFile(path.join(sherpaDir, 'daemon.json'), 'utf8')) as {
            argv: string[];
            serverBin: string;
        };
        expect(daemon.argv.slice(0, 4)).toEqual([await fs.realpath(CLI_BUNDLE), 'server', '--pr', PR_KEY]);
        expect(daemon.serverBin).toBe(serverBin);
    });

    it('starts the daemon when there is no manifest and builds the link from its manifest', async () => {
        const result = await up(await fakeServer(WORKING_SERVER));

        const manifest = await readManifest(sherpaDir);
        expect(result).toEqual({
            uiUrl: `http://127.0.0.1:${String(manifest.port)}/#t=${manifest.token}`,
            started: true,
        });
        expect(manifest.pid).not.toBe(process.pid);
    });

    // Only the CLI knows where the distribution is installed. It passes the path to the server as an argument.
    it('passes --install-dir to the daemon as the distribution root above bin/', async () => {
        await up(await fakeServer(WORKING_SERVER));

        expect((await readManifest(sherpaDir)).installDir).toBe(await fs.realpath(path.join(workDir, 'skill')));
    });

    // Only the CLI knows the directory, base and branch. It passes them to the server as spawn arguments.
    // The branch matters: it defines the key, and the checkout may switch branches between `up` and the first snapshot.
    it('passes local review --repo, --base and --branch to the daemon', async () => {
        await up(await fakeServer(WORKING_SERVER), { repo: '/repo/app', base: 'main~3', branch: 'feature' });

        const manifest = await readManifest(sherpaDir);
        expect(manifest.repo).toBe('/repo/app');
        expect(manifest.base).toBe('main~3');
        expect(manifest.branch).toBe('feature');
        expect(manifest.verdicts).toBeNull();
    });

    it('passes the verdict instruction to the daemon as --verdicts', async () => {
        await up(await fakeServer(WORKING_SERVER), { repo: '/repo/app', verdicts: 'on ship, open a PR' });

        expect((await readManifest(sherpaDir)).verdicts).toBe('on ship, open a PR');
    });

    it('passes neither --repo, --base nor --branch to the daemon outside local review', async () => {
        await up(await fakeServer(WORKING_SERVER));

        const manifest = await readManifest(sherpaDir);
        expect(manifest.repo).toBeNull();
        expect(manifest.base).toBeNull();
        expect(manifest.branch).toBeNull();
        expect(manifest.verdicts).toBeNull();
    });

    it('reuses a live manifest without starting a second server', async () => {
        const serverBin = await fakeServer(WORKING_SERVER);
        const first = await up(serverBin);
        const firstPid = (await readManifest(sherpaDir)).pid;

        const second = await up(serverBin);

        expect(first.started).toBe(true);
        expect(second).toEqual({ uiUrl: first.uiUrl, started: false });
        expect((await readManifest(sherpaDir)).pid).toBe(firstPid);
    });

    it('takes the UI address from the live server manifest instead of the new CLI environment', async () => {
        const serverBin = await fakeServer(WORKING_SERVER);
        await up(serverBin);
        const manifest = await readManifest(sherpaDir);
        await fs.writeFile(
            manifestPathFor(sherpaDir, PR_KEY),
            JSON.stringify({ ...manifest, uiHost: 'sherpa-vm.example' }),
        );

        const result = await up(serverBin);

        expect(result).toEqual({
            uiUrl: `http://sherpa-vm.example:${String(manifest.port)}/#t=${manifest.token}`,
            started: false,
        });
    });

    it('does not treat another server manifest after spawn as a cold start', async () => {
        const serverBin = await fakeServer(WORKING_SERVER);
        const foreign = spawn(
            process.execPath,
            [CLI_BUNDLE, 'server', '--pr', PR_KEY, '--sherpa-dir', sherpaDir, '--slow-first-health'],
            { stdio: 'ignore', env: { ...process.env, SHERPA_SERVER_BIN: serverBin } },
        );
        spawned.push(foreign);
        const foreignManifest = await waitForManifest();
        const losingDaemon = await fakeServer('setTimeout(() => process.exit(0), 500);');

        const result = await up(losingDaemon);

        expect(result).toEqual({
            uiUrl: `http://127.0.0.1:${String(foreignManifest.port)}/#t=${foreignManifest.token}`,
            started: false,
        });
    });

    it('starts the server again when the manifest is dead', async () => {
        await writeManifest(sherpaDir, { pid: await deadPid(), port: 1, token: 'f'.repeat(64) });

        await up(await fakeServer(WORKING_SERVER));

        expect((await readManifest(sherpaDir)).port).not.toBe(1);
    });

    it('times out a silent server with the log tail and an instruction not to start the loop', async () => {
        const silent = await fakeServer("console.log('startup noise'); setInterval(() => {}, 1000);");

        await expect(up(silent)).rejects.toThrow('did not start within');
        await expect(up(silent)).rejects.toThrow('startup noise');
        await expect(up(silent)).rejects.toThrow('do not start the worker loop');
    }, 20_000);

    it('returns immediately when the server dies instead of waiting for the timeout', async () => {
        const dying = await fakeServer("console.error('cannot open storage'); return 1;");

        const started = Date.now();
        await expect(up(dying)).rejects.toThrow('cannot open storage');
        expect(Date.now() - started).toBeLessThan(STARTUP_TIMEOUT_MS);
    });

    it('reports an incomplete distribution without spawning when the server module is missing', async () => {
        await expect(
            ensureServer({
                prKey: PR_KEY,
                sherpaDir,
                entry: undefined,
                startupTimeoutMs: STARTUP_TIMEOUT_MS,
            }),
        ).rejects.toThrow('skill distribution is incomplete');
    });

    // The daemon is the CLI itself. Without its path, there is nothing to spawn even with an explicit server module.
    it('returns the same error without the CLI path even when SHERPA_SERVER_BIN is set', async () => {
        const serverBin = await fakeServer(WORKING_SERVER);

        await expect(
            ensureServer({ prKey: PR_KEY, sherpaDir, entry: undefined, serverBin, startupTimeoutMs: STARTUP_TIMEOUT_MS }),
        ).rejects.toThrow('skill distribution is incomplete');
    });

    describe('terminating a stuck daemon', () => {
        function spawnDetached(source: string): ChildProcess {
            // Same as the daemon in `up`: detached + unref. Exit events must still arrive afterward.
            const child = spawn(process.execPath, ['-e', source], {
                detached: true,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            child.unref();
            spawned.push(child);
            return child;
        }

        /**
         * Wait for the marker from the script. A signal sent earlier would reach bare node
         * with default handlers, so the SIGKILL test would check the wrong thing.
         */
        async function spawnReady(source: string): Promise<ChildProcess> {
            const child = spawnDetached(`${source}\nprocess.stdout.write('ready');`);
            await new Promise((resolve) => child.stdout?.once('data', resolve));
            return child;
        }

        it('terminates a live process with SIGTERM', async () => {
            const child = await spawnReady('setInterval(() => {}, 1000);');

            expect(await terminateChild(child, 300)).toBe(true);
            expect(child.signalCode).toBe('SIGTERM');
        });

        it('kills a process that ignores SIGTERM with SIGKILL', async () => {
            const child = await spawnReady("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");

            expect(await terminateChild(child, 300)).toBe(true);
            expect(child.signalCode).toBe('SIGKILL');
        });

        it('does nothing for a process that has already exited', async () => {
            const child = spawnDetached('');
            await new Promise((resolve) => child.once('exit', resolve));

            expect(await terminateChild(child, 300)).toBe(true);
            expect(child.exitCode).toBe(0);
        });
    });
});

interface TestManifest {
    readonly port: number;
    readonly pid: number;
    readonly token: string;
    readonly uiHost?: string;
    /** Outside the manifest: the fake server writes its `--install-dir` here for the test to inspect. */
    readonly installDir?: string;
    /** Likewise, the local review arguments the CLI passes to the daemon. */
    readonly repo?: string | null;
    readonly base?: string | null;
    readonly branch?: string | null;
    readonly verdicts?: string | null;
}

async function readManifest(sherpaDir: string): Promise<TestManifest> {
    const raw = await fs.readFile(manifestPathFor(sherpaDir, PR_KEY), 'utf8');
    return JSON.parse(raw) as TestManifest;
}

async function writeManifest(sherpaDir: string, parts: TestManifest): Promise<void> {
    await fs.writeFile(
        manifestPathFor(sherpaDir, PR_KEY),
        JSON.stringify({
            prKey: PR_KEY,
            ...parts,
            protocolVersion: '0.1.0',
            serverVersion: '0.1.0',
            createdAt: new Date().toISOString(),
        }),
    );
}

/** The daemon outlives the test. Kill it using the manifest PID so it does not keep the port open. */
async function killManifestServer(sherpaDir: string): Promise<void> {
    let manifest: TestManifest;
    try {
        manifest = await readManifest(sherpaDir);
    } catch {
        return;
    }
    try {
        process.kill(manifest.pid, 'SIGKILL');
    } catch {
        // The process is already gone. Nothing to terminate.
    }
}

/** A guaranteed dead PID: start a short-lived node process and wait for it to exit. */
async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid;
    if (pid === undefined) {
        throw new Error('failed to start a process to obtain a dead PID');
    }
    await new Promise<void>((resolve) => {
        child.once('exit', () => {
            resolve();
        });
    });
    return pid;
}
