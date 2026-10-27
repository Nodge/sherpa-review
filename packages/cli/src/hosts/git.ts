import fs from 'node:fs/promises';
import path from 'node:path';

import type { CommandRunner } from '../command.js';
import { failureDetail, failureReason, succeeded } from '../command.js';
import { CliError } from '../errors.js';

import type { CliHostPlugin, LocalDetection } from './plugin.js';

/** git in the CLI: a git repository for local review. */

const GIT_BIN = 'git';

export const gitCliHost: CliHostPlugin = {
    name: 'git',
    detectLocal: {
        vcs: 'git',
        defaultBase: 'merge-base with the default branch',
        ownsDirectory: hasOwnGitDir,
        detect: detectGitCheckout,
    },
};

/**
 * The directory contains `.git` (a directory or worktree file), so the repository starts here, even if
 * it is inside another checkout, which would report the entire clone as untracked.
 */
async function hasOwnGitDir(dir: string): Promise<boolean> {
    return (await fs.stat(path.join(dir, '.git')).catch(() => null)) !== null;
}

async function detectGitCheckout(dir: string, run: CommandRunner): Promise<LocalDetection> {
    const root = await run(GIT_BIN, ['rev-parse', '--show-toplevel'], { cwd: dir });
    if (!succeeded(root)) {
        return { kind: 'absent', reason: failureReason(GIT_BIN, root) };
    }
    return { kind: 'found', branch: await gitBranch(dir, run) };
}

/** git repository branch. Detached head is rejected, as the review belongs to a branch. */
async function gitBranch(repo: string, run: CommandRunner): Promise<string> {
    const head = await run(GIT_BIN, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
    const branch = succeeded(head) ? head.stdout.trim() : '';
    if (branch === '') {
        throw new CliError(
            `sherpa: cannot read the current branch of ${repo}${failureDetail(GIT_BIN, head)}.\n` +
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
