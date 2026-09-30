import { describe, expect, it } from 'vitest';

import { githubPrKey, parseGithubPrKey, parseGithubPrUrl } from './pr-key.js';
import { prKeySchema } from './manifest.js';

describe('GitHub PR key', () => {
    it('joins with double hyphens and passes the key schema', () => {
        const key = githubPrKey({ owner: 'Acme', repo: 'sherpa.js', number: 17 });

        expect(key).toBe('github-Acme--sherpa.js--17');
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
            { owner: 'Acme-Team', repo: 'sherpa_ui.v2', number: 123456 },
            { owner: 'user2', repo: 'a--b--c', number: 9 },
        ]) {
            expect(parseGithubPrKey(githubPrKey(ref))).toEqual(ref);
        }
    });

    it('does not parse unrelated or malformed keys', () => {
        for (const key of [
            'fixture-4242',
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
});

describe('github.com PR link', () => {
    it('parses with any suffix and without a scheme', () => {
        const expected = { owner: 'Acme', repo: 'sherpa', number: 42 };

        expect(parseGithubPrUrl('https://github.com/Acme/sherpa/pull/42')).toEqual(expected);
        expect(parseGithubPrUrl('https://github.com/Acme/sherpa/pull/42/files')).toEqual(expected);
        expect(parseGithubPrUrl('https://github.com/Acme/sherpa/pull/42#discussion_r1')).toEqual(expected);
        expect(parseGithubPrUrl('https://github.com/Acme/sherpa/pull/42?w=1')).toEqual(expected);
        expect(parseGithubPrUrl('http://www.github.com/Acme/sherpa/pull/42')).toEqual(expected);
        expect(parseGithubPrUrl('  github.com/Acme/sherpa/pull/42  ')).toEqual(expected);
    });

    it('builds the same key from a URL and from its parts', () => {
        const ref = parseGithubPrUrl('https://github.com/acme-corp/ui--kit/pull/7');
        expect(ref).not.toBeNull();
        expect(githubPrKey(ref ?? { owner: '', repo: '', number: 0 })).toBe('github-acme-corp--ui--kit--7');
    });

    it('returns null for anything other than a github.com PR URL', () => {
        for (const url of [
            'https://github.com/Acme/sherpa',
            'https://github.com/Acme/sherpa/issues/42',
            'https://gitlab.com/Acme/sherpa/pull/42',
            'https://github.example.com/Acme/sherpa/pull/42',
            'https://github.com/quillmart/quillmart/pull/12345',
            'github-Acme--sherpa--42',
        ]) {
            expect(parseGithubPrUrl(url), url).toBeNull();
        }
    });
});
