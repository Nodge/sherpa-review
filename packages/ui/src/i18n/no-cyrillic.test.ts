import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The entire UI uses the dictionary. No Cyrillic is allowed in `packages/ui/src` code, in labels,
 * `title` attributes or messages. This test checks translation completeness.
 *
 * Excluded: comments (documentation for developers, outside the reviewer interface), the Russian
 * the `i18n/ru.ts` dictionary, tests, and `dev/**`. The gallery uses fixtures and state labels,
 * which the reviewer never sees.
 */
function skipped(file: string): boolean {
    return file.startsWith('dev/') || file.includes('.test.') || file === 'i18n/ru.ts';
}

const CYRILLIC = /[\u0400-\u04FF]/u;
const SRC = fileURLToPath(new URL('..', import.meta.url));

describe('UI translation', () => {
    it('contains no Cyrillic outside comments', () => {
        const files = sources(SRC).filter((file) => !skipped(file));
        // Guard against silently finding nothing: a broken directory walk would make the test pass without checking anything.
        expect(files.length, 'directory walk found nothing').toBeGreaterThan(100);

        const found: string[] = [];
        for (const file of files) {
            const source = stripComments(readFileSync(SRC + file, 'utf8'));
            source.split('\n').forEach((line, index) => {
                if (CYRILLIC.test(line)) {
                    found.push(`${file}:${String(index + 1)}: ${line.trim()}`);
                }
            });
        }
        expect(found, 'Cyrillic in code: text must be in the dictionary').toEqual([]);
    });

    it('strips comments but preserves strings and URLs inside them', () => {
        const source = [
            '// comment',
            "/* block */ const a = 'text';",
            "const url = 'http://host/#t=1'; // tail",
            '{/* JSX comment */}',
        ].join('\n');

        const stripped = stripComments(source).split('\n');
        expect(stripped[0]?.trim()).toBe('');
        expect(stripped[1]).toContain("'text'");
        expect(stripped[2]).toContain("'http://host/#t=1'");
        expect(stripped[3]?.trim()).toMatch(/^\{ +\}$/u);
    });

    it('does not treat a quote in a regex literal as the start of a string', () => {
        // Without parsing the regex, a quote in the character class would open a "string" until the end of the file,
        // and the following comment would survive stripping.
        const source = ['const re = /["\'`]+/u;', '// comment', "const b = 'text';"].join('\n');

        const stripped = stripComments(source).split('\n');
        expect(stripped[1]?.trim()).toBe('');
        expect(stripped[2]).toContain("'text'");
    });
});

/** All `.ts`/`.tsx` files in the directory, with paths relative to `src`. */
function sources(root: string, rel = ''): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(`${root}${rel}`)) {
        const next = `${rel}${entry}`;
        if (statSync(`${root}${next}`).isDirectory()) {
            found.push(...sources(root, `${next}/`));
        } else if (/\.tsx?$/u.test(entry)) {
            found.push(next);
        }
    }
    return found;
}

/**
 * Replaces comment contents with spaces, preserving newlines so that line numbers in the report
 * stay correct. String literals (including template literals) pass through the check unchanged.
 * `//` inside a URL is not a comment. Regex literals are skipped in full: otherwise, a quote
 * in a character class would open a string and break parsing for the rest of the file.
 */
function stripComments(source: string): string {
    const out: string[] = [];
    let index = 0;
    let quote: string | null = null;
    // The last significant character before `/` distinguishes a regex literal from division.
    let significant = '';

    const blank = (text: string): string => text.replaceAll(/[^\n]/gu, ' ');

    while (index < source.length) {
        const char = source[index] ?? '';
        if (quote !== null) {
            out.push(char);
            if (char === '\\') {
                out.push(source[index + 1] ?? '');
                index += 2;
                continue;
            }
            if (char === quote) {
                quote = null;
                significant = char;
            }
            index += 1;
            continue;
        }
        if (char === "'" || char === '"' || char === '`') {
            quote = char;
            out.push(char);
            index += 1;
            continue;
        }
        if (char === '/' && source[index + 1] === '/') {
            const end = source.indexOf('\n', index);
            const stop = end === -1 ? source.length : end;
            out.push(blank(source.slice(index, stop)));
            index = stop;
            continue;
        }
        if (char === '/' && source[index + 1] === '*') {
            const end = source.indexOf('*/', index + 2);
            const stop = end === -1 ? source.length : end + 2;
            out.push(blank(source.slice(index, stop)));
            index = stop;
            continue;
        }
        if (char === '/') {
            const end = regexEnd(source, index, significant);
            if (end !== -1) {
                out.push(source.slice(index, end));
                index = end;
                significant = '/';
                continue;
            }
        }
        out.push(char);
        if (!/\s/u.test(char)) {
            significant = char;
        }
        index += 1;
    }
    return out.join('');
}

/**
 * The allowed characters deliberately exclude `<`, `>` and `}`: they begin `</div>` and
 * `{...} />`, and no regular expression follows them.
 */
const REGEX_ALLOWED_BEFORE = new Set([
    '(',
    ',',
    '=',
    ':',
    '[',
    '!',
    '&',
    '|',
    '?',
    '+',
    '-',
    '*',
    '%',
    '^',
    '~',
    ';',
    '{',
]);

/** The end of the regex literal starting at `start`, or `-1` for division or JSX. */
function regexEnd(source: string, start: number, significant: string): number {
    if (significant !== '' && !REGEX_ALLOWED_BEFORE.has(significant)) {
        return -1;
    }
    let index = start + 1;
    let inClass = false;
    while (index < source.length) {
        const char = source[index];
        // A regex literal cannot span lines. An unclosed `/` means division.
        if (char === '\n') {
            return -1;
        }
        if (char === '\\') {
            index += 2;
            continue;
        }
        if (char === '[') {
            inClass = true;
        } else if (char === ']') {
            inClass = false;
        } else if (char === '/' && !inClass) {
            index += 1;
            while (/[a-z]/u.test(source[index] ?? '')) {
                index += 1;
            }
            return index;
        }
        index += 1;
    }
    return -1;
}
