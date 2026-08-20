import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const binDir = join(packageRoot, 'bin');
const cliPath = join(binDir, 'sherpa.mjs');
const serverPath = join(binDir, 'sherpa-server.mjs');
const uiRoot = resolve(packageRoot, '../ui');
const cliVersion = JSON.parse(readFileSync(join(packageRoot, '../cli/package.json'), 'utf8')).version;

describe('skill package build', () => {
    beforeAll(() => {
        // The UI build is not part of the chain (the server bundle embeds the built `ui/dist`), but `dist`
        // is not tracked in git. Build it here on a clean checkout, or the bundle has nothing to embed.
        if (!existsSync(join(uiRoot, 'dist', 'index.html'))) {
            execFileSync('pnpm', ['--filter', '@sherpa/ui', 'build'], { cwd: uiRoot, stdio: 'pipe' });
        }
        execFileSync(process.execPath, ['build.mjs'], { cwd: packageRoot, stdio: 'pipe' });
    }, 120_000);

    it('puts exactly two bundles in bin/: a thin CLI and the server', () => {
        expect(readdirSync(binDir).sort()).toEqual(['sherpa-server.mjs', 'sherpa.mjs']);
        expect(statSync(cliPath).isFile()).toBe(true);
        expect(statSync(serverPath).isFile()).toBe(true);
    });

    it('runs the built CLI with plain node', () => {
        const stdout = execFileSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });

        expect(stdout.trim()).toBe(cliVersion);
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
    });

    /**
     * The SKILL.md loop identifies situations by exact output phrases: "No tasks" is not an error,
     * "stop the loop" ends the loop, DONE ends the work. If the wording drifts, the model
     * silently stops recognizing these situations, so the build checks the agreement.
     */
    it('uses the exact loop marker phrases from SKILL.md in CLI and server output', () => {
        const skill = readFileSync(join(packageRoot, 'SKILL.md'), 'utf8');
        const cli = readFileSync(cliPath, 'utf8');
        const server = readFileSync(serverPath, 'utf8');

        // Quotes in SKILL.md surround exactly the phrases the model looks for in output.
        const markers = [...skill.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
        expect(markers).toEqual(expect.arrayContaining(['No tasks', 'stop the loop']));

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
