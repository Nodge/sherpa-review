import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Prepares an npm release: builds the UI and the `sherpa-review` package, checks that the built CLI and the
 * package manifest carry the root `package.json` version, lists what `npm publish` would upload and prints the
 * publish command. It publishes nothing and calls no git: a person runs the printed command.
 *
 * `--skip-build` checks an existing `packages/npm/dist`.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(repoRoot, 'packages/npm/dist');

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== '--skip-build');
if (unknown.length > 0) {
    fail(`unknown arguments: ${unknown.join(' ')}. Usage: pnpm release [--skip-build]`);
}

const version = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).version;

if (!args.includes('--skip-build')) {
    run('pnpm', ['--filter', '@sherpa/ui', 'build']);
    run('pnpm', ['--filter', '@sherpa/npm', 'build']);
}

const manifest = JSON.parse(readFileSync(resolve(distDir, 'package.json'), 'utf8'));
if (manifest.version !== version) {
    fail(`packages/npm/dist/package.json has ${manifest.version}, the root package.json has ${version}. Rebuild.`);
}
const cliVersion = execFileSync(process.execPath, [resolve(distDir, 'bin/sherpa-review.mjs'), '--version'], {
    encoding: 'utf8',
}).trim();
if (cliVersion !== version) {
    fail(`the built CLI reports ${cliVersion}, the root package.json has ${version}. Rebuild.`);
}

const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: distDir, encoding: 'utf8' }));
process.stdout.write(`\n${manifest.name}@${version}, ${String(packed.files.length)} files:\n`);
for (const file of packed.files) {
    process.stdout.write(`  ${file.path}  ${String(file.size)} B\n`);
}
process.stdout.write(`\nPublish it:\n\n  npm publish ${shellQuote(relative(process.cwd(), distDir) || '.')}\n`);

/** A word for a POSIX shell, the same rule as `shellQuote` in `packages/cli/src/format.ts`. */
function shellQuote(value) {
    return /^[\w@%+:,./-][\w@%+=:,./-]*$/u.test(value) ? value : `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

function run(command, commandArgs) {
    execFileSync(command, commandArgs, { cwd: repoRoot, stdio: 'inherit' });
}

function fail(message) {
    process.stderr.write(`release: ${message}\n`);
    process.exit(1);
}
