import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { esbuildInputs, thirdPartyNotices } from './third-party-licenses.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(root, '../..');
const distDir = resolve(root, 'dist');
const binDir = resolve(distDir, 'bin');

/** npm package name: `npx sherpa-review` and the skill stub call it by this name. */
const PACKAGE_NAME = 'sherpa-review';
const REPOSITORY = 'https://github.com/Nodge/sherpa-review';

/**
 * `dist/` is the `sherpa-review` npm package: package.json, README, LICENSE, the IBM Plex font license and
 * third-party license notices beside `bin/` with two files.
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
        meta: 'dist/sherpa-review-server.meta.json',
        out: 'sherpa-review-server.mjs',
        mode: 0o644,
    },
    {
        pkg: '../cli',
        script: 'build.mjs',
        file: 'dist/sherpa-review.mjs',
        meta: 'dist/sherpa-review.meta.json',
        out: 'sherpa-review.mjs',
        mode: 0o755,
    },
];

/** Modules and emitted files of the UI build, which the server module embeds. Written by `vite.config.ts`. */
const uiRoot = resolve(repoRoot, 'packages/ui');
const uiModulesFile = resolve(uiRoot, 'build/bundled-modules.json');
const uiModules = readUiModules();

/** Code vite and rolldown inject into the UI build as virtual modules (`\0vite/…`, `\0rolldown/…`). */
const requireFromUi = createRequire(resolve(uiRoot, 'package.json'));
const vitePackageJson = requireFromUi.resolve('vite/package.json');
const virtualPackages = {
    vite: dirname(vitePackageJson),
    rolldown: dirname(createRequire(vitePackageJson).resolve('rolldown/package.json')),
};

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

const bundledModules = [...uiModules];
for (const bundle of bundles) {
    const packageRoot = resolve(root, bundle.pkg);
    execFileSync(process.execPath, [bundle.script], { cwd: packageRoot, stdio: 'inherit' });
    bundledModules.push(...esbuildInputs(readMetafile(packageRoot, bundle), packageRoot));

    const outfile = resolve(binDir, bundle.out);
    copyFileSync(resolve(packageRoot, bundle.file), outfile);
    // Set permissions explicitly: the copy inherits them from the build file, which inherits them from past builds.
    chmodSync(outfile, bundle.mode);
    process.stdout.write(`@sherpa/npm: ${outfile}\n`);
}

writeNotices();
writePackageJson();

/** MIT, BSD and ISC require the copyright and license text to travel with the bundled code. */
function writeNotices() {
    const file = resolve(distDir, 'THIRD-PARTY-LICENSES.txt');
    try {
        writeFileSync(file, thirdPartyNotices(bundledModules, virtualPackages));
    } catch (error) {
        fail(error.message);
    }
    process.stdout.write(`@sherpa/npm: ${file}\n`);
}

/**
 * The UI module list, checked against `ui/dist`: a list from an older build or another output directory would pair
 * the notices with the wrong assets.
 */
function readUiModules() {
    const rebuild = `Run \`pnpm --filter @sherpa/ui build\` first, then build the package.`;
    let list;
    try {
        list = JSON.parse(readFileSync(uiModulesFile, 'utf8'));
    } catch {
        fail(`@sherpa/npm: no UI module list in ${uiModulesFile}. ${rebuild}`);
    }
    const uiDist = resolve(uiRoot, 'dist');
    const built = walk(uiDist).map((file) => relative(uiDist, file).split(sep).join(posix.sep)).sort();
    if (!Array.isArray(list.files) || JSON.stringify(list.files) !== JSON.stringify(built)) {
        fail(`@sherpa/npm: ${uiModulesFile} does not describe the files in ${uiDist}. ${rebuild}`);
    }
    return list.modules;
}

/** The esbuild metafile of a bundle, checked to describe the file being copied. */
function readMetafile(packageRoot, bundle) {
    const metafile = JSON.parse(readFileSync(resolve(packageRoot, bundle.meta), 'utf8'));
    const outputs = Object.keys(metafile.outputs);
    if (outputs.length !== 1 || outputs[0] !== bundle.file
        || metafile.outputs[bundle.file].bytes !== statSync(resolve(packageRoot, bundle.file)).size) {
        fail(`@sherpa/npm: ${bundle.meta} in ${packageRoot} does not describe ${bundle.file}. Rebuild the package.`);
    }
    return metafile;
}

function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = resolve(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
    });
}

function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}

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
