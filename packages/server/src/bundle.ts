import path from 'node:path';

import { localVcsOfPrKey } from '@sherpa/protocol';

import { ServerAlreadyRunningError } from './errors.js';
import { feedbackOptionsFor } from './feedback-launch.js';
import { readLocalHostState } from './hosts/local/index.js';
import { formatIdlePeriod, readIdleSeconds } from './idle.js';
import { readOption } from './launch.js';
import { readListenHost } from './listen-host.js';
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
const USAGE =
    'Usage: sherpa-server.mjs --pr <PR key> [--sherpa-dir <path>] [--install-dir <path>] ' +
    '[--repo <project directory>] [--base <ref>] [--branch <branch>]';

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

    // Local review: project directory, comparison base and the key's branch. They come from
    // `sherpa up --local`. A daemon restart uses the saved key state.
    const repo = readOption(argv, '--repo');
    const base = readOption(argv, '--base');
    const branch = readOption(argv, '--branch');
    if (repo === null && localReviewUnconfigured(prKey, sherpaDir)) {
        writeLog(
            `no review host: key ${prKey} is local, but neither --repo nor a saved local-host.json is available. ` +
                'Run `sherpa up --local <path>` from the project directory',
        );
    }

    const idleSeconds = readIdleSeconds(process.env);
    const host = readListenHost(process.env);

    let server: SherpaServer;
    try {
        server = await startServer({
            prKey,
            sherpaDir,
            assets: bundledAssets(UI_ASSETS),
            idleSeconds,
            host,
            ...(repo === null ? {} : { repo: path.resolve(repo) }),
            ...(base === null ? {} : { base }),
            ...(branch === null ? {} : { branch }),
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

/** A local key without a project directory has no host. Explain why to the user. */
function localReviewUnconfigured(prKey: string, sherpaDir: string): boolean {
    return localVcsOfPrKey(prKey) !== null && readLocalHostState(sherpaDir, prKey) === null;
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
