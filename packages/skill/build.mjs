import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(root, 'dist');
const binDir = resolve(distDir, 'bin');

/**
 * `dist/` is the skill distribution: SKILL.md beside `bin/` with two bundles. It is `dist`
 * that gets linked into the harness (`~/.claude/skills/sherpa`), so package source files stay out.
 * There are two bundles because the worker loop invokes the CLI on every call, and the server with its embedded UI
 * would add unnecessary weight to it.
 *
 * Builds run directly, without nested pnpm (tests call them too). The packages are listed
 * in the skill's devDependencies for `pnpm -r` topological order. Otherwise these builds and the builds
 * in the packages' own tests would write the same files to dist in parallel.
 */
const bundles = [
    { pkg: '../server', script: 'build-server.mjs', file: 'dist/sherpa-server.mjs', out: 'sherpa-server.mjs' },
    { pkg: '../cli', script: 'build.mjs', file: 'dist/sherpa.mjs', out: 'sherpa.mjs' },
];

rmSync(distDir, { recursive: true, force: true });
mkdirSync(binDir, { recursive: true });
copyFileSync(resolve(root, 'SKILL.md'), resolve(distDir, 'SKILL.md'));

for (const bundle of bundles) {
    const packageRoot = resolve(root, bundle.pkg);
    execFileSync(process.execPath, [bundle.script], { cwd: packageRoot, stdio: 'inherit' });

    const outfile = resolve(binDir, bundle.out);
    copyFileSync(resolve(packageRoot, bundle.file), outfile);
    chmodSync(outfile, 0o755);
    process.stdout.write(`@sherpa/skill: ${outfile}\n`);
}
