import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(packageRoot, 'dist', 'sherpa.mjs');
const packageVersion = (
    JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }
).version;

describe('CLI build', () => {
    beforeAll(() => {
        execFileSync(process.execPath, ['build.mjs'], { cwd: packageRoot, stdio: 'pipe' });
    }, 60_000);

    it('leaves no external imports except Node built-in modules', () => {
        const bundle = readFileSync(bundlePath, 'utf8');
        const specifiers = [...bundle.matchAll(/(?:^|\n)\s*import\s[^\n]*?["']([^"']+)["']/g)].map(
            (match) => match[1],
        );

        expect(specifiers.filter((s) => s !== undefined && !s.startsWith('node:'))).toEqual([]);
    });

    // Run from a temporary directory with no node_modules alongside it to check the bundle is self-contained.
    it('runs with plain node and prints the version', () => {
        const isolated = join(mkdtempSync(join(tmpdir(), 'sherpa-cli-')), 'sherpa.mjs');
        copyFileSync(bundlePath, isolated);

        const stdout = execFileSync(process.execPath, [isolated, '--version'], {
            cwd: tmpdir(),
            encoding: 'utf8',
        });

        expect(stdout.trim()).toBe(packageVersion);
    });

    // No old Node is available, so a wrapper around the bundle overrides process.versions.node.
    it('prints a clear error on outdated Node and exits with a nonzero code', () => {
        const isolated = join(mkdtempSync(join(tmpdir(), 'sherpa-cli-')), 'sherpa.mjs');
        copyFileSync(bundlePath, isolated);

        const driver = join(dirname(isolated), 'old-node.mjs');
        writeFileSync(
            driver,
            [
                "Object.defineProperty(process.versions, 'node', { value: '18.20.4' });",
                `await import(${JSON.stringify(pathToFileURL(isolated).href)});`,
                '',
            ].join('\n'),
        );

        const result = spawnSync(process.execPath, [driver], { cwd: tmpdir(), encoding: 'utf8' });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('18.20.4');
        expect(result.stderr).toContain('Node 20');
    });
});
