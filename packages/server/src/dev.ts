import fs from 'node:fs/promises';
import path from 'node:path';

import { ServerAlreadyRunningError } from './errors.js';
import { DEFAULT_SHERPA_DIR, manifestPathFor } from './paths.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';

/** Default built UI: `packages/ui/dist` beside the server package. */
const DEFAULT_UI_DIR = path.resolve(import.meta.dirname, '../../ui/dist');

/**
 * Dev server launch: `pnpm --filter @sherpa/server dev --pr <key> [--sherpa-dir <path>] [--ui <path>]`.
 * Prints the port, manifest path and ready-to-use UI link. Runs until SIGINT/SIGTERM.
 */
async function main(argv: readonly string[]): Promise<number> {
    const prKey = readOption(argv, '--pr');
    if (prKey === null) {
        process.stderr.write('Usage: dev --pr <PR key> [--sherpa-dir <path>] [--ui <dist path>]\n');
        return 1;
    }

    const sherpaDir = readOption(argv, '--sherpa-dir') ?? DEFAULT_SHERPA_DIR;
    const uiDir = await resolveUiDir(readOption(argv, '--ui'));

    let server: SherpaServer;
    try {
        server = await startServer(uiDir === null ? { prKey, sherpaDir } : { prKey, sherpaDir, uiDir });
    } catch (error) {
        if (error instanceof ServerAlreadyRunningError) {
            process.stderr.write(`${error.message}\n`);
            return 1;
        }
        throw error;
    }

    process.stdout.write(
        [
            `sherpa-server: PR ${server.prKey}`,
            `port:    ${String(server.port)}`,
            `manifest: ${manifestPathFor(sherpaDir, server.prKey)}`,
            uiDir === null
                ? 'UI: not built. Run `pnpm --filter @sherpa/ui build`, then restart with `--ui <path>`'
                : // The token is in the fragment. It is not sent to the server but survives a page reload.
                  `UI: http://127.0.0.1:${String(server.port)}/#token=${server.token}`,
            'Ctrl+C to stop.',
            '',
        ].join('\n'),
    );

    const stop = (signal: NodeJS.Signals): void => {
        process.stdout.write(`\nsherpa-server: ${signal}, stopping…\n`);
        void server
            .close()
            .then(() => {
                process.exitCode = 0;
            })
            .catch((error: unknown) => {
                process.stderr.write(`sherpa-server: error during shutdown: ${String(error)}\n`);
                process.exitCode = 1;
            });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    return 0;
}

/**
 * UI directory: an explicit `--ui` (fails if missing, so a typo does not pass silently)
 * or the default build, if it exists.
 */
async function resolveUiDir(option: string | null): Promise<string | null> {
    if (option !== null) {
        const dir = path.resolve(option);
        if (!(await isDirectory(dir))) {
            throw new Error(`UI directory ${dir} does not exist. Build the UI (\`pnpm --filter @sherpa/ui build\`).`);
        }
        return dir;
    }
    return (await isDirectory(DEFAULT_UI_DIR)) ? DEFAULT_UI_DIR : null;
}

async function isDirectory(dir: string): Promise<boolean> {
    try {
        return (await fs.stat(dir)).isDirectory();
    } catch {
        return false;
    }
}

function readOption(argv: readonly string[], name: string): string | null {
    const index = argv.indexOf(name);
    if (index === -1) {
        return null;
    }
    return argv[index + 1] ?? null;
}

const code = await main(process.argv.slice(2));
if (code !== 0) {
    process.exitCode = code;
}
