import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = path.resolve(packageRoot, '../ui');

/**
 * Builds `dist/sherpa-server.mjs` once for the entire run: test files run in parallel forks,
 * and esbuild overwrites the bundle non-atomically. If each file built it separately, another fork
 * could read a truncated file.
 *
 * The build chain does not build the UI (the server bundle only embeds the existing `ui/dist`), but
 * `dist` is not stored in git. On a clean checkout we build the UI here, otherwise the bundle has nothing to embed.
 */
export function setup(): void {
    if (!existsSync(path.join(uiRoot, 'dist', 'index.html'))) {
        execFileSync('pnpm', ['--filter', '@sherpa/ui', 'build'], { cwd: uiRoot, stdio: 'pipe' });
    }
    execFileSync(process.execPath, ['build-server.mjs'], { cwd: packageRoot, stdio: 'pipe' });
}
