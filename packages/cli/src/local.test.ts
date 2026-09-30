import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { localPrKey, resolveLocalTarget } from './local.js';
import type { CommandOutcome, CommandRunner } from './pr-discovery.js';

/**
 * Local review keys and directory resolution. Tests inject the command runner instead of calling a live `git`,
 * but use a real directory. Its path is resolved to an absolute path with realpath.
 */

const INFO = `{
  "repository":"quillmart/quillmart",
  "author":"alice",
  "user_login":"alice",
  "branch":"sherpa-local-host",
  "hash":"32b57bd3cec8a32a34b72b757cd9f99a436c515a"
}
`;

const NOT_A_CHECKOUT = 'Not a git repository.\n';

const NOT_A_GIT_REPO = 'fatal: not a git repository (or any of the parent directories): .git\n';

function outcome(overrides: Partial<CommandOutcome> = {}): CommandOutcome {
    return { exitCode: 0, stdout: '', stderr: '', failure: null, ...overrides };
}

interface Call {
    readonly args: readonly string[];
    readonly cwd: string | undefined;
}

/**
 * Mock runner: selects a response by the command's first argument, with `special` overriding
 * it where the same command (`git rev-parse`) asks different questions.
 */
function runner(
    answers: Record<string, CommandOutcome>,
    calls: Call[] = [],
    special: (args: readonly string[]) => CommandOutcome | null = () => null,
): CommandRunner {
    return (_command, args, options) => {
        calls.push({ args, cwd: options?.cwd });
        return Promise.resolve(
            special(args) ?? answers[args[0] ?? ''] ?? outcome({ exitCode: 1, stderr: 'unexpected\n' }),
        );
    };
}

describe('local review key', () => {
    it('directory name plus a hash of the path and branch', () => {
        expect(localPrKey('git', '/Users/alice/projects/wt/sherpa', 'main')).toMatch(/^local-git-sherpa-[0-9a-f]{8}$/u);
        expect(localPrKey('git', '/Users/alice/code/app', 'main')).toMatch(/^local-git-app-[0-9a-f]{8}$/u);
    });

    it('same input and branch give the same key, different ones give different keys', () => {
        const key = localPrKey('git', '/repo/app', 'feature');

        expect(localPrKey('git', '/repo/app', 'feature')).toBe(key);
        expect(localPrKey('git', '/repo/app', 'other')).not.toBe(key);
        expect(localPrKey('git', '/other/app', 'feature')).not.toBe(key);
    });

    // A running server for the key is reused as is. A different base must have a different key,
    // otherwise `up --base` would silently connect to a server comparing against something else.
    it('explicit base is part of the key', () => {
        const key = localPrKey('git', '/repo/app', 'feature');

        expect(localPrKey('git', '/repo/app', 'feature', undefined)).toBe(key);
        expect(localPrKey('git', '/repo/app', 'feature', 'main~5')).not.toBe(key);
        expect(localPrKey('git', '/repo/app', 'feature', 'main~5')).toBe(localPrKey('git', '/repo/app', 'feature', 'main~5'));
    });

    // The key goes into state paths, so its character set is limited by `prKeySchema`.
    it('sanitizes the directory name to the key character set', () => {
        expect(localPrKey('git', '/repo/my folder', 'main')).toMatch(/^local-git-[-]{9}-[0-9a-f]{8}$/u);
        expect(localPrKey('git', '/repo/a.b_c-d', 'main')).toMatch(/^local-git-a\.b_c-d-[0-9a-f]{8}$/u);
        expect(localPrKey('git', '/', 'main')).toMatch(/^local-git-dir-[0-9a-f]{8}$/u);
    });
});

describe('local review directory resolution', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-cli-local-')));
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('gets the directory, branch and key from git run in that directory', async () => {
        const calls: Call[] = [];
        const run = runner({ root: outcome({ stdout: `${dir}\n` }), info: outcome({ stdout: INFO }) }, calls);

        const target = await resolveLocalTarget(dir, 'main~3', run);

        expect(target).toEqual({
            prKey: localPrKey('git', dir, 'sherpa-local-host', 'main~3'),
            vcs: 'git',
            repo: dir,
            branch: 'sherpa-local-host',
            base: 'main~3',
        });
        expect(calls.map((call) => call.cwd)).toEqual([dir, dir]);
        expect(calls.map((call) => call.args.join(' '))).toEqual(['root', 'info --json']);
    });

    // The directory belongs to a git checkout. Git supplies the directory and branch.
    it('asks git for the directory and branch', async () => {
        const calls: Call[] = [];
        const run = runner(
            {
                root: outcome({ exitCode: null, failure: 'not-found' }),
                'rev-parse': outcome({ stdout: `${dir}\n` }),
            },
            calls,
            (args) => (args.includes('--abbrev-ref') ? outcome({ stdout: 'feature\n' }) : null),
        );

        const target = await resolveLocalTarget(dir, undefined, run);

        expect(target).toEqual({
            prKey: localPrKey('git', dir, 'feature', undefined),
            vcs: 'git',
            repo: dir,
            branch: 'feature',
            base: undefined,
        });
        expect(target.prKey).toMatch(/^local-git-/u);
        expect(calls.map((call) => call.args.join(' '))).toEqual([
            'root',
            'rev-parse --show-toplevel',
            'rev-parse --abbrev-ref HEAD',
        ]);
    });

    // A nested git clone belongs to its own repository even if an outer checkout contains it.
    it('uses its own .git even inside another checkout', async () => {
        await fs.mkdir(path.join(dir, '.git'));
        const calls: Call[] = [];
        const run = runner(
            { root: outcome({ stdout: `${dir}\n` }), 'rev-parse': outcome({ stdout: `${dir}\n` }) },
            calls,
            (args) => (args.includes('--abbrev-ref') ? outcome({ stdout: 'feature\n' }) : null),
        );

        const target = await resolveLocalTarget(dir, undefined, run);

        expect(target.vcs).toBe('git');
        expect(calls.map((call) => call.args.join(' '))).toEqual([
            'rev-parse --show-toplevel',
            'rev-parse --abbrev-ref HEAD',
        ]);
    });

    // The review belongs to a branch. Without it, there is no basis for the key.
    it('detached git head is rejected with an explanation', async () => {
        const run = runner(
            { root: outcome({ exitCode: 1, stderr: NOT_A_CHECKOUT }), 'rev-parse': outcome({ stdout: `${dir}\n` }) },
            [],
            (args) => (args.includes('--abbrev-ref') ? outcome({ stdout: 'HEAD\n' }) : null),
        );

        await expect(resolveLocalTarget(dir, undefined, run)).rejects.toThrow('is on a detached HEAD');
    });

    it('resolves a relative path to an absolute one', async () => {
        const nested = path.join(dir, 'app');
        await fs.mkdir(nested);
        const run = runner({ root: outcome({ stdout: `${dir}\n` }), info: outcome({ stdout: INFO }) });

        const target = await resolveLocalTarget(path.join(dir, 'app', '..', 'app'), undefined, run);

        expect(target.repo).toBe(nested);
        expect(target.base).toBeUndefined();
    });

    it('rejects a missing directory before running git', async () => {
        const calls: Call[] = [];
        const run = runner({}, calls);

        await expect(resolveLocalTarget(path.join(dir, 'no-such-directory'), undefined, run)).rejects.toThrow(
            'there is no directory',
        );
        expect(calls).toEqual([]);
    });

    it('rejects a path pointing to a file', async () => {
        const file = path.join(dir, 'file.txt');
        await fs.writeFile(file, 'x');

        await expect(resolveLocalTarget(file, undefined, runner({}))).rejects.toThrow('is not a directory');
    });

    // VCS detection failed. The error includes the reason so the missing requirement is visible.
    it('reports why checkout detection failed', async () => {
        const run = runner({
            root: outcome({ exitCode: 1, stderr: NOT_A_CHECKOUT }),
            'rev-parse': outcome({ exitCode: 128, stderr: NOT_A_GIT_REPO }),
        });

        await expect(resolveLocalTarget(dir, undefined, run)).rejects.toThrow(
            'is not inside a git checkout ' +
                '(' +
                'git: fatal: not a git repository (or any of the parent directories): .git)',
        );
    });

    it('mentions PATH when the executable is missing', async () => {
        const run = runner({
            root: outcome({ exitCode: null, failure: 'not-found' }),
            'rev-parse': outcome({ exitCode: null, failure: 'not-found' }),
        });

        await expect(resolveLocalTarget(dir, undefined, run)).rejects.toThrow(
            '(`git` is not in PATH)',
        );
    });

    it('rejects Git output without a branch instead of building a key from nothing', async () => {
        const run = runner({ root: outcome({ stdout: `${dir}\n` }), info: outcome({ stdout: '{}' }) });

        await expect(resolveLocalTarget(dir, undefined, run)).rejects.toThrow('it needs the branch name');
    });
});
