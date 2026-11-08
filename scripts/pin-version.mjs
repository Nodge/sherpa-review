import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Pins the skill and the Claude Code plugin to the version of `packages/npm/package.json`: the `npx` commands in
 * SKILL.md and `version` in `.claude-plugin/plugin.json`. `ci:version` runs it after `changeset version`, so the
 * Release PR carries the new pins.
 *
 * `--check` changes nothing and exits 1 if a pin differs from the package version. CI runs it on every push.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NPX_SPEC = /(npx -y sherpa-review@)([^\s`'"]+)/gu;

/** Each pin: the file and a function that returns its contents with the given version. */
const pins = [
    {
        file: 'skills/sherpa-review/SKILL.md',
        pin(text, version) {
            if (text.match(NPX_SPEC) === null) {
                fail(`${this.file} has no \`npx -y sherpa-review@<version>\` command to pin.`);
            }
            return text.replaceAll(NPX_SPEC, `$1${version}`);
        },
    },
    {
        file: '.claude-plugin/plugin.json',
        pin(text, version) {
            return `${JSON.stringify({ ...JSON.parse(text), version }, null, 2)}\n`;
        },
    },
];

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== '--check');
if (unknown.length > 0) {
    fail(`unknown arguments: ${unknown.join(' ')}. Usage: node scripts/pin-version.mjs [--check]`);
}
const check = args.includes('--check');

const version = JSON.parse(readFileSync(resolve(repoRoot, 'packages/npm/package.json'), 'utf8')).version;
const stale = [];
for (const pin of pins) {
    const path = resolve(repoRoot, pin.file);
    const text = readFileSync(path, 'utf8');
    const pinned = pin.pin(text, version);
    if (pinned === text) {
        continue;
    }
    stale.push(pin.file);
    if (!check) {
        writeFileSync(path, pinned);
    }
}

if (check && stale.length > 0) {
    fail(`not pinned to sherpa-review@${version}: ${stale.join(', ')}. Run \`node scripts/pin-version.mjs\`.`);
}
process.stdout.write(
    stale.length === 0 || check
        ? `pin-version: pinned to sherpa-review@${version}\n`
        : `pin-version: ${stale.join(', ')} pinned to sherpa-review@${version}\n`,
);

function fail(message) {
    process.stderr.write(`pin-version: ${message}\n`);
    process.exit(1);
}
