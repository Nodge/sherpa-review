import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const binPath = join(packageRoot, 'bin', 'sherpa.mjs');
const cliVersion = JSON.parse(readFileSync(join(packageRoot, '../cli/package.json'), 'utf8')).version;

describe('skill package build', () => {
    beforeAll(() => {
        execFileSync(process.execPath, ['build.mjs'], { cwd: packageRoot, stdio: 'pipe' });
    }, 60_000);

    it('puts the CLI executable in bin/sherpa.mjs', () => {
        expect(statSync(binPath).isFile()).toBe(true);
    });

    it('runs the built CLI with plain node', () => {
        const stdout = execFileSync(process.execPath, [binPath, '--version'], { encoding: 'utf8' });

        expect(stdout.trim()).toBe(cliVersion);
    });

    it('describes startup and the worker loop in SKILL.md', () => {
        const skill = readFileSync(join(packageRoot, 'SKILL.md'), 'utf8');

        expect(skill).toMatch(/^---\nname: sherpa\n/u);
        expect(skill).toContain('bin/sherpa.mjs up --pr');
        expect(skill).toContain('bin/sherpa.mjs worker next --pr');
        expect(skill).toContain('DONE');
    });

    // Bootstrap is inside `sherpa up`. Mentioning the server or registration in SKILL.md again
    // gives the model extra knowledge that will diverge from the CLI at the next startup change.
    it('keeps server and registration details out of SKILL.md', () => {
        const skill = readFileSync(join(packageRoot, 'SKILL.md'), 'utf8');

        expect(skill).not.toContain('@sherpa/server');
        expect(skill).not.toContain('worker register');
    });
});
