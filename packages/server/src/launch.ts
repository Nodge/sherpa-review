import fs from 'node:fs/promises';
import path from 'node:path';

/** Default built UI: `packages/ui/dist` beside the server package. */
const DEFAULT_UI_DIR = path.resolve(import.meta.dirname, '../../ui/dist');

/** Shared instructions for a missing UI build, used in development launches, the skill and errors. */
export const UI_BUILD_HINT = 'build the UI: `pnpm --filter @sherpa/ui build`';

export function readOption(argv: readonly string[], name: string): string | null {
    const index = argv.indexOf(name);
    if (index === -1) {
        return null;
    }
    return argv[index + 1] ?? null;
}

/**
 * UI directory: an explicit `--ui` (fails if missing, so a typo does not pass silently)
 * or the default build, if it exists.
 */
export async function resolveUiDir(option: string | null): Promise<string | null> {
    if (option !== null) {
        const dir = path.resolve(option);
        if (!(await isDirectory(dir))) {
            throw new Error(`UI directory ${dir} does not exist. ${UI_BUILD_HINT}.`);
        }
        return dir;
    }
    return (await isDirectory(DEFAULT_UI_DIR)) ? DEFAULT_UI_DIR : null;
}

export async function isDirectory(dir: string): Promise<boolean> {
    try {
        return (await fs.stat(dir)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * UI URL for development launches. The token is in the fragment, so it never reaches the server but survives
 * a page reload. `sherpa up` prints the same URL for the reviewer, built in the CLI.
 */
export function formatUiUrl(port: number, token: string): string {
    return `UI: http://127.0.0.1:${String(port)}/#t=${token}`;
}
