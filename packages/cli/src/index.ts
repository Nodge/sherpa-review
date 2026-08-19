import { run } from './cli.js';
import { checkNodeVersion } from './runtime.js';

/** The `sherpa` CLI entry point (spec §1/C1): runtime check, command execution, exit code. */
async function main(): Promise<number> {
    const versionError = checkNodeVersion(process.versions.node);
    if (versionError !== null) {
        process.stderr.write(`${versionError}\n`);
        return 1;
    }

    return run(process.argv.slice(2), {
        env: process.env,
        out: (text) => {
            process.stdout.write(`${text}\n`);
        },
        err: (text) => {
            process.stderr.write(`${text}\n`);
        },
    });
}

process.exitCode = await main();
