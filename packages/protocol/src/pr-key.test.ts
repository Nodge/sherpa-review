import { describe, expect, it } from 'vitest';

import {
    githubPrKey,
    githubPrRefOf,
    localHostName,
    localPrKeyPrefix,
    parseGithubPrKey,
} from './pr-key.js';
import { prKeySchema } from './manifest.js';

describe('GitHub PR key', () => {
    it('joins with double hyphens and passes the key schema', () => {
        const key = githubPrKey({ owner: 'acme', repo: 'sherpa.js', number: 17 });

        expect(key).toBe('github-acme--sherpa.js--17');
        expect(prKeySchema.safeParse(key).success).toBe(true);
    });

    it('parses back, including a repository with a double hyphen', () => {
        expect(parseGithubPrKey('github-o--r--1')).toEqual({ owner: 'o', repo: 'r', number: 1 });
        expect(parseGithubPrKey('github-acme-corp--ui--kit--42')).toEqual({
            owner: 'acme-corp',
            repo: 'ui--kit',
            number: 42,
        });
        // Repository ending with a hyphen: the number splits off at the last `--`, leaving the hyphen in the name.
        expect(parseGithubPrKey('github-o--repo---7')).toEqual({ owner: 'o', repo: 'repo-', number: 7 });
    });

    it('round-trips names with dots, underscores and digits', () => {
        for (const ref of [
            { owner: 'a', repo: 'b', number: 1 },
            { owner: 'Acme-Corp', repo: 'sherpa_ui.v2', number: 123456 },
            { owner: 'user2', repo: 'a--b--c', number: 9 },
        ]) {
            expect(parseGithubPrKey(githubPrKey(ref))).toEqual(ref);
        }
    });

    it('does not parse unrelated or malformed keys', () => {
        for (const key of [
            'fixture-medium',
            'local-git-app-0badc0de',
            'github-o--r',
            'github-o--r--0',
            'github-o--r--x',
            'github---r--1',
            'github-o--r--',
            'github-o-r--1',
        ]) {
            expect(parseGithubPrKey(key), key).toBeNull();
        }
    });

    it('does not accept an owner with a double hyphen as a key', () => {
        // Owner `o--x` is indistinguishable from `o` + repository `x`. GitHub has no such login.
        expect(parseGithubPrKey('github-o--x--r--3')).toEqual({ owner: 'o', repo: 'x--r', number: 3 });
    });

    it('validates parts as GitHub names', () => {
        expect(githubPrRefOf('acme', 'ui--kit', '7')).toEqual({ owner: 'acme', repo: 'ui--kit', number: 7 });
        expect(githubPrRefOf('o--x', 'r', '1')).toBeNull();
        expect(githubPrRefOf('o', 'r/x', '1')).toBeNull();
        expect(githubPrRefOf('o', 'r', '01')).toBeNull();
    });
});

describe('local review key', () => {
    it('builds the key prefix and adapter name from the VCS kind', () => {
        expect(localPrKeyPrefix('git')).toBe('local-git-');
        expect(localHostName('git')).toBe('local-git');
    });
});
