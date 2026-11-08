import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const distDir = join(packageRoot, 'dist');
const binDir = join(distDir, 'bin');
const cliPath = join(binDir, 'sherpa-review.mjs');
const serverPath = join(binDir, 'sherpa-review-server.mjs');
const uiRoot = resolve(packageRoot, '../ui');
const repoRoot = resolve(packageRoot, '../..');
/** The published package's own manifest: its version is the single source for all three bundles. */
const ownManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const releaseVersion = ownManifest.version;

// One build for the whole file: both suites check a fresh `dist/`, even when only one of them runs.
beforeAll(() => {
    // The chain does not build the UI (the server module embeds a prebuilt `ui/dist`), but `dist`
    // is not stored in git. Build it here on a clean checkout so the module has something to embed.
    // A UI built before the module list existed is rebuilt too: the notices need the list.
    if (!existsSync(join(uiRoot, 'dist', 'index.html')) || !existsSync(join(uiRoot, 'build', 'bundled-modules.json'))) {
        execFileSync('pnpm', ['--filter', '@sherpa/ui', 'build'], { cwd: uiRoot, stdio: 'pipe' });
    }
    execFileSync(process.execPath, ['build.mjs'], { cwd: packageRoot, stdio: 'pipe' });
}, 120_000);

describe('npm package build', () => {
    // `dist/` is what `npm publish` uploads. An extra file there is junk in every install.
    it('makes dist/ the package: manifest, readme, license, command and server module', () => {
        expect(readdirSync(distDir).sort()).toEqual(['LICENSE', 'README.md', 'THIRD-PARTY-LICENSES.txt', 'bin', 'package.json']);
        expect(readdirSync(binDir).sort()).toEqual(['sherpa-review-server.mjs', 'sherpa-review.mjs']);
        // There is only one command: the server module does not run directly, the CLI loads it.
        expect(statSync(cliPath).mode & 0o111).toBe(0o111);
        expect(statSync(serverPath).mode & 0o111).toBe(0);
        expect(readFileSync(join(distDir, 'LICENSE'), 'utf8')).toBe(readFileSync(join(repoRoot, 'LICENSE'), 'utf8'));
        expect(readFileSync(join(distDir, 'README.md'), 'utf8')).toBe(readFileSync(join(repoRoot, 'README.md'), 'utf8'));
    });

    // MIT, BSD, ISC and the fonts' OFL require the license text beside the bundled code. The list comes from the build metadata.
    it('ships license notices of the third-party packages bundled into bin/', () => {
        const notices = readFileSync(join(distDir, 'THIRD-PARTY-LICENSES.txt'), 'utf8');
        const entries = [...notices.matchAll(/^={80}\n(.+)@([^@\n]+)\nLicense: (.+)$/gmu)].map(([, name, , license]) => ({
            name,
            license,
        }));
        const names = entries.map((entry) => entry.name);

        // UI (react, react-dom, highlight.js), server (diff), both bundles (zod), the UI build's injected helpers (vite, rolldown).
        for (const name of ['react', 'react-dom', 'zod', 'diff', 'highlight.js', 'vite', 'rolldown']) {
            expect(names, name).toContain(name);
        }
        expect(entries.find((entry) => entry.name === 'react')?.license).toBe('MIT');
        // The fonts are UI build assets, not modules.
        for (const name of ['@ibm/plex-sans', '@ibm/plex-mono']) {
            expect(entries.find((entry) => entry.name === name)?.license, name).toBe('OFL-1.1');
        }
        expect(notices).toContain('SIL Open Font License, Version 1.1');
        expect(notices).toContain('Copyright (c) Meta Platforms, Inc. and affiliates.');
        expect(notices).toContain('Permission is hereby granted, free of charge');
        expect(names.filter((name) => name.startsWith('@sherpa/'))).toEqual([]);
        for (const name of ['vitest', 'esbuild', 'typescript', 'eslint']) {
            expect(names, name).not.toContain(name);
        }
        expect(names).toEqual([...names].sort());
    });

    // Zero runtime dependencies: `npx` downloads one tarball and runs it.
    it('publishes sherpa-review with one bin and no dependencies', () => {
        const manifest = JSON.parse(readFileSync(join(distDir, 'package.json'), 'utf8'));
        const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

        expect(manifest).toMatchObject({
            name: 'sherpa-review',
            version: releaseVersion,
            license: 'MIT',
            type: 'module',
            bin: { 'sherpa-review': 'bin/sherpa-review.mjs' },
            engines: ownManifest.engines,
        });
        // npm resolves `sherpa-review@<version>` to a workspace root of the same name and version inside the checkout.
        expect(root.name).not.toBe(manifest.name);
        expect(manifest).not.toHaveProperty('private');
        expect(manifest).not.toHaveProperty('dependencies');
        expect(manifest).not.toHaveProperty('scripts');
    });

    // The guide lives in the CLI (`sherpa-review guide`). An installed skill stays as it was copied.
    it('keeps the skill a stub that calls the guide of this release', () => {
        const skill = readFileSync(join(repoRoot, 'skills/sherpa-review/SKILL.md'), 'utf8');

        expect(skill).toMatch(/^---\nname: sherpa-review\n/u);
        expect(skill).toContain(`npx -y sherpa-review@${releaseVersion} guide`);
        expect(skill).not.toContain('@latest');
        expect(skill).not.toContain(' up --pr');
        expect(skill).not.toContain('worker next');
        // A blanket stop rule would override the guide's recovery steps, such as resubmitting an oversized result.
        expect(skill).not.toContain('If a command fails');
    });

    // `scripts/pin-version.mjs` keeps them in step. The plugin version is what tells Claude Code there is an update.
    it('pins the plugin to this release', () => {
        const plugin = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin/plugin.json'), 'utf8'));

        expect(plugin).toMatchObject({ name: 'sherpa-review', version: releaseVersion });
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

    it('prints the guide from the built CLI', () => {
        const stdout = execFileSync(process.execPath, [cliPath, 'guide'], { encoding: 'utf8' });

        expect(stdout).toContain(`node ${shellQuote(cliPath)} up --pr <pr>`);
        expect(stdout).toContain('**A GitHub PR URL**');
    });
});

/**
 * The package as the user gets it: `npm pack` of `dist/`, installed into another directory the way npx installs it,
 * run through the `node_modules/.bin` link, with its own state.
 * Uses a fixture key because live review hosts are forbidden in tests (docs/testing.md).
 */
describe('running the installed package', () => {
    const PR_KEY = 'fixture-medium';
    let installRoot;
    let binLink;
    let workDir;
    let sherpaDir;

    beforeAll(() => {
        installRoot = mkdtempSync(join(tmpdir(), 'sherpa-npm-'));
        const packed = JSON.parse(
            execFileSync('npm', ['pack', distDir, '--pack-destination', installRoot, '--json'], { encoding: 'utf8' }),
        );
        // No dependencies, so nothing to fetch: the install works offline.
        execFileSync(
            'npm',
            ['install', join(installRoot, packed[0].filename), '--offline', '--no-audit', '--no-fund', '--ignore-scripts'],
            { cwd: installRoot, stdio: 'pipe' },
        );
        binLink = join(installRoot, 'node_modules', '.bin', 'sherpa-review');
    }, 120_000);

    afterAll(() => {
        rmSync(installRoot, { recursive: true, force: true });
    });

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'sherpa-work-'));
        sherpaDir = join(workDir, 'state');
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
        return spawnSync(process.execPath, [binLink, ...args], {
            cwd: workDir,
            encoding: 'utf8',
            env,
            // `worker next` waits for a task indefinitely. The test only needs it to reach the request.
            timeout: 20_000,
        });
    }

    it('packs only the package files', () => {
        const installed = join(installRoot, 'node_modules', 'sherpa-review');

        expect(readdirSync(installed).sort()).toEqual(['LICENSE', 'README.md', 'THIRD-PARTY-LICENSES.txt', 'bin', 'package.json']);
        expect(sherpa(['--version']).stdout.trim()).toBe(releaseVersion);
    });

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
        expect(daemon).toContain(`node_modules/sherpa-review/bin/sherpa-review.mjs server --pr ${PR_KEY}`);
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
        // The real file behind the `.bin` link: the server module sits beside it.
        expect(nextCommand).toMatch(
            new RegExp(`^node \\S+/node_modules/sherpa-review/bin/sherpa-review\\.mjs worker next --pr ${PR_KEY}$`, 'u'),
        );

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

/** A word for a POSIX shell, the same rule as `shellQuote` in `packages/cli/src/format.ts`. */
function shellQuote(value) {
    return /^[\w@%+:,./-][\w@%+=:,./-]*$/u.test(value) ? value : `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

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
