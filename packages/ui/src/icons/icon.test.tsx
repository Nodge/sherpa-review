import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Icon } from './icon.tsx';

const SPRITE = readFileSync(fileURLToPath(new URL('./sprite.svg', import.meta.url)), 'utf8');
const ICONS_CSS = readFileSync(fileURLToPath(new URL('./icons.css', import.meta.url)), 'utf8');
const DESIGN = readFileSync(
    fileURLToPath(new URL('../../../../docs/design/Sherpa Additions.dc.html', import.meta.url)),
    'utf8',
);
/** Additions has no sliders icon. Its drawing comes from the settings menu trigger in the prototype. */
const PROTOTYPE = readFileSync(
    fileURLToPath(new URL('../../../../docs/design/Sherpa.dc.html', import.meta.url)),
    'utf8',
);
/** Additions has no open-issue dot either. It came with iteration 09-20. */
const CHANGES = readFileSync(
    fileURLToPath(new URL('../../../../docs/design/Sherpa Changes 2026-09-20.dc.html', import.meta.url)),
    'utf8',
);

const ICON_IDS = [
    'ic-search',
    'ic-chev-down',
    'ic-chev-right',
    'ic-thumb',
    'ic-pencil',
    'ic-check',
    'ic-cross',
    'ic-swap',
    'ic-arrow-up',
    'ic-arrow-down',
    'ic-updown',
    'ic-reply',
    'ic-bold',
    'ic-italic',
    'ic-link',
    'ic-code',
    'ic-codeblock',
    'ic-list',
    'ic-trash',
] as const;

describe('SVG icons', () => {
    it('19 symbols come verbatim from Sherpa Additions, followed by sliders and a dot from the prototypes', () => {
        const designSprite = /<svg width="0" height="0" style="position:absolute" aria-hidden="true">[\s\S]*?<\/svg>/u.exec(
            DESIGN,
        )?.[0];
        expect(designSprite).toBeDefined();

        const design = symbols(designSprite ?? '');
        expect(design.map(([id]) => id)).toEqual(ICON_IDS);
        // Exact match: each symbol in the set is in the sprite exactly as the design supplied it.
        for (const [, markup] of design) {
            expect(SPRITE).toContain(markup);
        }
        expect(symbols(SPRITE).map(([id]) => id)).toEqual([...ICON_IDS, 'ic-sliders', 'ic-dot']);
    });

    it('the open-issue dot comes verbatim from the iteration 09-20 prototype', () => {
        const dot = symbols(SPRITE).find(([id]) => id === 'ic-dot')?.[1] ?? '';

        expect(CHANGES).toContain(dot);
    });

    it('the sliders drawing matches the settings menu trigger in the prototype', () => {
        const prototypeIcon = /title="\{\{ L\.menuTitle \}\}"[\s\S]*?<svg[^>]*>([\s\S]*?)<\/svg>/u.exec(PROTOTYPE)?.[1];
        expect(prototypeIcon).toBeDefined();

        const sliders = symbols(SPRITE).find(([id]) => id === 'ic-sliders')?.[1] ?? '';
        expect(sliders).toContain(prototypeIcon);
        // Same stroke as the rest of the set: width between 1.35–1.7 and rounded ends.
        expect(sliders).toContain('stroke="currentColor" stroke-width="1.4"');
        expect(sliders).toContain('viewBox="0 0 16 16"');
    });

    it('svg has its own viewBox and exact size and is hidden from the accessibility tree', () => {
        const html = renderToStaticMarkup(<Icon name="swap" size={14} />);

        expect(html).toContain('width="14" height="14" viewBox="0 0 16 16"');
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain('focusable="false"');
        expect(html).toContain('<use href="#ic-swap"></use>');
    });

    it('the flex container cannot shrink svg', () => {
        expect(ICONS_CSS).toMatch(/\.icon\s*\{[^}]*display:\s*block;[^}]*flex:\s*none;/su);
    });
});

/** Pairs of "id → symbol markup" in file order. */
function symbols(sprite: string): [string, string][] {
    return [...sprite.matchAll(/<symbol id="([^"]+)"[\s\S]*?<\/symbol>/gu)].map((match) => [match[1] ?? '', match[0]]);
}
