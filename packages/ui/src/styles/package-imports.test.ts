import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The third-party notices of the npm package come from the modules of the UI build (`vite.config.ts`). CSS pulled in
 * through `@import` inside a CSS file never appears there, so a package imported that way would be missing from the
 * notices. Only relative `@import` outside `node_modules` is allowed in the UI's styles.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

function cssFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return cssFiles(full);
        }
        return entry.isFile() && entry.name.endsWith('.css') ? [full] : [];
    });
}

/** Specifiers of `@import "x"`, `@import 'x'` and `@import url(x)`, comments stripped. */
function importSpecifiers(css: string): string[] {
    const code = css.replace(/\/\*[\s\S]*?\*\//gu, '');
    return [...code.matchAll(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1/gu)].map((match) => match[2] ?? '');
}

/** Not relative or root-relative, or reaching into `node_modules` by path. */
function isPackageImport(specifier: string): boolean {
    return !/^(\.\.?)?\//u.test(specifier) || specifier.split('/').includes('node_modules');
}

describe('package CSS through @import', () => {
    it('parses the quoted and url() forms', () => {
        expect(
            importSpecifiers(`@import './a.css';\n@import "b.css" layer(x);\n@import url(highlight.js/x.css);\n@import url("/c.css");\n/* @import 'z'; */`),
        ).toEqual(['./a.css', 'b.css', 'highlight.js/x.css', '/c.css']);
    });

    it('treats a relative path into node_modules as a package import', () => {
        const specifiers = importSpecifiers(`@import '../../node_modules/pkg/theme.css';\n@import url(/node_modules/pkg/a.css);`);

        expect(specifiers.filter((specifier) => isPackageImport(specifier))).toEqual(specifiers);
    });

    for (const file of cssFiles(SRC)) {
        const name = path.relative(SRC, file);

        it(`${name} imports only relative CSS`, () => {
            const external = importSpecifiers(readFileSync(file, 'utf8')).filter((specifier) => isPackageImport(specifier));

            expect(
                external,
                'the third-party notices collector cannot see package CSS pulled in through @import: ' +
                    'import it from JS/TS instead, or extend the collector in vite.config.ts',
            ).toEqual([]);
        });
    }
});
