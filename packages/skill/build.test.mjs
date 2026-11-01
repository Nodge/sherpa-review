import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const distDir = join(packageRoot, 'dist');
const binDir = join(distDir, 'bin');
const cliPath = join(binDir, 'sherpa-review.mjs');
const serverPath = join(binDir, 'sherpa-review-server.mjs');
const uiRoot = resolve(packageRoot, '../ui');
/** Distribution version from the root package.json, the single source for all three bundles. */
const releaseVersion = JSON.parse(readFileSync(join(packageRoot, '../../package.json'), 'utf8')).version;

// One build for the whole file: both suites check a fresh `dist/`, even when only one of them runs.
beforeAll(() => {
    // The chain does not build the UI (the server module embeds a prebuilt `ui/dist`), but `dist`
    // is not stored in git. Build it here on a clean checkout so the module has something to embed.
    if (!existsSync(join(uiRoot, 'dist', 'index.html'))) {
        execFileSync('pnpm', ['--filter', '@sherpa/ui', 'build'], { cwd: uiRoot, stdio: 'pipe' });
    }
    execFileSync(process.execPath, ['build.mjs'], { cwd: packageRoot, stdio: 'pipe' });
}, 120_000);

describe('skill package build', () => {
    // The harness links to `dist/`. An extra file there is junk in the installed skill.
    it('makes dist/ a self-contained distribution with its license, command and server module', () => {
        expect(readdirSync(distDir).sort()).toEqual(['LICENSE', 'SKILL.md', 'bin', 'version.json']);
        expect(readdirSync(binDir).sort()).toEqual(['sherpa-review-server.mjs', 'sherpa-review.mjs']);
        expect(statSync(cliPath).isFile()).toBe(true);
        expect(statSync(serverPath).isFile()).toBe(true);
        // There is only one command: the server module does not run directly, the CLI loads it.
        expect(statSync(cliPath).mode & 0o111).toBe(0o111);
        expect(statSync(serverPath).mode & 0o111).toBe(0);
        expect(readFileSync(join(distDir, 'SKILL.md'), 'utf8')).toBe(
            readFileSync(join(packageRoot, 'SKILL.md'), 'utf8'),
        );
        expect(readFileSync(join(distDir, 'LICENSE'), 'utf8')).toBe(
            readFileSync(join(packageRoot, '../../LICENSE'), 'utf8'),
        );
    });

    /**
     * The build does not know the release fields, so they stay null.
     */
    it('includes the distribution version and working tree state in version.json', () => {
        const distVersion = JSON.parse(readFileSync(join(distDir, 'version.json'), 'utf8'));

        const head = git(['rev-parse', 'HEAD']);
        expect(distVersion).toEqual({
            version: releaseVersion,
            builtFrom: head === null ? null : git(['status', '--short', '--', '.']) === '' ? head : `${head}-dirty`,
            releasedAt: null,
            whatsNew: null,
        });
    });

    it('runs the built CLI with plain node', () => {
        const stdout = execFileSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });

        expect(stdout.trim()).toBe(releaseVersion);
    });

    // The worker loop calls the CLI on every request. The server and UI would add overhead to every step.
    it('keeps the server and UI in the server module, outside the CLI', () => {
        expect(statSync(cliPath).size).toBeLessThan(statSync(serverPath).size);
        expect(readFileSync(cliPath, 'utf8')).not.toContain('node:sqlite');
        expect(readFileSync(serverPath, 'utf8')).toContain('node:sqlite');
    });

    it('describes startup and the worker loop in SKILL.md', () => {
        const skill = readFileSync(join(packageRoot, 'SKILL.md'), 'utf8');

        expect(skill).toMatch(/^---\nname: sherpa-review\n/u);
        expect(skill).toContain('bin/sherpa-review.mjs up --pr');
        // The loop uses exactly the command printed by `up`, including the full path and `--pr`.
        expect(skill).toContain('exactly the `worker next` command that `up` printed');
        expect(skill).not.toContain('bin/sherpa-review.mjs worker next');
        expect(skill).toContain('--model');
        expect(skill).toContain('DONE');
        // Shared task context rule: a path under `shared/` is read once per session.
        expect(skill).toContain('`shared/`');
        expect(skill).toContain('once per session');
        // The task supplies the result file. A custom path in shared tmp would collide across sessions on one machine.
        expect(skill).toContain('only to the file path the task gives you');
    });

    /**
     * The SKILL.md loop recognizes situations by exact output phrases: "stop the loop" ends the loop,
     * DONE ends the work. If the wording diverges, the model silently stops recognizing these situations,
     * so the build tests the agreement.
     */
    it('uses the exact loop marker phrases from SKILL.md in CLI and server output', () => {
        const skill = readFileSync(join(packageRoot, 'SKILL.md'), 'utf8');
        const cli = readFileSync(cliPath, 'utf8');
        const server = readFileSync(serverPath, 'utf8');

        // Quotes in the SKILL.md body enclose exactly the phrases the model looks for in output.
        // Frontmatter does not count: its quotes serve the YAML validator. Nor do code spans, where quotes are code.
        const body = skill.replace(/^---\n[\s\S]*?\n---\n/u, '').replace(/`[^`\n]*`/gu, '');
        const markers = [...body.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
        expect(markers).toEqual(expect.arrayContaining(['stop the loop']));

        for (const marker of [...markers, 'DONE']) {
            expect(`${cli}\n${server}`, marker).toContain(marker);
        }
    });

    // Bootstrap is inside `sherpa-review up`. Mentioning the server or registration in SKILL.md again
    // gives the model extra knowledge that will diverge from the CLI at the next startup change.
    it('keeps server and registration details out of SKILL.md', () => {
        const skill = readFileSync(join(packageRoot, 'SKILL.md'), 'utf8');

        expect(skill).not.toContain('@sherpa/server');
        expect(skill).not.toContain('worker register');
    });
});

/**
 * The distribution as the user sees it: a copy of `dist/` in another directory, plain node, its own state.
 * Uses a fixture key because live review hosts are forbidden in tests (docs/testing.md).
 */
describe('running the built distribution', () => {
    const PR_KEY = 'fixture-medium';
    let workDir;
    let skillDir;
    let sherpaDir;

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'sherpa-skill-'));
        skillDir = join(workDir, 'skill');
        sherpaDir = join(workDir, 'state');
        cpSync(distDir, skillDir, { recursive: true });
    });

    afterEach(async () => {
        const manifest = readManifest();
        if (manifest !== null) {
            await stopProcess(manifest.pid);
        }
        rmSync(workDir, { recursive: true, force: true });
    });

    function sherpa(args, extraEnv = {}) {
        // The test environment must not override server discovery or the PR key.
        const { SHERPA_SERVER_BIN: _bin, SHERPA_PR: _pr, SHERPA_WORKER_ID: _worker, ...inherited } = process.env;
        const env = { ...inherited, SHERPA_DIR: sherpaDir, ...extraEnv };
        return spawnSync(process.execPath, [join(skillDir, 'bin', 'sherpa-review.mjs'), ...args], {
            cwd: workDir,
            encoding: 'utf8',
            env,
            // `worker next` waits for a task indefinitely. The test only needs it to reach the request.
            timeout: 20_000,
        });
    }

    function up() {
        return sherpa(['up', '--pr', PR_KEY, '--no-open', '--harness', 'test']);
    }

    function readManifest() {
        const file = join(sherpaDir, 'servers', `${PR_KEY}.json`);
        return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    }

    it('starts the server on a cold up and reuses it on a warm one', () => {
        const cold = up();
        expect(cold.status, cold.stderr).toBe(0);
        const first = readManifest();
        expect(first).not.toBeNull();
        expect(cold.stdout).toContain(`http://127.0.0.1:${String(first.port)}/#t=`);

        // The daemon is this same CLI running `sherpa-review server`, with Node flags from the CLI root (`src/index.ts`):
        // without `--use-system-ca`, the server does not trust the custom CA that signs the hosts.
        const daemon = execFileSync('ps', ['-o', 'args=', '-p', String(first.pid)], { encoding: 'utf8' });
        expect(daemon).toContain(`bin/sherpa-review.mjs server --pr ${PR_KEY}`);
        if (process.allowedNodeEnvironmentFlags.has('--use-system-ca')) {
            expect(daemon).toContain('--use-system-ca');
        }

        const warm = up();
        expect(warm.status, warm.stderr).toBe(0);
        const second = readManifest();
        expect({ port: second.port, pid: second.pid }).toEqual({ port: first.port, pid: first.pid });
        expect(warm.stdout).toContain(`http://127.0.0.1:${String(first.port)}/#t=`);
    }, 60_000);

    /** Takes commands from output as is and runs them in a shell from another cwd without `SHERPA_PR`. */
    it('runs printed loop commands as is from any cwd', () => {
        const ready = up();
        expect(ready.status, ready.stderr).toBe(0);
        const nextCommand = /Then run `([^`]+)`/u.exec(ready.stdout)?.[1];
        expect(nextCommand).toMatch(new RegExp(`^node \\S+/bin/sherpa-review\\.mjs worker next --pr ${PR_KEY}$`, 'u'));

        const issued = shell(nextCommand);
        expect(issued.status, issued.stderr).toBe(0);
        expect(issued.stdout).toContain('TASK sherpa/');
        const failCommand = /Cannot do it: (.+) --reason "\.\.\."$/mu.exec(issued.stdout)?.[1];
        expect(failCommand).toContain(`--pr ${PR_KEY}`);

        const failed = shell(`${failCommand} --reason "checking the loop from another cwd"`);
        expect(failed.status, failed.stderr).toBe(0);
        expect(failed.stdout).toContain('is accepted');
        expect(failed.stdout).toContain(nextCommand);
    }, 60_000);

    /** Runs the output command as a harness would: in a shell, outside the checkout, without a key in the environment. */
    function shell(command) {
        const { SHERPA_SERVER_BIN: _bin, SHERPA_PR: _pr, SHERPA_WORKER_ID: _worker, ...inherited } = process.env;
        return spawnSync('/bin/sh', ['-c', command], {
            cwd: tmpdir(),
            encoding: 'utf8',
            env: { ...inherited, SHERPA_DIR: sherpaDir },
            timeout: 20_000,
        });
    }

    // The worker loop calls the CLI on every request. It must not load the server module.
    it('does not load the server module on worker next but does on server', () => {
        const marker = join(workDir, 'server-loaded');
        const probe = join(workDir, 'probe-server.mjs');
        writeFileSync(
            probe,
            `import { writeFileSync } from 'node:fs';\n` +
                `writeFileSync(${JSON.stringify(marker)}, 'loaded');\n` +
                'export async function runServer() { return 0; }\n',
        );

        // The server is running and the worker is registered. `next` reaches a response without failing at manifest discovery.
        expect(up().status).toBe(0);
        const next = sherpa(['worker', 'next', '--pr', PR_KEY], { SHERPA_SERVER_BIN: probe });
        expect(next.status, next.stderr).toBe(0);
        expect(next.stdout).toContain('TASK');
        expect(existsSync(marker)).toBe(false);

        // The probe works: `sherpa-review server` loads it.
        const server = sherpa(['server', '--pr', PR_KEY], { SHERPA_SERVER_BIN: probe });
        expect(server.status, server.stderr).toBe(0);
        expect(existsSync(marker)).toBe(true);
    }, 60_000);
});

/** Stops the daemon by PID with SIGTERM and waits so the server does not outlive the test. */
async function stopProcess(pid) {
    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        return;
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            process.kill(pid, 0);
        } catch {
            return;
        }
        await delay(50);
    }
    try {
        process.kill(pid, 'SIGKILL');
    } catch {
        // Already stopped.
    }
}

function git(args) {
    try {
        return execFileSync('git', args, {
            cwd: resolve(packageRoot, '../..'),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        // A source copy outside a git checkout correctly builds with builtFrom: null.
        return null;
    }
}
