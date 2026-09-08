import { run } from './cli.js';
import { checkNodeVersion } from './runtime.js';

/** `sherpa` CLI entry point: runtime check, command invocation, exit code. */
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
