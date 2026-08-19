import { PROTOCOL_VERSION } from '@sherpa/protocol';

import { checkNodeVersion } from './runtime.js';
import { CLI_VERSION } from './version.js';

/**
 * Entry point for the `sherpa` CLI (spec §1/C1).
 * M0-T1 stub: worker and task commands arrive in M0-T5.
 */
function main(argv: readonly string[]): number {
    const versionError = checkNodeVersion(process.versions.node);
    if (versionError !== null) {
        process.stderr.write(`${versionError}\n`);
        return 1;
    }

    if (argv.includes('--version') || argv.includes('-v')) {
        process.stdout.write(`${CLI_VERSION}\n`);
        return 0;
    }

    process.stdout.write(
        [
            `sherpa ${CLI_VERSION} (protocol ${PROTOCOL_VERSION})`,
            'Commands arrive in M0-T5. Only --version is available for now.',
            '',
        ].join('\n'),
    );
    return 0;
}

process.exitCode = main(process.argv.slice(2));
