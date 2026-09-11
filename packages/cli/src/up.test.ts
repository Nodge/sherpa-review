import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliError } from './errors.js';
import { manifestPathFor } from './paths.js';
import { ensureServer, hasExited, resolveServerBin, terminateChild } from './up.js';

const PR_KEY = 'github-quillmart--quillmart--777';

/** Short manifest wait: failure cases should not cost ten seconds per test. */
const STARTUP_TIMEOUT_MS = 1_500;

describe('server bundle discovery', () => {
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
     * Server bundle substitute: a real process, because this tests daemonization and waiting.
     * The layout matches the distribution (`<root>/bin/`), which the CLI uses to infer `--install-dir`.
     */
    async function fakeServer(body: string): Promise<string> {
        const binDir = path.join(workDir, 'skill', 'bin');
        await fs.mkdir(binDir, { recursive: true });
        const file = path.join(binDir, 'sherpa-server.mjs');
        await fs.writeFile(file, `${body}\n`, { mode: 0o755 });
        return file;
    }

    /** A server that does the essentials: listens on a port, answers `/healthz` and publishes a manifest. */
    const WORKING_SERVER = `
        import http from 'node:http';
        import fs from 'node:fs/promises';
        import path from 'node:path';

        const prKey = process.argv[process.argv.indexOf('--pr') + 1];
        const sherpaDir = process.argv[process.argv.indexOf('--sherpa-dir') + 1];
        const installDir = process.argv[process.argv.indexOf('--install-dir') + 1];
        const token = 'f'.repeat(64);

        let slowFirstHealth = process.argv.includes('--slow-first-health');
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

    async function up(serverBin: string) {
        return ensureServer({
            prKey: PR_KEY,
            sherpaDir,
            entry: undefined,
            serverBin,
            startupTimeoutMs: STARTUP_TIMEOUT_MS,
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

    it.skipIf(!process.allowedNodeEnvironmentFlags.has('--use-system-ca'))(
        'daemon receives `--use-system-ca` so Node trusts the internal CA',
        async () => {
            const guarded = `
                if (!process.execArgv.includes('--use-system-ca')) {
                    console.error('missing --use-system-ca');
                    process.exit(3);
                }
                ${WORKING_SERVER}
            `;

            const result = await up(await fakeServer(guarded));

            expect(result.started).toBe(true);
        },
    );

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
            [serverBin, '--pr', PR_KEY, '--sherpa-dir', sherpaDir, '--slow-first-health'],
            { stdio: 'ignore' },
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
        const dying = await fakeServer("console.error('cannot open storage'); process.exit(1);");

        const started = Date.now();
        await expect(up(dying)).rejects.toThrow('cannot open storage');
        expect(Date.now() - started).toBeLessThan(STARTUP_TIMEOUT_MS);
    });

    it('a missing server bundle reports an incomplete distribution without spawning anything', async () => {
        await expect(
            ensureServer({
                prKey: PR_KEY,
                sherpaDir,
                entry: undefined,
                startupTimeoutMs: STARTUP_TIMEOUT_MS,
            }),
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
