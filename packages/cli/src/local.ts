import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { LocalVcsKind } from '@sherpa/protocol';
import { localPrKeyPrefix } from '@sherpa/protocol';

import { CliError } from './errors.js';
import type { CommandOutcome, CommandRunner } from './pr-discovery.js';
import { runVcsCommand } from './pr-discovery.js';

/**
 * Local review from a project directory (`sherpa up --local <path>`): which VCS, which directory,
 * which branch and which key identifies it. All of this is resolved here, not on the server. Only
 * the command's caller knows the directory, and the VCS kind reaches the server as the key prefix.
 */


const GIT_BIN = 'git';

/** Number of hash characters in the key. 32 bits are more than enough to distinguish adjacent branches. */
const KEY_HASH_CHARS = 8;

/** Fallback directory name in the key when no allowed characters remain in the base name. */
const FALLBACK_DIR_NAME = 'dir';

export interface LocalTarget {
    /** Review key, also the name of the state directory and manifest. */
    readonly prKey: string;
    /** The version control system used by this directory. */
    readonly vcs: LocalVcsKind;
    /** Project directory resolved to an absolute path through realpath. */
    readonly repo: string;
    readonly branch: string;
    /** Explicit base from `--base`. With undefined, the server computes the default base. */
    readonly base: string | undefined;
}

/**
 * Project directory to review key. The VCS is detected here by asking Git
 * for the checkout root and branch.
 * A directory with its own `.git` is a git repository even inside another checkout.
 * This keeps a nested clone from being treated as untracked files in the outer repository.
 * A missing path, a non-directory or a path outside a checkout gets a clear error. Further down the chain it
 * would turn into "server failed to start".
 */
export async function resolveLocalTarget(
    rawPath: string,
    base: string | undefined,
    run: CommandRunner = runVcsCommand,
): Promise<LocalTarget> {
    const repo = await realDirectory(rawPath);

    let gitRoot: CommandOutcome | null = null;
    if (await hasOwnGitDir(repo)) {
        gitRoot = await run(GIT_BIN, ['rev-parse', '--show-toplevel'], { cwd: repo });
        if (succeeded(gitRoot)) {
            return targetOf('git', repo, await gitBranch(repo, run), base);
        }
    }

    const vcsRoot = await run(VCS_BIN, ['root'], { cwd: repo });
    if (succeeded(vcsRoot)) {
        return targetOf('git', repo, await gitBranch(repo, run), base);
    }

    gitRoot ??= await run(GIT_BIN, ['rev-parse', '--show-toplevel'], { cwd: repo });
    if (succeeded(gitRoot)) {
        return targetOf('git', repo, await gitBranch(repo, run), base);
    }

    throw new CliError(notACheckout(repo, vcsRoot, gitRoot));
}

/** A `.git` directory or worktree file marks the start of a repository. */
async function hasOwnGitDir(repo: string): Promise<boolean> {
    return (await fs.stat(path.join(repo, '.git')).catch(() => null)) !== null;
}

/**
 * Local review key: VCS kind and directory name for readability, plus a hash of the path, branch
 * and explicit base to distinguish reviews. Together these three define the review. A different branch or
 * base means a different diff, and a running server for the old key would return something other than what was requested.
 */
export function localPrKey(vcs: LocalVcsKind, repo: string, branch: string, base?: string): string {
    const digest = createHash('sha256')
        .update(`${repo}\n${branch}\n${base ?? ''}`)
        .digest('hex');
    return `${localPrKeyPrefix(vcs)}${keyNameOf(path.basename(repo))}-${digest.slice(0, KEY_HASH_CHARS)}`;
}

function targetOf(vcs: LocalVcsKind, repo: string, branch: string, base: string | undefined): LocalTarget {
    return { prKey: localPrKey(vcs, repo, branch, base), vcs, repo, branch, base };
}

/** The checkout branch is printed by `git rev-parse --abbrev-ref HEAD`. */
async function vcsBranch(repo: string, run: CommandRunner): Promise<string> {
    const info = await run(VCS_BIN, ['info', '--json'], { cwd: repo });
    if (!succeeded(info)) {
        throw new CliError(
            `sherpa: \`git rev-parse --abbrev-ref HEAD\` failed in ${repo}${detailOf(GIT_BIN, info)}.\n` +
                'Local review reads the working tree with `git`. Check that the command works in this directory.',
        );
    }

    const branch = parseBranch(info.stdout);
    if (branch === null) {
        throw new CliError(
            'sherpa: Git printed something Sherpa cannot read. It needs the branch name.\n' +
                'Check that `git branch --show-current` works in this directory.',
        );
    }
    return branch;
}

/** git repository branch. Detached head is rejected, as the review belongs to a branch. */
async function gitBranch(repo: string, run: CommandRunner): Promise<string> {
    const head = await run(GIT_BIN, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
    const branch = succeeded(head) ? head.stdout.trim() : '';
    if (branch === '') {
        throw new CliError(
            `sherpa: cannot read the current branch of ${repo}${detailOf(GIT_BIN, head)}.\n` +
                'Local review is keyed by the branch; check that `git rev-parse --abbrev-ref HEAD` works there.',
        );
    }
    if (branch === 'HEAD') {
        throw new CliError(
            `sherpa: ${repo} is on a detached HEAD.\n` +
                'Local review is keyed by the branch: check out a branch and run `sherpa up --local <path>` again.',
        );
    }
    return branch;
}

function succeeded(outcome: CommandOutcome): boolean {
    return outcome.failure === null && outcome.exitCode === 0;
}

async function realDirectory(rawPath: string): Promise<string> {
    const candidate = path.resolve(rawPath);

    let real: string;
    try {
        real = await fs.realpath(candidate);
    } catch {
        throw new CliError(
            `sherpa: there is no directory ${candidate}.\n` +
                'Pass the path of the project directory to review: `sherpa up --local <path>`.',
        );
    }

    const stats = await fs.stat(real).catch(() => null);
    if (stats?.isDirectory() !== true) {
        throw new CliError(
            `sherpa: ${candidate} is not a directory.\n` +
                'Pass the path of the project directory to review: `sherpa up --local <path>`.',
        );
    }
    return real;
}

/** Checkout detection failed. The error includes the command failure reason. */
function notACheckout(repo: string, result: CommandOutcome, git: CommandOutcome): string {
    return (
        `sherpa: ${repo} is not inside a git checkout` +
        ` (${reasonOf(GIT_BIN, result)}. ${reasonOf(GIT_BIN, git)}).\n` +
        'Local review reads the working tree with `git`. ' +
        'run it from a checkout or pass `--pr <pr key>`.'
    );
}

/** Directory name in the `prKeySchema` character set. Replaces other characters with hyphens, uses `dir` for an empty name. */
function keyNameOf(basename: string): string {
    const sanitized = basename.replace(/[^A-Za-z0-9._-]/gu, '-');
    return sanitized === '' ? FALLBACK_DIR_NAME : sanitized;
}

/** Checkout branch from Git output. Returns null if the field is missing or the output cannot be parsed. */
function parseBranch(stdout: string): string | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return null;
    }

    const branch = (parsed as Record<string, unknown>).branch;
    return typeof branch === 'string' && branch !== '' ? branch : null;
}

/** Why the command did not respond: a missing executable or the first meaningful line of its stderr. */
function reasonOf(bin: string, outcome: CommandOutcome): string {
    if (outcome.failure === 'not-found') {
        return `\`${bin}\` is not in PATH`;
    }
    const line = firstLine(outcome.stderr);
    return line === null ? `\`${bin}\` failed` : `${bin}: ${line}`;
}

function detailOf(bin: string, outcome: CommandOutcome): string {
    const line = firstLine(outcome.stderr);
    if (outcome.failure === 'not-found') {
        return ` — \`${bin}\` is not in PATH`;
    }
    return line === null ? '' : ` (${bin}: ${line})`;
}

function firstLine(stderr: string): string | null {
    return (
        stderr
            .split('\n')
            .map((candidate) => candidate.trim())
            .find((candidate) => candidate !== '') ?? null
    );
}
