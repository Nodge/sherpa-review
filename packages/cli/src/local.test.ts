import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommandOutcome, CommandRunner } from './command.js';
import { gitCliHost } from './hosts/git.js';
import type { CliHostPlugin } from './hosts/plugin.js';
import { localPrKey, resolveLocalTarget } from './local.js';

/**
 * Local review key and directory resolution through the git plugin. Doesn't call real `git`. Injects the runner
 * but uses a real directory, resolving its path to an absolute path through realpath.
 */

const HOSTS = [gitCliHost];

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
        expect(localPrKey('git', '/home/dev/code/app', 'main')).toMatch(/^local-git-app-[0-9a-f]{8}$/u);
        expect(localPrKey('hg', '/home/dev/code/app', 'main')).toMatch(/^local-hg-app-[0-9a-f]{8}$/u);
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
        expect(localPrKey('git', '/repo/αβγ δεζηθ', 'main')).toMatch(/^local-git-[-]{9}-[0-9a-f]{8}$/u);
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

    /** git that recognizes the directory: root is `root`, branch is `branch`. */
    function gitIn(root: string, calls: Call[] = [], branch = 'feature'): CommandRunner {
        return runner({ 'rev-parse': outcome({ stdout: `${root}\n` }) }, calls, (args) =>
            args.includes('--abbrev-ref') ? outcome({ stdout: `${branch}\n` }) : null,
        );
    }

    it('directory, branch and key come from git invoked in that directory', async () => {
        const calls: Call[] = [];

        const target = await resolveLocalTarget(dir, 'main~3', HOSTS, gitIn(dir, calls));

        expect(target).toEqual({
            prKey: localPrKey('git', dir, 'feature', 'main~3'),
            vcs: 'git',
            repo: dir,
            branch: 'feature',
            base: 'main~3',
            defaultBase: 'merge-base with the default branch',
        });
        expect(target.prKey).toMatch(/^local-git-/u);
        expect(calls.map((call) => call.cwd)).toEqual([dir, dir]);
        expect(calls.map((call) => call.args.join(' '))).toEqual([
            'rev-parse --show-toplevel',
            'rev-parse --abbrev-ref HEAD',
        ]);
    });

    // The review belongs to a branch. Without it, there is no basis for the key.
    it('detached git head is rejected with an explanation', async () => {
        await expect(resolveLocalTarget(dir, undefined, HOSTS, gitIn(dir, [], 'HEAD'))).rejects.toThrow(
            'is on a detached HEAD',
        );
    });

    it('resolves a relative path to an absolute one', async () => {
        const nested = path.join(dir, 'app');
        await fs.mkdir(nested);

        const target = await resolveLocalTarget(path.join(dir, 'app', '..', 'app'), undefined, HOSTS, gitIn(dir));

        expect(target.repo).toBe(nested);
        expect(target.base).toBeUndefined();
    });

    it('rejects a missing directory before calling git', async () => {
        const calls: Call[] = [];
        const run = runner({}, calls);

        await expect(resolveLocalTarget(path.join(dir, 'no-such-directory'), undefined, HOSTS, run)).rejects.toThrow(
            'there is no directory',
        );
        expect(calls).toEqual([]);
    });

    it('rejects a path pointing to a file', async () => {
        const file = path.join(dir, 'file.txt');
        await fs.writeFile(file, 'x');

        await expect(resolveLocalTarget(file, undefined, HOSTS, runner({}))).rejects.toThrow('is not a directory');
    });

    // The VCS rejection reason in the message shows exactly what is missing.
    it('rejects a non-git repository with the git reason', async () => {
        const run = runner({ 'rev-parse': outcome({ exitCode: 128, stderr: NOT_A_GIT_REPO }) });

        await expect(resolveLocalTarget(dir, undefined, HOSTS, run)).rejects.toThrow(
            'is not inside a git checkout (git: fatal: not a git repository (or any of the parent directories): .git)',
        );
    });

    it('rejection for a missing binary mentions PATH', async () => {
        const run = runner({ 'rev-parse': outcome({ exitCode: null, failure: 'not-found' }) });

        await expect(resolveLocalTarget(dir, undefined, HOSTS, run)).rejects.toThrow('(`git` is not in PATH)');
    });
});

describe('VCS selection among plugins', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-cli-local-')));
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    const run: CommandRunner = () => Promise.reject(new Error('fake plugins do not run commands'));

    /** Fake VCS: recognizes the directory or not, with a flag for a marker directly inside it. */
    function vcs(name: string, found: boolean, calls: string[], owns = false): CliHostPlugin {
        return {
            name,
            detectLocal: {
                vcs: name,
                defaultBase: `base of ${name}`,
                ownsDirectory: () => Promise.resolve(owns),
                detect: () => {
                    calls.push(name);
                    return Promise.resolve(
                        found
                            ? { kind: 'found', branch: `${name}-branch` }
                            : { kind: 'absent', reason: `${name}: nope` },
                    );
                },
            },
        };
    }

    it('first plugin in the list to recognize the directory wins', async () => {
        const calls: string[] = [];

        const hosts = [vcs('one', false, calls), vcs('two', true, calls), vcs('three', true, calls)];

        const target = await resolveLocalTarget(dir, undefined, hosts, run);

        expect(target.vcs).toBe('two');
        expect(target.branch).toBe('two-branch');
        expect(target.prKey).toMatch(/^local-two-/u);
        expect(calls).toEqual(['one', 'two']);
    });

    it('marker directly in the directory takes priority over list order', async () => {
        const calls: string[] = [];

        const hosts = [vcs('outer', true, calls), vcs('inner', true, calls, true)];

        const target = await resolveLocalTarget(dir, undefined, hosts, run);

        expect(target.vcs).toBe('inner');
        expect(calls).toEqual(['inner']);
    });

    it('marker present but checkout unrecognized moves on down the list without asking again', async () => {
        const calls: string[] = [];

        const hosts = [vcs('outer', true, calls), vcs('inner', false, calls, true)];

        const target = await resolveLocalTarget(dir, undefined, hosts, run);

        expect(target.vcs).toBe('outer');
        expect(calls).toEqual(['inner', 'outer']);
    });

    it('no plugin recognizes it, rejection includes all reasons', async () => {
        const hosts = [vcs('hg', false, []), vcs('svn', false, [])];

        await expect(resolveLocalTarget(dir, undefined, hosts, run)).rejects.toThrow(
            'is not inside a hg or svn checkout (hg: nope; svn: nope).\n' +
                'Local review reads the working tree with `hg` or `svn`',
        );
    });

    it('no VCS plugins means no local review', async () => {
        await expect(resolveLocalTarget(dir, undefined, [{ name: 'host' }], run)).rejects.toThrow(
            'knows no version control system for local review',
        );
    });
});
