import { ServerAlreadyRunningError } from './errors.js';
import { DEFAULT_SHERPA_DIR, manifestPathFor } from './paths.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';

/**
 * Development server: `pnpm --filter @sherpa/server dev --pr <key> [--sherpa-dir <path>]`.
 * Prints the port and manifest path and waits for SIGINT/SIGTERM.
 */
async function main(argv: readonly string[]): Promise<number> {
    const prKey = readOption(argv, '--pr');
    if (prKey === null) {
        process.stderr.write('Usage: dev --pr <PR key> [--sherpa-dir <path>]\n');
        return 1;
    }

    const sherpaDir = readOption(argv, '--sherpa-dir') ?? DEFAULT_SHERPA_DIR;

    let server: SherpaServer;
    try {
        server = await startServer({ prKey, sherpaDir });
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
