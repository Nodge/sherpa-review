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

    it('SKILL.md describes the worker loop and server startup', () => {
        const skill = readFileSync(join(packageRoot, 'SKILL.md'), 'utf8');

        expect(skill).toMatch(/^---\nname: sherpa\n/u);
        expect(skill).toContain('--filter @sherpa/server start --pr');
        expect(skill).toContain('bin/sherpa.mjs worker next --pr');
        expect(skill).toContain('DONE');
    });
});
