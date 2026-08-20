import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const binDir = resolve(root, 'bin');

/**
 * The package directory is the skill distribution: SKILL.md beside two bundles. There are two because
 * the worker loop invokes the CLI on every call, and a server with an embedded UI would add unnecessary weight.
 *
 * Builds run directly, without nested pnpm (tests call them too). The packages are listed
 * in the skill's devDependencies for `pnpm -r` topological order. Otherwise these builds and the builds
 * in the packages' own tests would write the same files to dist in parallel.
 */
const bundles = [
    { pkg: '../server', script: 'build-server.mjs', file: 'dist/sherpa-server.mjs', out: 'sherpa-server.mjs' },
    { pkg: '../cli', script: 'build.mjs', file: 'dist/sherpa.mjs', out: 'sherpa.mjs' },
];

mkdirSync(binDir, { recursive: true });

for (const bundle of bundles) {
    const packageRoot = resolve(root, bundle.pkg);
    execFileSync(process.execPath, [bundle.script], { cwd: packageRoot, stdio: 'inherit' });

    const outfile = resolve(binDir, bundle.out);
    copyFileSync(resolve(packageRoot, bundle.file), outfile);
    chmodSync(outfile, 0o755);
    process.stdout.write(`@sherpa/skill: ${outfile}\n`);
}
