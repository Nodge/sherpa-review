import path from 'node:path';

import { ServerAlreadyRunningError } from './errors.js';
import { feedbackOptionsFor } from './feedback-launch.js';
import { formatIdlePeriod, readIdleSeconds } from './idle.js';
import { readOption } from './launch.js';
import { DEFAULT_SHERPA_DIR, manifestPathFor } from './paths.js';
import { checkNodeVersion } from './runtime.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { bundledAssets } from './static.js';
import { UI_ASSETS } from './ui-assets.js';

/**
 * Server bundle entry point `sherpa-server.mjs`: foreground server process for one PR.
 * `sherpa up` handles daemonization, logging and waiting for the manifest. This is just the server,
 * that lives until SIGINT/SIGTERM or the idle threshold (`idle.ts`). The UI is embedded in the bundle and served
 * from memory (docs/protocol.md §2).
 *
 * No token in stdout: output goes to a log file that outlives the server, and the CLI prints the link with the token
 * after reading the manifest.
 */
const USAGE = 'Usage: sherpa-server.mjs --pr <PR key> [--sherpa-dir <path>] [--install-dir <path>]';

async function main(argv: readonly string[]): Promise<number> {
    const versionError = checkNodeVersion(process.versions.node);
    if (versionError !== null) {
        process.stderr.write(`${versionError}\n`);
        return 1;
    }

    const prKey = readOption(argv, '--pr');
    if (prKey === null) {
        process.stderr.write(`${USAGE}\n`);
        return 1;
    }

    // The process inherits its launcher's cwd, so resolve the state path to an absolute path.
    const sherpaDir = path.resolve(readOption(argv, '--sherpa-dir') ?? DEFAULT_SHERPA_DIR);

    // Only the CLI knows where the distribution is installed. The server compares this version with main.
    const installDir = readOption(argv, '--install-dir');

    const idleSeconds = readIdleSeconds(process.env);

    let server: SherpaServer;
    try {
        server = await startServer({
            prKey,
            sherpaDir,
            assets: bundledAssets(UI_ASSETS),
            idleSeconds,
            updateCheck: installDir === null ? {} : { installDir },
            feedback: feedbackOptionsFor(installDir),
            onIdleStop: (seconds) => {
                writeLog(`idle shutdown: ${formatIdlePeriod(seconds)} without requests or open connections`);
            },
        });
    } catch (error) {
        // Two launches raced: another server already claimed the manifest, so this process exits.
        const prefix = error instanceof ServerAlreadyRunningError ? 'not starting' : 'startup error';
        writeLog(`${prefix}: ${messageOf(error)}`);
        return 1;
    }

    writeLog(
        `start: PR ${server.prKey}, port ${String(server.port)}, PID ${String(process.pid)}, ` +
            `manifest ${manifestPathFor(sherpaDir, server.prKey)}`,
    );

    const stop = (signal: NodeJS.Signals): void => {
        writeLog(`${signal}: shutting down`);
        void server
            .close()
            .then(() => {
                process.exitCode = 0;
            })
            .catch((error: unknown) => {
                writeLog(`shutdown error: ${messageOf(error)}`);
                process.exitCode = 1;
            });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    return 0;
}

function writeLog(text: string): void {
    process.stdout.write(`${new Date().toISOString()} sherpa-server: ${text}\n`);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const code = await main(process.argv.slice(2));
if (code !== 0) {
    process.exitCode = code;
}
