import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * System rule: values live only in `tokens.css`, component styles use
 * variables. Checked mechanically, since a second set of colors can appear unnoticed
 * and drift from the handoff.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));
const TOKENS = path.join(SRC, 'styles', 'tokens.css');

function cssFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return cssFiles(full);
        }
        return entry.isFile() && entry.name.endsWith('.css') && full !== TOKENS ? [full] : [];
    });
}

const FILES = cssFiles(SRC);
const DECLARED = new Set(
    [...readFileSync(TOKENS, 'utf8').matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]),
);

describe('component styles', () => {
    it('finds style files', () => {
        expect(FILES.length).toBeGreaterThan(0);
    });

    for (const file of FILES) {
        const name = path.relative(SRC, file);
        const css = readFileSync(file, 'utf8');

        it(`${name}: palette selection stays in tokens.css`, () => {
            const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/\[data-theme\s*(?:=|[~|^$*]=)[^\]]*\]/g);
            expect(selectors ?? []).toEqual([]);
        });

        it(`${name}: colours use tokens only`, () => {
            const literals = [
                ...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
                ...css.matchAll(/\brgba?\(/g),
                ...css.matchAll(/\bhsla?\(/g),
            ].map((match) => match[0]);

            expect(literals).toEqual([]);
        });

        // Text size is entirely in rem through tokens (docs/design/theme.md, "Typography"):
        // px would detach the interface from the system font size and L mode again.
        it(`${name}: text sizes use tokens only`, () => {
            const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((match) => match[1]?.trim());

            expect(
                sizes.filter((size) => size === undefined || !(size.startsWith('var(') || size === 'inherit')),
            ).toEqual([]);
        });

        it(`${name}: uses only declared tokens`, () => {
            const used = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1]);
            // A file-local variable is not a second set of values. It gives this view's layout constant
            // a single definition (its colour cannot be hidden anyway: literals are forbidden above).
            const local = new Set(
                [...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]),
            );

            expect(
                used.filter((token) => token !== undefined && !DECLARED.has(token) && !local.has(token)),
            ).toEqual([]);
        });
    }
});
