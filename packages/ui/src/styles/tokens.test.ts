import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { describePalette, duplicateDeclarations, parseRootTokens, themeBlock } from './tokens.test-support.js';

const TOKENS_CSS = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');

const darkPalette = parseRootTokens(TOKENS_CSS);
const lightCss = themeBlock(TOKENS_CSS, 'light');
const lightPalette = parseRootTokens(lightCss);
const fontSizes = new Map([...darkPalette].filter(([name]) => name.startsWith('--font-size-')));

describe('design tokens', () => {
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

    it('declares a font scale', () => {
        expect(fontSizes.size).toBeGreaterThan(0);
    });

    for (const [name, size] of fontSizes) {
        it(`${name} uses a positive rem size`, () => {
            expect(size).toMatch(/^(?:\d+|\d*\.\d+)rem$/);
            expect(Number.parseFloat(size)).toBeGreaterThan(0);
        });
    }

    it('only decorative glyphs and the stop label are below the 11px floor', () => {
        const below = [...fontSizes]
            .filter(
                ([name, size]) =>
                    !GLYPHS.has(name) && !FLOOR_EXCEPTIONS.has(name) && Number.parseFloat(size) < FLOOR_REM,
            )
            .map(([name]) => name);
        expect(below).toEqual([]);
    });

    it('the stop label is the 10px text exception', () => {
        expect(Number.parseFloat(fontSizes.get('--font-size-stop-mark') ?? '')).toBe(0.625);
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
        isLow: (pair) => pair.low?.includes(theme) === true,
    });
}
