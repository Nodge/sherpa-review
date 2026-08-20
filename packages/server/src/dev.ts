import { ServerAlreadyRunningError } from './errors.js';
import { formatUiUrl, readOption, resolveUiDir, UI_BUILD_HINT } from './launch.js';
import { DEFAULT_SHERPA_DIR, manifestPathFor } from './paths.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { directoryAssets } from './static.js';

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
        server = await startServer(
            uiDir === null ? { prKey, sherpaDir } : { prKey, sherpaDir, assets: directoryAssets(uiDir) },
        );
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
                ? `UI: not built. ${UI_BUILD_HINT}, then restart with \`--ui <path>\``
                : formatUiUrl(server.port, server.token),
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

const code = await main(process.argv.slice(2));
if (code !== 0) {
    process.exitCode = code;
}
