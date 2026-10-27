import { describe, expect, it } from 'vitest';

import { normalizeGithubKey } from './github.js';

describe('github.com PR link', () => {
    it('parses with any suffix and without a scheme', () => {
        const expected = 'github-octo--sherpa--42';

        expect(normalizeGithubKey('https://github.com/octo/sherpa/pull/42')).toBe(expected);
        expect(normalizeGithubKey('https://github.com/octo/sherpa/pull/42/files')).toBe(expected);
        expect(normalizeGithubKey('https://github.com/octo/sherpa/pull/42#discussion_r1')).toBe(expected);
        expect(normalizeGithubKey('https://github.com/octo/sherpa/pull/42?w=1')).toBe(expected);
        expect(normalizeGithubKey('http://www.github.com/octo/sherpa/pull/42')).toBe(expected);
        expect(normalizeGithubKey('  github.com/octo/sherpa/pull/42  ')).toBe(expected);
    });

    it('preserves a repository name containing a double hyphen in the key', () => {
        expect(normalizeGithubKey('https://github.com/acme-corp/ui--kit/pull/7')).toBe('github-acme-corp--ui--kit--7');
    });

    it('does not accept links other than github.com PR links', () => {
        for (const url of [
            'https://github.com/octo/sherpa',
            'https://github.com/octo/sherpa/issues/42',
            'https://gitlab.com/octo/sherpa/pull/42',
            'https://github.example.com/octo/sherpa/pull/42',
            'https://github.com/o--x/sherpa/pull/42',
            'https://github.com/octo/sherpa/pull/0',
            'https://review.example.com/12345',
            'github-octo--sherpa--42',
            '12345',
        ]) {
            expect(normalizeGithubKey(url), url).toBeNull();
        }
    });
});
