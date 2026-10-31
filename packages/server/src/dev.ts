import path from 'node:path';

import { ServerAlreadyRunningError } from './errors.js';
import { ALL_HOSTS, FEEDBACK_CHANNEL, UPDATE_CHANNEL } from './hosts/all.js';
import { formatUiUrl, readOption, resolveUiDir, UI_BUILD_HINT } from './launch.js';
import { readListenHost } from './listen-host.js';
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
        process.stderr.write(
            'Usage: dev --pr <PR key> [--sherpa-dir <path>] [--ui <dist path>] ' +
                '[--install-dir <path>] [--repo <project directory>] [--base <ref>] [--branch <branch>]\n',
        );
        return 1;
    }

    const sherpaDir = readOption(argv, '--sherpa-dir') ?? DEFAULT_SHERPA_DIR;
    const uiDir = await resolveUiDir(readOption(argv, '--ui'));
    // As in the bundle, the gallery and e2e need the update hint from the install directory.
    const installDir = readOption(argv, '--install-dir');
    const host = readListenHost(process.env);
    // Local review uses the same project directory, comparison base and branch arguments as the bundle.
    const repo = readOption(argv, '--repo');
    const reviewBase = readOption(argv, '--base');
    const reviewBranch = readOption(argv, '--branch');

    // Idle shutdown is disabled. The dev server holds the developer terminal open,
    // and dying unexpectedly during coding would get in the way. Ctrl+C stops it.
    const options = {
        prKey,
        sherpaDir,
        hosts: ALL_HOSTS,
        host,
        idleSeconds: 0,
        ...(repo === null ? {} : { repo: path.resolve(repo) }),
        ...(reviewBase === null ? {} : { base: reviewBase }),
        ...(reviewBranch === null ? {} : { branch: reviewBranch }),
        updateChannel: UPDATE_CHANNEL,
        updateCheck: installDir === null ? {} : { installDir },
        feedbackChannel: FEEDBACK_CHANNEL({ installDir }),
    };

    let server: SherpaServer;
    try {
        server = await startServer(uiDir === null ? options : { ...options, assets: directoryAssets(uiDir) });
    } catch (error) {
        if (error instanceof ServerAlreadyRunningError) {
            process.stderr.write(`${error.message}\n`);
            return 1;
        }
        throw error;
    }

    process.stdout.write(
        [
            `sherpa-review-server: PR ${server.prKey}`,
            `port:    ${String(server.port)}`,
            `manifest: ${manifestPathFor(sherpaDir, server.prKey)}`,
            uiDir === null
                ? `UI: not built. ${UI_BUILD_HINT}, then restart with \`--ui <path>\``
                : formatUiUrl(server.port, server.token, server.uiHost),
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
                process.stderr.write(`sherpa-review-server: error during shutdown: ${String(error)}\n`);
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
