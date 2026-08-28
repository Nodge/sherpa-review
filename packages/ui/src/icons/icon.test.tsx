import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Icon } from './icon.tsx';

const SPRITE = readFileSync(fileURLToPath(new URL('./sprite.svg', import.meta.url)), 'utf8');
const ICONS_CSS = readFileSync(fileURLToPath(new URL('./icons.css', import.meta.url)), 'utf8');
const DESIGN = readFileSync(
    fileURLToPath(new URL('../../../../design/design_handoff_sherpa/Sherpa Additions.dc.html', import.meta.url)),
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
    it('extracts the sprite verbatim from Sherpa Additions with all 19 symbols', () => {
        const designSprite = /<svg width="0" height="0" style="position:absolute" aria-hidden="true">[\s\S]*?<\/svg>/u.exec(
            DESIGN,
        )?.[0];
        expect(designSprite).toBeDefined();
        expect(SPRITE.trim()).toBe(designSprite);
        expect([...SPRITE.matchAll(/<symbol id="([^"]+)"/gu)].map((match) => match[1])).toEqual(ICON_IDS);
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
