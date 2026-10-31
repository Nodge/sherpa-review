import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Build `dist/sherpa-review.mjs` once per run. Test files run in parallel forks,
 * and `build.mjs` overwrites the bundle non-atomically. If each file built it separately, another fork
 * could read a truncated file.
 */
export function setup(): void {
    execFileSync(process.execPath, ['build.mjs'], { cwd: packageRoot, stdio: 'pipe' });
}
