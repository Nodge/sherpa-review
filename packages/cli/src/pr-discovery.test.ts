import { describe, expect, it } from 'vitest';

import type { CommandOutcome, CommandRunner } from './pr-discovery.js';
import { discoverPrKeyFromCheckout } from './pr-discovery.js';

/**
 * Sample outputs in the VCS's JSON shape:
 * branch and PR status on a branch with a PR, a branch without a PR, and outside a checkout.
 * Tests inject the runner and never call the real VCS executable.
 */

const INFO_ON_BRANCH = `{
  "repository":"quillmart/quillmart",
  "remote":"alice/issue-2301",
  "author":"alice",
  "summary":"Extract the edit window policy into the domain layer",
  "remote_head":"b7c4e1f0a9d38e2c5f6a1b0d9e8c7f6a5b4c3d2e",
  "user_login":"alice",
  "branch":"issue-2301",
  "date":"2026-08-10T23:17:39+02:00",
  "message":"Extract the edit window policy into the domain layer",
  "hash":"b7c4e1f0a9d38e2c5f6a1b0d9e8c7f6a5b4c3d2e"
}
`;

// The command returns the whole PR, including tens of kilobytes of description. Trimmed here to the essentials.
const PR_STATUS_FOUND = `{
  "id":9002,
  "url":"https://github.com/quillmart/quillmart/pull/9002",
  "author":"alice",
  "summary":"#2301: Add the order edit window",
  "description":"Implementation plan: https://github.com/quillmart/quillmart/issues/2301",
  "status":"conflicts",
  "issues":["#2301"],
  "from_branch":"alice/issue-2301",
  "to_branch":"main",
  "reviewers":["ai-review-bot"],
  "created_at":"2026-08-10T21:19:02Z"
}
`;

const NOT_A_CHECKOUT_STDERR = 'Not a Git repository.\n';
const NO_PR_STDERR = "No pull request for branch 'main'\n";

function ok(stdout: string): CommandOutcome {
    return { exitCode: 0, stdout, stderr: '', failure: null };
}

function failed(stderr: string): CommandOutcome {
    return { exitCode: 1, stdout: '', stderr, failure: null };
}

/** Runner that responds in call order: first branch info, then PR status. */
function runnerOf(...outcomes: readonly CommandOutcome[]): { run: CommandRunner; calls: string[][] } {
    const calls: string[][] = [];
    const run: CommandRunner = (command, args) => {
        calls.push([command, ...args]);
        const outcome = outcomes[calls.length - 1];
        if (outcome === undefined) {
            throw new Error(`unexpected call ${command} ${args.join(' ')}`);
        }
        return Promise.resolve(outcome);
    };
    return { run, calls };
}

describe('PR discovery from a checkout', () => {
    it('returns the host key for a branch with a PR using exactly two read-only commands', async () => {
        const { run, calls } = runnerOf(ok(INFO_ON_BRANCH), ok(PR_STATUS_FOUND));

        await expect(discoverPrKeyFromCheckout(run)).resolves.toEqual({
            kind: 'found',
            prKey: 'github-quillmart--quillmart--9002',
        });
        expect(calls).toEqual([
            
            
        ]);
    });

    it('returns a hint with the branch and command output when no PR exists, after the second command', async () => {
        const { run } = runnerOf(ok(INFO_ON_BRANCH), failed(NO_PR_STDERR));

        const discovery = await discoverPrKeyFromCheckout(run);

        expect(discovery).toEqual({
            kind: 'unavailable',
            hint: 'branch `issue-2301` has no PR (VCS: No pull request for branch \'main\')',
        });
    });

    it('stops before querying PR status outside a Git checkout', async () => {
        const { run, calls } = runnerOf(failed(NOT_A_CHECKOUT_STDERR));

        const discovery = await discoverPrKeyFromCheckout(run);

        expect(discovery).toEqual({
            kind: 'unavailable',
            hint: 'not a Git checkout (VCS: Not a Git repository.)',
        });
        expect(calls).toHaveLength(1);
    });

    it('returns its own hint when the Git executable is absent', async () => {
        const { run } = runnerOf({ exitCode: null, stdout: '', stderr: '', failure: 'not-found' });

        await expect(discoverPrKeyFromCheckout(run)).resolves.toEqual({
            kind: 'unavailable',
            hint: '`git` is not in PATH. Sherpa uses it to detect the PR of the current branch',
        });
    });

    it('includes the command and time limit in the hint when PR status times out', async () => {
        const { run } = runnerOf(ok(INFO_ON_BRANCH), {
            exitCode: null,
            stdout: '',
            stderr: '',
            failure: 'timeout',
        });

        await expect(discoverPrKeyFromCheckout(run)).resolves.toEqual({
            kind: 'unavailable',
            hint: 'PR status did not answer within 10 s',
        });
    });

    it('returns unavailable on malformed status JSON without crashing', async () => {
        const { run } = runnerOf(ok(INFO_ON_BRANCH), ok('{"id":149313'));

        await expect(discoverPrKeyFromCheckout(run)).resolves.toEqual({
            kind: 'unavailable',
            hint: 'PR status printed something Sherpa cannot read',
        });
    });

    it('returns the same failure for a non-numeric or missing id because it cannot form a host key', async () => {
        for (const stdout of ['{"id":"9002"}', '{"id":0}', '{"url":"https://github.com/quillmart/quillmart/pull/1"}', '']) {
            const { run } = runnerOf(ok(INFO_ON_BRANCH), ok(stdout));

            await expect(discoverPrKeyFromCheckout(run)).resolves.toMatchObject({ kind: 'unavailable' });
        }
    });

    it('continues after malformed branch info because only the hint needs the branch', async () => {
        const { run } = runnerOf(ok('not json'), ok(PR_STATUS_FOUND));

        await expect(discoverPrKeyFromCheckout(run)).resolves.toEqual({
            kind: 'found',
            prKey: 'github-quillmart--quillmart--9002',
        });
    });

    it('omits the branch name from the hint when the branch is unknown and has no PR', async () => {
        const { run } = runnerOf(ok('not json'), failed(NO_PR_STDERR));

        await expect(discoverPrKeyFromCheckout(run)).resolves.toMatchObject({
            hint: expect.stringContaining('the current branch has no PR') as unknown as string,
        });
    });

    it('truncates long VCS errors in the hint', async () => {
        const { run } = runnerOf(ok(INFO_ON_BRANCH), failed(`${'x'.repeat(500)}\n`));

        const discovery = await discoverPrKeyFromCheckout(run);

        expect(discovery.kind).toBe('unavailable');
        expect(discovery.kind === 'unavailable' ? discovery.hint.length : 0).toBeLessThan(200);
    });
});
