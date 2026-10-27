import { execFile } from 'node:child_process';

/**
 * Runs external commands for host plugins: PR discovery from the launch directory and detection
 * of the local checkout. Command failure is an outcome, not an exception. The caller decides
 * what to tell the user.
 */

/** Why the command has no exit code. */
export type CommandFailure = 'not-found' | 'timeout' | 'failed';

/** External command result. `exitCode: null` with `failure` means the process returned no code. */
export interface CommandOutcome {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly failure: CommandFailure | null;
}

/**
 * External command runner. Injected for tests so they don't call real VCS tools.
 * Local review needs `cwd` because it queries the named directory, not the launch directory.
 */
export type CommandRunner = (
    command: string,
    args: readonly string[],
    options?: { readonly cwd?: string },
) => Promise<CommandOutcome>;

/** Wait limit for one command. PR discovery may use the network and take seconds. */
export const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Command output limit. The PR status is printed in full with its description (tens of KB), so
 * it needs some room. Exceeding the limit counts as command failure.
 */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Real runner: finds the binary in PATH and inherits the CLI invocation's environment. Without `cwd`,
 * it also inherits the launch directory. Discovery answers "which PR belongs to the directory
 * I was launched from".
 */
export const runCommand: CommandRunner = async (command, args, options) =>
    new Promise<CommandOutcome>((resolve) => {
        execFile(
            command,
            [...args],
            {
                timeout: COMMAND_TIMEOUT_MS,
                maxBuffer: MAX_OUTPUT_BYTES,
                encoding: 'utf8',
                windowsHide: true,
                ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
            },
            (error, stdout, stderr) => {
                resolve(
                    error === null
                        ? { exitCode: 0, stdout, stderr, failure: null }
                        : { ...outcomeOfError(error), stdout, stderr },
                );
            },
        );
    });

/** The command exited with code 0. */
export function succeeded(outcome: CommandOutcome): boolean {
    return outcome.failure === null && outcome.exitCode === 0;
}

/** First nonempty line of the command's stderr. null means stderr is empty. */
export function firstLine(stderr: string): string | null {
    return (
        stderr
            .split('\n')
            .map((candidate) => candidate.trim())
            .find((candidate) => candidate !== '') ?? null
    );
}

/** Parses an execFile error: exit code, missing binary, timeout and everything else. */
function outcomeOfError(error: Error): Pick<CommandOutcome, 'exitCode' | 'failure'> {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'number') {
        return { exitCode: code, failure: null };
    }
    if (code === 'ENOENT') {
        return { exitCode: null, failure: 'not-found' };
    }
    // Exceeding maxBuffer also kills the process, but must not be called a timeout.
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return { exitCode: null, failure: 'failed' };
    }
    return { exitCode: null, failure: 'killed' in error && error.killed === true ? 'timeout' : 'failed' };
}

/** Why the command didn't respond: missing binary or the first nonempty line of its stderr. */
export function failureReason(bin: string, outcome: CommandOutcome): string {
    if (outcome.failure === 'not-found') {
        return `\`${bin}\` is not in PATH`;
    }
    const line = firstLine(outcome.stderr);
    return line === null ? `\`${bin}\` failed` : `${bin}: ${line}`;
}

/** Failure suffix for the error message: " — `<bin>` is not in PATH", " (<bin>: <stderr>)" or empty. */
export function failureDetail(bin: string, outcome: CommandOutcome): string {
    if (outcome.failure === 'not-found') {
        return ` — \`${bin}\` is not in PATH`;
    }
    const line = firstLine(outcome.stderr);
    return line === null ? '' : ` (${bin}: ${line})`;
}
