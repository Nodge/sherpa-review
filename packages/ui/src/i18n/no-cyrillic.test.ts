import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * First translation pass (M5-T2): these files must have no Cyrillic in code. All text
 * goes into the dictionary. Comments stay Russian and are excluded from the check: they document
 * the code for us, rather than the reviewer interface.
 *
 * T3 will extend the list to all of `packages/ui/src`.
 */
const TRANSLATED_FILES = [
    'app.tsx',
    'main.tsx',
    'components/banner-slot.tsx',
    'components/command-box.tsx',
    'components/generation-cap-banner.tsx',
    'components/review-action-bar.tsx',
    'components/review-action-model.ts',
    'components/top-bar.tsx',
    'components/update-state.ts',
    'components/update-toast.tsx',
    'components/use-delayed-pending.ts',
    'components/view-tabs.tsx',
    'i18n/context.tsx',
    'i18n/en.ts',
    'i18n/format.ts',
    'i18n/index.ts',
    'i18n/locale-commands.ts',
    'i18n/translate.ts',
    'palette/command-palette.tsx',
    'palette/cursor.ts',
    'palette/diff-search.ts',
    'palette/diff-source.tsx',
    'palette/fuzzy.ts',
    'palette/query.ts',
    'session/views.ts',
    'settings/context.tsx',
    'settings/settings-store.ts',
    'shortcuts/context.tsx',
    'shortcuts/registry.ts',
    'views/view-frames.tsx',
];

const CYRILLIC = /[\u0400-\u04FF]/u;
const SRC = fileURLToPath(new URL('..', import.meta.url));

describe('first translation pass', () => {
    it('contains no Cyrillic outside comments', () => {
        const found: string[] = [];
        for (const file of TRANSLATED_FILES) {
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
            "// comment",
            "/* block */ const a = 'text';",
            "const url = 'http://host/#t=1'; // tail",
            "{/* JSX comment */}",
        ].join('\n');

        const stripped = stripComments(source).split('\n');
        expect(stripped[0]?.trim()).toBe('');
        expect(stripped[1]).toContain("'text'");
        expect(stripped[2]).toContain("'http://host/#t=1'");
        expect(stripped[3]?.trim()).toMatch(/^\{ +\}$/u);
    });
});

/**
 * Replaces comment contents with spaces, preserving newlines so that line numbers in the report
 * stay correct. String literals (including template literals) pass through the check unchanged.
 * `//` inside a URL does not count as a comment.
 */
function stripComments(source: string): string {
    const out: string[] = [];
    let index = 0;
    let quote: string | null = null;

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
        out.push(char);
        index += 1;
    }
    return out.join('');
}
