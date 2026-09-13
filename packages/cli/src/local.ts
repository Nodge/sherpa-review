import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { CliError } from './errors.js';
import type { CommandOutcome, CommandRunner } from './pr-discovery.js';
import { runVcsCommand } from './pr-discovery.js';

/**
 * Local review from a project directory (`sherpa up --local <path>`): which directory, which branch
 * and which key it uses. The key is built here, rather than on the server. Only the person
 * running the command knows the directory.
 */



/** Number of hash characters in the key. 32 bits are more than enough to distinguish adjacent branches. */
const KEY_HASH_CHARS = 8;

/** Fallback directory name in the key when no allowed characters remain in the base name. */
const FALLBACK_DIR_NAME = 'dir';

export interface LocalTarget {
    /** Review key, also the name of the state directory and manifest. */
    readonly prKey: string;
    /** Project directory resolved to an absolute path through realpath. */
    readonly repo: string;
    readonly branch: string;
    /** Explicit base from `--base`. With undefined, the server computes `git merge-base main HEAD`. */
    readonly base: string | undefined;
}

/**
 * Project directory → review key. A missing directory, a non-directory or a directory outside a Git checkout gets a clear error.
 * Further down the chain, it would become "the server did not start".
 */
export async function resolveLocalTarget(
    rawPath: string,
    base: string | undefined,
    run: CommandRunner = runVcsCommand,
): Promise<LocalTarget> {
    const repo = await realDirectory(rawPath);

    const root = await run(VCS_BIN, ['root'], { cwd: repo });
    if (root.failure !== null || root.exitCode !== 0) {
        throw new CliError(notAVcsCheckout(repo, root));
    }

    const info = await run(VCS_BIN, ['info', '--json'], { cwd: repo });
    if (info.failure !== null || info.exitCode !== 0) {
        throw new CliError(notAVcsCheckout(repo, info));
    }
    const branch = parseBranch(info.stdout);
    if (branch === null) {
        throw new CliError(
            'sherpa: Git printed something Sherpa cannot read. It needs the branch name.\n' +
                'Check that `git branch --show-current` works in this directory.',
        );
    }

    return { prKey: localPrKey(repo, branch, base), repo, branch, base };
}

/**
 * Local review key: the directory name makes it readable, and a fingerprint of the path, branch and explicit base
 * makes it distinct. All 3 together define the review. A different branch or comparison base
 * means a different diff, and a running server under the old key would return something else.
 */
export function localPrKey(repo: string, branch: string, base?: string): string {
    const digest = createHash('sha256')
        .update(`${repo}\n${branch}\n${base ?? ''}`)
        .digest('hex');
    return `local-git-${keyNameOf(path.basename(repo))}-${digest.slice(0, KEY_HASH_CHARS)}`;
}

/** Directory name in the `prKeySchema` character set. Replaces other characters with hyphens, uses `dir` for an empty name. */
function keyNameOf(basename: string): string {
    const sanitized = basename.replace(/[^A-Za-z0-9._-]/gu, '-');
    return sanitized === '' ? FALLBACK_DIR_NAME : sanitized;
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

function notAVcsCheckout(repo: string, outcome: CommandOutcome): string {
    const detail = outcome.failure === 'not-found' ? ' — `git` is not in PATH' : detailOf(outcome.stderr);
    return (
        `sherpa: ${repo} is not inside a Git checkout${detail}.\n` +
        'Local review reads the working tree with `git`. Run it from a checkout or pass `--pr <pr key>`.'
    );
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

/** First meaningful line of external stderr. It explains the failure better than our guesses. */
function detailOf(stderr: string): string {
    const line = stderr
        .split('\n')
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate !== '');
    return line === undefined ? '' : ` (git: ${line})`;
}
