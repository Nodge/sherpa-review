import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(root, '../cli');

// Same as `pnpm --filter @sherpa/cli build`, without nested pnpm: a test also invokes the build.
// @sherpa/cli is in the skill's devDependencies to order `pnpm -r` topologically:
// otherwise this build and the CLI tests' build write packages/cli/dist/sherpa.mjs in parallel.
execFileSync(process.execPath, ['build.mjs'], { cwd: cliRoot, stdio: 'inherit' });

// The skill is distributed as a directory: SKILL.md beside the single CLI executable.
const outfile = resolve(root, 'bin/sherpa.mjs');
mkdirSync(dirname(outfile), { recursive: true });
copyFileSync(resolve(cliRoot, 'dist/sherpa.mjs'), outfile);
chmodSync(outfile, 0o755);

process.stdout.write(`@sherpa/skill: ${outfile}\n`);
