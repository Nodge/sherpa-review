import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = join(packageRoot, 'dist', 'sherpa-review.mjs');
/** Distribution version from `packages/npm/package.json`, the single source for all three bundles. */
const releaseVersion = (
    JSON.parse(readFileSync(join(packageRoot, '../npm/package.json'), 'utf8')) as { version: string }
).version;

// The bundle is built once in globalSetup (`src/bundle.global-setup.ts`).
describe('CLI build', () => {
    it('leaves no external imports except Node built-in modules', () => {
        const bundle = readFileSync(bundlePath, 'utf8');
        const specifiers = [...bundle.matchAll(/(?:^|\n)\s*import\s[^\n]*?["']([^"']+)["']/g)].map(
            (match) => match[1],
        );

        expect(specifiers.filter((s) => s !== undefined && !s.startsWith('node:'))).toEqual([]);
    });

    // Run from a temporary directory with no node_modules alongside it to check the bundle is self-contained.
    it('runs with plain node and prints the version', () => {
        const isolated = join(mkdtempSync(join(tmpdir(), 'sherpa-cli-')), 'sherpa-review.mjs');
        copyFileSync(bundlePath, isolated);

        const stdout = execFileSync(process.execPath, [isolated, '--version'], {
            cwd: tmpdir(),
            encoding: 'utf8',
        });

        expect(stdout.trim()).toBe(releaseVersion);
    });

    // No old Node is available, so a wrapper around the bundle overrides process.versions.node.
    it('prints a clear error on outdated Node and exits with a nonzero code', () => {
        const isolated = join(mkdtempSync(join(tmpdir(), 'sherpa-cli-')), 'sherpa-review.mjs');
        copyFileSync(bundlePath, isolated);

        const driver = join(dirname(isolated), 'old-node.mjs');
        writeFileSync(
            driver,
            [
                "Object.defineProperty(process.versions, 'node', { value: '22.12.0' });",
                `await import(${JSON.stringify(pathToFileURL(isolated).href)});`,
                '',
            ].join('\n'),
        );

        const result = spawnSync(process.execPath, [driver], { cwd: tmpdir(), encoding: 'utf8' });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('22.12.0');
        expect(result.stderr).toContain('Node 22.13');
    });

    // The worker loop invokes the CLI for every call, so neither the server nor UI must enter the bundle.
    it('stays thin, with no server or UI assets', () => {
        const bundle = readFileSync(bundlePath, 'utf8');

        expect(bundle).not.toContain('node:sqlite');
        expect(bundle).not.toContain('<!doctype html');
        // The CLI loads the server module with `import()` from a path computed at runtime, keeping it out of the bundle.
        expect(bundle).not.toContain('function startServer(');
        expect(statSync(bundlePath).size).toBeLessThan(1024 * 1024);
    });
});
