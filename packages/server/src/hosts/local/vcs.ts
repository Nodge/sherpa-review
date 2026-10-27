import { execFile } from 'node:child_process';

import type { FileChangeType } from '@sherpa/protocol';

/**
 * Boundary between a working-tree snapshot and version control: the `LocalVcs` interface
 * and a shared command runner. Everything the snapshot asks the VCS is listed here. Output parsing
 * lives inside the backend (for example, `git-vcs.ts`), which returns parsed structures.
 */

/** Output limit for one command: a working-tree patch can be megabytes long. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Commands run locally: one second is plenty, but a checkout on FUSE can be slow. */
const COMMAND_TIMEOUT_MS = 30_000;

/** Command result. stdout contains bytes: `show` can return binary contents too. */
export interface CommandOutcome {
    readonly code: number | null;
    readonly stdout: Buffer;
    readonly stderr: string;
}

/**
 * VCS command runner with a fixed binary and working directory (the project directory).
 * Inject it for tests so they do not call the real VCS.
 */
export type CommandRunner = (args: readonly string[]) => Promise<CommandOutcome>;

/** Real command runner: binary from PATH, working directory set to the project directory. */
export function commandRunnerIn(bin: string, cwd: string): CommandRunner {
    return async (args) =>
        new Promise<CommandOutcome>((resolve) => {
            execFile(
                bin,
                [...args],
                { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'buffer' },
                (error, stdout, stderr) => {
                    const code = error === null ? 0 : numericCode(error);
                    resolve({ code, stdout, stderr: stderr.toString('utf8') });
                },
            );
        });
}

function numericCode(error: Error): number | null {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'number' ? code : null;
}

/** Bytes from a successful command. A nonzero exit code throws with the first meaningful stderr line. */
export async function commandBytes(
    run: CommandRunner,
    bin: string,
    args: readonly string[],
): Promise<Buffer> {
    const outcome = await run(args);
    if (outcome.code !== 0) {
        throw new Error(`\`${bin} ${args.join(' ')}\` failed${detailOf(outcome.stderr)}`);
    }
    return outcome.stdout;
}

/** Text output of a successful command. */
export async function commandText(
    run: CommandRunner,
    bin: string,
    args: readonly string[],
): Promise<string> {
    return (await commandBytes(run, bin, args)).toString('utf8');
}

/** Single nonempty output line: fail on an empty response where a commit is expected. */
export async function commandLine(
    run: CommandRunner,
    bin: string,
    args: readonly string[],
): Promise<string> {
    const line = (await commandText(run, bin, args)).trim();
    if (line === '') {
        throw new Error(`\`${bin} ${args.join(' ')}\` printed nothing`);
    }
    return line;
}

function detailOf(stderr: string): string {
    const line = stderr
        .split('\n')
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate !== '');
    return line === undefined ? '' : `: ${line}`;
}

/** What the VCS reports about the checkout. The adapter needs nothing else. */
export interface VcsInfo {
    readonly branch: string;
    readonly head: string;
    readonly login: string;
}

/** One changed status entry. */
export interface VcsStatusEntry {
    readonly status: string;
    /** Path relative to the checkout root. */
    readonly path: string;
}

export interface VcsStatus {
    readonly changed: readonly VcsStatusEntry[];
    /** Untracked files relative to the checkout root, with ignored files already excluded by the VCS. */
    readonly untracked: readonly string[];
}

/** A `--name-status` line: change type and file paths. */
export interface NameStatusEntry {
    readonly changeType: FileChangeType;
    readonly path: string;
    /** Previous path of a rename. null means status did not supply it. */
    readonly oldPath: string | null;
}

/** Everything a working-tree snapshot asks the VCS. */
export interface LocalVcs {
    /** VCS behind local review, also part of the key prefix (`local-git-`). */
    readonly kind: string;
    /** Checkout name with an article for rejection messages: `a git checkout`. */
    readonly checkoutLabel: string;

    /** Absolute checkout root. Fail outside a checkout. */
    root(): Promise<string>;

    info(): Promise<VcsInfo>;

    /** Default base ref when `--base` is not supplied. */
    defaultBaseRef(): Promise<string>;

    /** Commit from `merge-base <ref> HEAD`. */
    mergeBase(ref: string): Promise<string>;

    /** Commit for a ref. */
    revParse(ref: string): Promise<string>;

    /** Changes and untracked files in the project directory (`projectDir` is absolute). */
    status(projectDir: string): Promise<VcsStatus>;

    /** Working-tree patch against `base` in git format, with paths relative to the project directory. */
    diff(base: string): Promise<string>;

    nameStatus(base: string): Promise<NameStatusEntry[]>;

    /** Bytes of `rootPath` (relative to checkout root) at revision `ref`. Failure throws, not an empty side. */
    show(ref: string, rootPath: string): Promise<Buffer>;
}

/** `--name-status` status letter → change type. */
export function changeTypeOf(letter: string): FileChangeType {
    switch (letter) {
        case 'A':
            return 'add';
        case 'D':
            return 'delete';
        case 'R':
            return 'move';
        case 'C':
            return 'copy';
        case 'U':
            return 'conflict';
        default:
            return 'modify';
    }
}
