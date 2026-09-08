import { execFile } from 'node:child_process';

/**
 * Resolve the PR from the launch directory (`docs/protocol.md §8`): git checkout → current branch → branch PR.
 * Explicit `--pr` and `SHERPA_PR` take precedence. This is called only when neither is set.
 *
 * No step may crash the CLI. Any failure returns `unavailable` with a one-line
 * reason. `resolvePrKey` decides what to tell the user.
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

/** External command runner, injected so tests never call the real VCS executable. */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandOutcome>;

export type PrDiscovery =
    | { readonly kind: 'found'; readonly prKey: string }
    /** One-line reason for the user hint, with no trailing period. */
    | { readonly kind: 'unavailable'; readonly hint: string };


const INFO_ARGS = ['info', '--json'] as const;
const PR_STATUS_ARGS = ['pr', 'status', '--json'] as const;

/** Host PR key (`packages/server/src/hosts/select.ts`). */


/** PR status uses the network (measured at 1.3 s). Local branch info takes under 0.1 s. */
const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Command output limit. PR status returns the whole PR, including its description
 * (54 KB on a real PR), so leave room. Exceeding the limit counts as command failure.
 */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Number of characters from an external error included in the hint. */
const DETAIL_MAX_CHARS = 120;

/**
 * PR of the current Git checkout branch. Two read-only commands, ~1.4 s total on a real checkout
 * (measured 2026-08-22: branch info 0.07–0.09 s, PR status 1.3 s with a PR
 * and 0.66 s without one).
 *
 * Branch info distinguishes "not a Git checkout" from "branch has no PR":
 * otherwise we would have to recognize stderr text, which the VCS may change.
 */
export async function discoverPrKeyFromCheckout(run: CommandRunner): Promise<PrDiscovery> {
    const info = await run(VCS_BIN, INFO_ARGS);
    if (info.failure !== null) {
        return { kind: 'unavailable', hint: failureHint(info.failure, 'branch info') };
    }
    if (info.exitCode !== 0) {
        // Outside a checkout: exit code 1 and stderr "Not a Git repository.".
        return { kind: 'unavailable', hint: `not a Git checkout${detailOf(info.stderr)}` };
    }

    const branch = parseBranch(info.stdout);

    const status = await run(VCS_BIN, PR_STATUS_ARGS);
    if (status.failure !== null) {
        return { kind: 'unavailable', hint: failureHint(status.failure, 'PR status') };
    }
    if (status.exitCode !== 0) {
        // Branch without a PR: exit code 1 and stderr "No pull request for branch '<branch>'".
        return { kind: 'unavailable', hint: `${branchLabel(branch)} has no PR${detailOf(status.stderr)}` };
    }

    const prId = parsePrId(status.stdout);
    if (prId === null) {
        return { kind: 'unavailable', hint: 'PR status printed something Sherpa cannot read' };
    }
    return { kind: 'found', prKey: `${HOST_PREFIX}${String(prId)}` };
}

/**
 * Checkout branch from branch info. Returns null if the field is absent or parsing fails.
 * Example, a single object without a wrapper:
 * `{"repository":"quillmart/quillmart","remote":"alice/issue-2301","author":"alice",…,"branch":"issue-2301",…}`.
 * Only the hint needs the branch, so its absence alone does not break discovery.
 */
function parseBranch(stdout: string): string | null {
    const info = parseJsonObject(stdout);
    const branch = info?.branch;
    return typeof branch === 'string' && branch !== '' ? branch : null;
}

/**
 * PR number from PR status. Returns null if parsing fails or numeric `id` is absent.
 * Example: `{"id":9002,"url":"https://github.com/quillmart/quillmart/pull/9002",
 * "author":"alice","summary":…,"description":…,"status":"conflicts","issues":…,
 * "from_branch":…,"to_branch":…,"reviewers":…,"created_at":…}`.
 * `--short` would return one short line instead of tens of kilobytes, but it cannot be used with `--json`,
 * and parsing free text is worse than reading an object field.
 */
function parsePrId(stdout: string): number | null {
    const status = parseJsonObject(stdout);
    const id = status?.id;
    return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
}

function failureHint(failure: CommandFailure, label: string): string {
    switch (failure) {
        case 'not-found':
            return '`git` is not in PATH. Sherpa uses it to detect the PR of the current branch';
        case 'timeout':
            return `\`${label}\` did not answer within ${String(Math.round(COMMAND_TIMEOUT_MS / 1000))} s`;
        case 'failed':
            return `\`${label}\` could not be run`;
    }
}

function branchLabel(branch: string | null): string {
    return branch === null ? 'the current branch' : `branch \`${branch}\``;
}

/** First meaningful line of external stderr. It explains the failure better than our guesses. */
function detailOf(stderr: string): string {
    const line = stderr
        .split('\n')
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate !== '');
    if (line === undefined) {
        return '';
    }
    const capped = line.length > DETAIL_MAX_CHARS ? `${line.slice(0, DETAIL_MAX_CHARS)}…` : line;
    return ` (VCS: ${capped})`;
}

/**
 * Real runner: finds the executable in PATH and inherits cwd and environment from the CLI call.
 * Discovery answers "which PR belongs to the directory I was launched from".
 */
export const runVcsCommand: CommandRunner = async (command, args) =>
    new Promise<CommandOutcome>((resolve) => {
        execFile(
            command,
            [...args],
            {
                timeout: COMMAND_TIMEOUT_MS,
                maxBuffer: MAX_OUTPUT_BYTES,
                encoding: 'utf8',
                windowsHide: true,
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
