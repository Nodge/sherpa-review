import { run } from './cli.js';
import { CLI_HOSTS } from './hosts/all.js';
import { checkNodeVersion } from './runtime.js';

/**
 * Node flags for the server daemon. Review hosts and channels may use a custom CA, which is
 * in the system store, but Node only trusts its own bundle by default and fails with
 * `SELF_SIGNED_CERT_IN_CHAIN`. The flag appeared in 22.15/23.8. Older runtimes won't receive it.
 */
const DAEMON_NODE_FLAGS = ['--use-system-ca'];

/** `sherpa-review` CLI entry point: runtime check, command invocation, exit code. */
async function main(): Promise<number> {
    const versionError = checkNodeVersion(process.versions.node);
    if (versionError !== null) {
        process.stderr.write(`${versionError}\n`);
        return 1;
    }

    return run(process.argv.slice(2), {
        env: process.env,
        hosts: CLI_HOSTS,
        out: (text) => {
            process.stdout.write(`${text}\n`);
        },
        err: (text) => {
            process.stderr.write(`${text}\n`);
        },
        daemonNodeFlags: DAEMON_NODE_FLAGS,
    });
}

process.exitCode = await main();
