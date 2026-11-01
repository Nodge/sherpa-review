import { describe, expect, it } from 'vitest';

import type { CommandRunner } from '../command.js';
import { resolvePrKey } from '../discovery.js';
import { guideText } from '../guide.js';

import { CLI_HOSTS } from './all.js';

/** Built-in CLI plugins together, using the same path as the real `sherpa-review`. */

const run: CommandRunner = () => Promise.reject(new Error('commands are not run here'));

describe('built-in CLI hosts', () => {
    it('bring their parts into the guide', () => {
        const guide = guideText(CLI_HOSTS, 'sherpa-review');

        expect(guide).toContain('**A GitHub PR URL**');
        expect(guide).toContain('`GITHUB_TOKEN`, `GH_TOKEN`');
        expect(guide).toContain('Local review reads the working tree of a git checkout');
        expect(guide).toContain('(git: merge-base with the default branch)');
    });

    it('GitHub link and ready-made keys', async () => {
        await expect(
            resolvePrKey('https://github.com/acme/ui--kit/pull/7/files#diff-abc', {}, CLI_HOSTS, run),
        ).resolves.toBe('github-acme--ui--kit--7');
        await expect(
            resolvePrKey(undefined, { SHERPA_PR: 'https://github.com/acme/sherpa/pull/42' }, CLI_HOSTS, run),
        ).resolves.toBe('github-acme--sherpa--42');
        await expect(resolvePrKey('github-acme--sherpa--42', {}, CLI_HOSTS, run)).resolves.toBe(
            'github-acme--sherpa--42',
        );
        await expect(resolvePrKey('fixture-medium', {}, CLI_HOSTS, run)).resolves.toBe('fixture-medium');
    });

    it('without --pr and SHERPA_PR, does not discover the PR from the directory and gives a hint to specify it', async () => {
        await expect(resolvePrKey(undefined, {}, CLI_HOSTS, run)).rejects.toThrow(
            'Sherpa cannot detect the PR of the current directory.\n' +
                'Run the command through the Sherpa skill (it fills the PR in), or pass `--pr <pr key>`.',
        );
    });

    it('default base wording comes from the VCS plugin for the key', () => {
        const defaultBase = (vcs: string) =>
            CLI_HOSTS.find((host) => host.detectLocal?.vcs === vcs)?.detectLocal?.defaultBase;
        expect(defaultBase('git')).toBe('merge-base with the default branch');
    });
});
