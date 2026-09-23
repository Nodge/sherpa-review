import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * One hover rule (docs/design/SPEC-changes-2026-09-20.md §5): hover changes only
 * the surface. Check this mechanically: a component style that recolours text or borders on hover
 * creates a second set of states outside `controls.css` and diverges from the §5 table.
 *
 * Two exceptions, both from the spec: links (no surface, colour follows the accent
 * scale) and the trash button (the icon turns red with the background). Both live in `controls.css`, so
 * the test does not read the state file itself or the base layer.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));
const EXEMPT = new Set([path.join(SRC, 'styles', 'controls.css'), path.join(SRC, 'styles', 'base.css')]);

function cssFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return cssFiles(full);
        }
        return entry.isFile() && entry.name.endsWith('.css') && !EXEMPT.has(full) ? [full] : [];
    });
}

/** Selector and properties of each rule block in the file. Styles have no nested blocks. */
function rules(css: string): { selector: string; body: string }[] {
    return [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((match) => ({
        selector: (match[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' '),
        body: match[2] ?? '',
    }));
}

describe('hover rule §5', () => {
    for (const file of cssFiles(SRC)) {
        const name = path.relative(SRC, file);

        it(`${name}: hover changes only the surface`, () => {
            const offenders = rules(readFileSync(file, 'utf8'))
                .filter((rule) => rule.selector.includes(':hover'))
                .filter((rule) => /(?:^|;|\s)(?:color|border-color)\s*:/.test(rule.body))
                .map((rule) => rule.selector);

            expect(
                offenders,
                'hover recolours text or borders: state colour belongs in styles/controls.css, ' +
                    'component styles keep only layout (SPEC-changes-2026-09-20.md §5)',
            ).toEqual([]);
        });
    }
});
