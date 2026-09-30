import { describe, expect, it } from 'vitest';

import type { CodeownersRule } from './codeowners.js';
import { ownersOf, parseCodeowners, zonePathOf } from './codeowners.js';

/**
 * CODEOWNERS corpus: examples from the GitHub docs (`*`, `*.js`, `/build/logs/`, `docs/*`,
 * `apps/`, `/docs/`, `/scripts/`, double star, `/apps/github`) plus dialect edge cases
 * the docs do not cover.
 */

/** Tests one pattern against a path. A short wrapper to keep the tables readable. */
function matches(pattern: string, path: string): boolean {
    const rules = parseCodeowners(`${pattern} @owner`);
    return rules.length > 0 && ownersOf(rules, path) !== null;
}

function rule(pattern: string, ...owners: string[]): CodeownersRule {
    return { pattern, owners, line: 1 };
}

describe('CODEOWNERS: parsing', () => {
    it('drops comments and blank lines and splits owners into words', () => {
        const rules = parseCodeowners(
            ['# file header', '', '   ', '*.ts @alice @acme/core', 'docs/ docs@example.com # trailing comment'].join('\n'),
        );

        expect(rules).toEqual([
            { pattern: '*.ts', owners: ['@alice', '@acme/core'], line: 4 },
            { pattern: 'docs/', owners: ['docs@example.com'], line: 5 },
        ]);
    });

    it('parses a rule without owners, leaving the file unowned', () => {
        const rules = parseCodeowners(['/apps/ @octocat', '/apps/github'].join('\n'));

        expect(rules[1]).toEqual({ pattern: '/apps/github', owners: [], line: 2 });
        expect(ownersOf(rules, 'apps/github/main.ts')?.owners).toEqual([]);
        expect(ownersOf(rules, 'apps/other/main.ts')?.owners).toEqual(['@octocat']);
    });

    it('keeps an escaped space in the pattern instead of splitting words', () => {
        const rules = parseCodeowners('docs/release\\ notes/ @alice');

        expect(rules[0]?.owners).toEqual(['@alice']);
        expect(ownersOf(rules, 'docs/release notes/v1.md')).not.toBeNull();
        expect(ownersOf(rules, 'docs/release/notes/v1.md')).toBeNull();
    });

    it('drops the entire line for unsupported syntax', () => {
        const rules = parseCodeowners(
            ['!secret/ @alice', 'src/[a-z]*.ts @bob', 'weird\\#name @carol', 'src/ @dave'].join('\n'),
        );

        expect(rules).toEqual([{ pattern: 'src/', owners: ['@dave'], line: 4 }]);
    });

    it('keeps Windows line endings out of owners and patterns', () => {
        const rules = parseCodeowners('/src/ @alice\r\n/apps/github @acme/core\r\n');

        expect(rules).toEqual([
            { pattern: '/src/', owners: ['@alice'], line: 1 },
            { pattern: '/apps/github', owners: ['@acme/core'], line: 2 },
        ]);
        expect(ownersOf(rules, 'apps/github/main.ts')?.owners).toEqual(['@acme/core']);
    });

    it('keeps a leading BOM out of the first pattern', () => {
        const rules = parseCodeowners('\uFEFF/src/ @alice');

        expect(rules).toEqual([{ pattern: '/src/', owners: ['@alice'], line: 1 }]);
        expect(ownersOf(rules, 'src/a.ts')?.owners).toEqual(['@alice']);
    });

    it('treats braces literally because GitHub has no alternatives', () => {
        expect(matches('src/{a,b}.ts', 'src/{a,b}.ts')).toBe(true);
        expect(matches('src/{a,b}.ts', 'src/a.ts')).toBe(false);
    });
});

describe('CODEOWNERS: matching', () => {
    it('matches the examples from the GitHub docs', () => {
        expect(matches('*', 'a.ts')).toBe(true);
        expect(matches('*', 'src/deep/a.ts')).toBe(true);

        expect(matches('*.js', 'app.js')).toBe(true);
        expect(matches('*.js', 'src/deep/app.js')).toBe(true);
        expect(matches('*.js', 'app.ts')).toBe(false);

        expect(matches('/build/logs/', 'build/logs/a.txt')).toBe(true);
        expect(matches('/build/logs/', 'build/logs/deep/a.txt')).toBe(true);
        expect(matches('/build/logs/', 'src/build/logs/a.txt')).toBe(false);

        expect(matches('docs/*', 'docs/getting-started.md')).toBe(true);
        expect(matches('docs/*', 'docs/build-app/troubleshooting.md')).toBe(false);

        expect(matches('apps/', 'apps/a.ts')).toBe(true);
        expect(matches('apps/', 'src/deep/apps/a.ts')).toBe(true);
        expect(matches('apps/', 'apps')).toBe(false);

        expect(matches('/docs/', 'docs/a.md')).toBe(true);
        expect(matches('/docs/', 'src/docs/a.md')).toBe(false);

        expect(matches('/scripts/', 'scripts/deploy.sh')).toBe(true);

        expect(matches('**/logs', 'logs/a.txt')).toBe(true);
        expect(matches('**/logs', 'build/logs/a.txt')).toBe(true);
        expect(matches('**/logs', 'deeply/nested/logs/a.txt')).toBe(true);
        expect(matches('**/logs', 'build/logsly/a.txt')).toBe(false);

        expect(matches('/apps/github', 'apps/github')).toBe(true);
        expect(matches('/apps/github', 'apps/github/main.ts')).toBe(true);
        expect(matches('/apps/github', 'apps/other/main.ts')).toBe(false);
    });

    it('keeps a single star within `/` boundaries and matches one character with `?`', () => {
        expect(matches('src/*/a.ts', 'src/x/a.ts')).toBe(true);
        expect(matches('src/*/a.ts', 'src/x/y/a.ts')).toBe(false);
        expect(matches('src/a?.ts', 'src/ab.ts')).toBe(true);
        expect(matches('src/a?.ts', 'src/a/b.ts')).toBe(false);
    });

    it('matches any number of directories with double star, including zero', () => {
        expect(matches('a/**/b', 'a/b')).toBe(true);
        expect(matches('a/**/b', 'a/x/b')).toBe(true);
        expect(matches('a/**/b', 'a/x/y/b')).toBe(true);
        expect(matches('a/**/b', 'x/a/b')).toBe(false);

        expect(matches('**/foo', 'foo')).toBe(true);
        expect(matches('**/foo', 'x/y/foo')).toBe(true);

        expect(matches('foo/**', 'foo/a.ts')).toBe(true);
        expect(matches('foo/**', 'foo/a/b.ts')).toBe(true);
        expect(matches('foo/**', 'foo')).toBe(false);

        // A trailing `/` after double star adds nothing. It still means everything under foo.
        expect(matches('foo/**/', 'foo/a.ts')).toBe(true);
        expect(matches('foo/**/', 'foo/a/b.ts')).toBe(true);
        expect(matches('foo/**/', 'foo')).toBe(false);
    });

    it('matches a file or a directory and its contents without a trailing `/`', () => {
        expect(matches('src/lib', 'src/lib')).toBe(true);
        expect(matches('src/lib', 'src/lib/a.ts')).toBe(true);
        expect(matches('src/lib', 'src/library.ts')).toBe(false);
    });

    it('uses the last matching rule, regardless of specificity', () => {
        const rules = parseCodeowners(['* @root', 'src/ @src-team', '*.md @docs'].join('\n'));

        expect(ownersOf(rules, 'src/a.md')?.owners).toEqual(['@docs']);
        expect(ownersOf(rules, 'src/a.ts')?.owners).toEqual(['@src-team']);
        expect(ownersOf(rules, 'a.txt')?.owners).toEqual(['@root']);
    });

    it('leaves a path without a rule when none match', () => {
        expect(ownersOf(parseCodeowners('/src/ @alice'), 'docs/a.md')).toBeNull();
    });
});

describe('CODEOWNERS: zone boundaries', () => {
    it('uses the static pattern prefix as the zone', () => {
        expect(zonePathOf(rule('src/pci/**'), 'src/pci/a.ts')).toBe('src/pci');
        expect(zonePathOf(rule('/apps/'), 'apps/a.ts')).toBe('apps');
        expect(zonePathOf(rule('docs/*.md'), 'docs/a.md')).toBe('docs');
        expect(zonePathOf(rule('/apps/github'), 'apps/github/main.ts')).toBe('apps/github');
    });

    it('uses the top-level directory when the pattern has no static prefix', () => {
        expect(zonePathOf(rule('*.js'), 'src/deep/a.js')).toBe('src');
        expect(zonePathOf(rule('**/logs'), 'build/logs/a.txt')).toBe('build');
        expect(zonePathOf(rule('*.js'), 'a.js')).toBe('a.js');
    });

    it('places the zone at the match for a pattern that matches at any depth', () => {
        expect(zonePathOf(rule('apps/'), 'apps/a.ts')).toBe('apps');
        expect(zonePathOf(rule('apps/'), 'deep/nested/apps/a.ts')).toBe('deep/nested/apps');
    });
});
