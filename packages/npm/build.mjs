import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(root, '../..');
const distDir = resolve(root, 'dist');
const binDir = resolve(distDir, 'bin');

/** npm package name: `npx sherpa-review` and the skill stub call it by this name. */
const PACKAGE_NAME = 'sherpa-review';
const REPOSITORY = 'https://github.com/Nodge/sherpa-review';

/**
 * `dist/` is the `sherpa-review` npm package: package.json, README, LICENSE and the IBM Plex font license beside
 * `bin/` with two files.
 * There is one command, the executable `sherpa-review.mjs`. `sherpa-review-server.mjs` is the server module with
 * embedded UI, which the CLI loads with `import()` only in `sherpa-review server`. This keeps the worker loop,
 * which calls the CLI on every request, from loading the server.
 *
 * Builds run directly, without nested pnpm (tests call them too). The packages are listed
 * in this package's devDependencies for `pnpm -r` topological order. Otherwise these builds and the builds
 * in the packages' own tests would write the same files to dist in parallel.
 */
const bundles = [
    {
        pkg: '../server',
        script: 'build-server.mjs',
        file: 'dist/sherpa-review-server.mjs',
        out: 'sherpa-review-server.mjs',
        mode: 0o644,
    },
    { pkg: '../cli', script: 'build.mjs', file: 'dist/sherpa-review.mjs', out: 'sherpa-review.mjs', mode: 0o755 },
];

rmSync(distDir, { recursive: true, force: true });
mkdirSync(binDir, { recursive: true });
copyFileSync(resolve(repoRoot, 'README.md'), resolve(distDir, 'README.md'));
copyFileSync(resolve(repoRoot, 'LICENSE'), resolve(distDir, 'LICENSE'));
// The server module embeds IBM Plex fonts, and the OFL requires its text to travel with them.
// Sans and Mono ship the same license file, the test checks both.
copyFileSync(
    resolve(repoRoot, 'packages/ui/node_modules/@ibm/plex-sans/LICENSE.txt'),
    resolve(distDir, 'LICENSE-IBM-Plex.txt'),
);

for (const bundle of bundles) {
    const packageRoot = resolve(root, bundle.pkg);
    execFileSync(process.execPath, [bundle.script], { cwd: packageRoot, stdio: 'inherit' });

    const outfile = resolve(binDir, bundle.out);
    copyFileSync(resolve(packageRoot, bundle.file), outfile);
    // Set permissions explicitly: the copy inherits them from the build file, which inherits them from past builds.
    chmodSync(outfile, bundle.mode);
    process.stdout.write(`@sherpa/npm: ${outfile}\n`);
}

writePackageJson();

/** The published manifest. The version comes from the root `package.json`, the single source. */
function writePackageJson() {
    const rootManifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    const manifest = {
        name: PACKAGE_NAME,
        version: rootManifest.version,
        description: 'Local code review with an AI route through a PR diff, run by the agent in your harness',
        license: rootManifest.license,
        type: 'module',
        bin: { [PACKAGE_NAME]: 'bin/sherpa-review.mjs' },
        engines: rootManifest.engines,
        repository: { type: 'git', url: `git+${REPOSITORY}.git` },
        homepage: REPOSITORY,
        bugs: `${REPOSITORY}/issues`,
        keywords: ['code-review', 'pull-request', 'ai', 'agent', 'skill'],
    };
    const file = resolve(distDir, 'package.json');
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`@sherpa/npm: ${file}\n`);
}
