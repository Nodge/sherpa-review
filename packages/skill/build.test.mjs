import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const distDir = join(packageRoot, 'dist');
const binDir = join(distDir, 'bin');
const cliPath = join(binDir, 'sherpa.mjs');
const serverPath = join(binDir, 'sherpa-server.mjs');
const uiRoot = resolve(packageRoot, '../ui');
/** Distribution version from the root package.json, the single source for all three bundles. */
const releaseVersion = JSON.parse(readFileSync(join(packageRoot, '../../package.json'), 'utf8')).version;

describe('skill package build', () => {
    beforeAll(() => {
        // The UI build is not part of the chain (the server bundle embeds the built `ui/dist`), but `dist`
        // is not tracked in git. Build it here on a clean checkout, or the bundle has nothing to embed.
        if (!existsSync(join(uiRoot, 'dist', 'index.html'))) {
            execFileSync('pnpm', ['--filter', '@sherpa/ui', 'build'], { cwd: uiRoot, stdio: 'pipe' });
        }
        execFileSync(process.execPath, ['build.mjs'], { cwd: packageRoot, stdio: 'pipe' });
    }, 120_000);

    // The harness links to `dist/`. An extra file there is junk in the installed skill.
    it('dist/ is a self-contained distribution: SKILL.md and exactly two bundles in bin/', () => {
        expect(readdirSync(distDir).sort()).toEqual(['SKILL.md', 'bin', 'version.json']);
        expect(readdirSync(binDir).sort()).toEqual(['sherpa-server.mjs', 'sherpa.mjs']);
        expect(statSync(cliPath).isFile()).toBe(true);
        expect(statSync(serverPath).isFile()).toBe(true);
        expect(readFileSync(join(distDir, 'SKILL.md'), 'utf8')).toBe(
            readFileSync(join(packageRoot, 'SKILL.md'), 'utf8'),
        );
    });

    /**
     * The server uses this file to check for a new version. The build does not know the release fields,
     * which `scripts/release.mjs` fills in the target directory.
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
    it('keeps the server and UI in a separate bundle from the CLI', () => {
        expect(statSync(cliPath).size).toBeLessThan(statSync(serverPath).size);
        expect(readFileSync(cliPath, 'utf8')).not.toContain('node:sqlite');
        expect(readFileSync(serverPath, 'utf8')).toContain('node:sqlite');
    });

    it('describes startup and the worker loop in SKILL.md', () => {
        const skill = readFileSync(join(packageRoot, 'SKILL.md'), 'utf8');

        expect(skill).toMatch(/^---\nname: sherpa\n/u);
        expect(skill).toContain('bin/sherpa.mjs up --pr');
        expect(skill).toContain('bin/sherpa.mjs worker next --pr');
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
        // Frontmatter does not count. Its quotes are required by the YAML validator.
        const body = skill.replace(/^---\n[\s\S]*?\n---\n/u, '');
        const markers = [...body.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
        expect(markers).toEqual(expect.arrayContaining(['stop the loop']));

        for (const marker of [...markers, 'DONE']) {
            expect(`${cli}\n${server}`, marker).toContain(marker);
        }
    });

    // Bootstrap is inside `sherpa up`. Mentioning the server or registration in SKILL.md again
    // gives the model extra knowledge that will diverge from the CLI at the next startup change.
    it('keeps server and registration details out of SKILL.md', () => {
        const skill = readFileSync(join(packageRoot, 'SKILL.md'), 'utf8');

        expect(skill).not.toContain('@sherpa/server');
        expect(skill).not.toContain('worker register');
    });
});

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
