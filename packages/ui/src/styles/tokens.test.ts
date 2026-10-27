import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    describePalette,
    duplicateDeclarations,
    EXPECTED,
    normalize,
    parsePaletteDoc,
    parseRootTokens,
    parseTypographyDoc,
    remToPx,
    themeBlock,
} from './tokens.test-support.js';

/**
 * Check the main style's design tokens against the handoff.
 *
 * Geometry, fonts, disabled opacity and motion are checked against `EXPECTED`, a table
 * copied from the "Design tokens" section of `docs/design/README.md`.
 * Dark and light palette colours are checked against `docs/design/theme.md`. Component tokens live only in CSS.
 * Check that each theme has the full set, without duplicating values in the docs. Extra styles
 * are checked by the test in their style directory.
 */

const TOKENS_CSS = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');
const THEME_MD = readFileSync(fileURLToPath(new URL('../../../../docs/design/theme.md', import.meta.url)), 'utf8');

const darkPalette = parseRootTokens(TOKENS_CSS);
const lightCss = themeBlock(TOKENS_CSS, 'light');
const lightPalette = parseRootTokens(lightCss);
const documented = parsePaletteDoc(THEME_MD);
const documentedScale = parseTypographyDoc(THEME_MD);

describe('design tokens', () => {
    it(':root declares every handoff token from README.md and theme.md', () => {
        expect([...darkPalette.keys()]).toEqual(
            expect.arrayContaining([...Object.keys(EXPECTED), ...documented.dark.keys()]),
        );
    });

    it('the handoff non-colour table contains no colours', () => {
        expect(Object.entries(EXPECTED).filter(([, value]) => /#|rgba?\(/.test(value))).toEqual([]);
    });

    for (const [name, expected] of Object.entries(EXPECTED)) {
        it(`${name} = ${expected}`, () => {
            expect(darkPalette.get(name)).toBe(normalize(expected));
        });
    }

    it('each token is declared once in each palette', () => {
        expect(duplicateDeclarations(TOKENS_CSS)).toEqual([]);
    });
});

/**
 * Font scale: docs/design/SPEC-theming-2026-09-12.md §5. Everything uses rem relative to the `html` base, with an
 * 11px floor (0.6875rem). Only decorative glyphs with no text of their own sit below it.
 */
describe('font scale', () => {
    const GLYPHS = new Set(['--font-size-avatar-glyph']);
    /**
     * The only text below the floor is the stop label in a tree row (§5, §6a): 10px in a
     * 17×13 label at the left edge. This list is closed. A second exception must go through the spec.
     */
    const FLOOR_EXCEPTIONS = new Set(['--font-size-stop-mark']);
    const FLOOR_REM = 0.6875;

    it('the theme.md table lists exactly the font tokens from tokens.css', () => {
        const inCss = [...darkPalette.keys()].filter((name) => name.startsWith('--font-size-'));
        expect(inCss.sort()).toEqual([...documentedScale.keys()].sort());
    });

    for (const [name, row] of documentedScale) {
        it(`${name} = ${row.rem}`, () => {
            expect(darkPalette.get(name)).toBe(normalize(row.rem));
            expect(row.m).toBe(remToPx(row.rem, 16));
            expect(row.l).toBe(remToPx(row.rem, 18));
        });
    }

    it('only decorative glyphs and the stop label are below the 11px floor', () => {
        const below = [...documentedScale]
            .filter(
                ([name, row]) =>
                    !GLYPHS.has(name) && !FLOOR_EXCEPTIONS.has(name) && Number.parseFloat(row.rem) < FLOOR_REM,
            )
            .map(([name]) => name);
        expect(below).toEqual([]);
    });

    it('there is exactly one floor exception, the stop label', () => {
        expect([...FLOOR_EXCEPTIONS]).toEqual(['--font-size-stop-mark']);
        expect(documentedScale.get('--font-size-stop-mark')?.rem).toBe('0.625rem');
    });

    it('the scale base and L text size are set on html', () => {
        expect(TOKENS_CSS).toMatch(/html\s*\{\s*font-size:\s*100%;\s*\}/);
        expect(TOKENS_CSS).toMatch(/html\[data-textsize='l']\s*\{\s*font-size:\s*112\.5%;\s*\}/);
    });
});

describe('theme palettes', () => {
    it('the light palette switches color-scheme', () => {
        expect(lightCss).toContain('color-scheme: light;');
    });

    it('each theme subtree starts with the original tokens, including fonts and geometry', () => {
        expect(TOKENS_CSS).toMatch(/:root,\s*\[data-theme\]\s*\{/);
    });
});

for (const [theme, tokens] of [['dark', darkPalette], ['light', lightPalette]] as const) {
    describePalette({
        theme,
        tokens,
        baseKeys: [...darkPalette.keys()],
        documented: documented[theme],
        isLow: (pair) => pair.low?.includes(theme) === true,
    });
}
