import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(root, '../..');
const distDir = resolve(root, 'dist');
const binDir = resolve(distDir, 'bin');

const DIRTY_SUFFIX = '-dirty';

/**
 * `dist/` is the skill distribution: SKILL.md beside `bin/` with two files. It is `dist`
 * that gets linked into the harness (`~/.claude/skills/sherpa-review`), so package source files stay out.
 * There is one command, the executable `sherpa-review.mjs`. `sherpa-review-server.mjs` is the server module with embedded UI,
 * which the CLI loads with `import()` only in `sherpa-review server`. This keeps the worker loop, which calls the CLI
 * on every request, from loading the server.
 *
 * Builds run directly, without nested pnpm (tests call them too). The packages are listed
 * in the skill's devDependencies for `pnpm -r` topological order. Otherwise these builds and the builds
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
copyFileSync(resolve(root, 'SKILL.md'), resolve(distDir, 'SKILL.md'));

for (const bundle of bundles) {
    const packageRoot = resolve(root, bundle.pkg);
    execFileSync(process.execPath, [bundle.script], { cwd: packageRoot, stdio: 'inherit' });

    const outfile = resolve(binDir, bundle.out);
    copyFileSync(resolve(packageRoot, bundle.file), outfile);
    // Set permissions explicitly: the copy inherits them from the build file, which inherits them from past builds.
    chmodSync(outfile, bundle.mode);
    process.stdout.write(`@sherpa/skill: ${outfile}\n`);
}

writeVersionFile();

/**
 * `dist/version.json` follows `distributionVersionSchema`. The server compares
 * this file from main with the embedded version. Release fields (`releasedAt`, `whatsNew`) are filled by
 * `scripts/release.mjs` in the target directory. They are absent from the build artifact.
 */
function writeVersionFile() {
    const version = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).version;
    const file = resolve(distDir, 'version.json');

    writeFileSync(
        file,
        `${JSON.stringify({ version, builtFrom: buildRevision(), releasedAt: null, whatsNew: null }, null, 4)}\n`,
    );
    process.stdout.write(`@sherpa/skill: ${file}\n`);
}

/**
 * Build source identifier: the HEAD hash plus `-dirty` if the working tree has
 * uncommitted or untracked changes. The distribution is built from the working tree, rather than
 * HEAD. Without the suffix, the hash would point to code the bundle was not built from.
 * The hash is full: a short hash is ambiguous in a large repository. Status is checked only within Sherpa's root,
 * because unrelated changes elsewhere in the repository have no bearing on the build.
 */
function buildRevision() {
    const head = git(['rev-parse', 'HEAD']);
    if (head === null) {
        return null;
    }
    // Could not determine tree state. Marking the build is more honest than claiming a clean hash.
    const status = git(['status', '--short', '--', '.']);
    return status === '' ? head : `${head}${DIRTY_SUFFIX}`;
}

function git(args) {
    try {
        return execFileSync('git', args, {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return null;
    }
}
