import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Builds the UI and the `sherpa-review` package, checks that the built CLI and the generated manifest carry the
 * version of `packages/npm/package.json` and lists what `npm publish` would upload. The Release workflow runs it
 * before `changeset publish`, CI on every push.
 *
 * `--skip-build` checks an existing `packages/npm/dist`.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(repoRoot, 'packages/npm/dist');

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== '--skip-build');
if (unknown.length > 0) {
    fail(`unknown arguments: ${unknown.join(' ')}. Usage: pnpm build:package [--skip-build]`);
}

const version = JSON.parse(readFileSync(resolve(repoRoot, 'packages/npm/package.json'), 'utf8')).version;

if (!args.includes('--skip-build')) {
    run('pnpm', ['--filter', '@sherpa/ui', 'build']);
    run('pnpm', ['--filter', 'sherpa-review', 'build']);
}

const manifest = JSON.parse(readFileSync(resolve(distDir, 'package.json'), 'utf8'));
if (manifest.version !== version) {
    fail(`packages/npm/dist/package.json has ${manifest.version}, packages/npm/package.json has ${version}. Rebuild.`);
}
const cliVersion = execFileSync(process.execPath, [resolve(distDir, 'bin/sherpa-review.mjs'), '--version'], {
    encoding: 'utf8',
}).trim();
if (cliVersion !== version) {
    fail(`the built CLI reports ${cliVersion}, packages/npm/package.json has ${version}. Rebuild.`);
}

const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: distDir, encoding: 'utf8' }));
process.stdout.write(`\n${manifest.name}@${version}, ${String(packed.files.length)} files:\n`);
for (const file of packed.files) {
    process.stdout.write(`  ${file.path}  ${String(file.size)} B\n`);
}

function run(command, commandArgs) {
    execFileSync(command, commandArgs, { cwd: repoRoot, stdio: 'inherit' });
}

function fail(message) {
    process.stderr.write(`build-package: ${message}\n`);
    process.exit(1);
}
