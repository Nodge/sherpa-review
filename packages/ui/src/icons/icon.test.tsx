import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Icon, type IconName } from './icon.tsx';

const SPRITE = readFileSync(fileURLToPath(new URL('./sprite.svg', import.meta.url)), 'utf8');
const ICONS_CSS = readFileSync(fileURLToPath(new URL('./icons.css', import.meta.url)), 'utf8');
const ICON_NAMES: Record<IconName, true> = {
    'search': true,
    'chev-down': true,
    'chev-right': true,
    'thumb': true,
    'pencil': true,
    'check': true,
    'cross': true,
    'swap': true,
    'arrow-up': true,
    'arrow-down': true,
    'updown': true,
    'reply': true,
    'bold': true,
    'italic': true,
    'link': true,
    'code': true,
    'codeblock': true,
    'list': true,
    'trash': true,
    'sliders': true,
    'dot': true,
};

describe('SVG icons', () => {
    it('the sprite declares every Icon name exactly once', () => {
        const ids = symbols(SPRITE).map(([id]) => id);
        expect(ids.sort()).toEqual(Object.keys(ICON_NAMES).map((name) => `ic-${name}`).sort());
    });

    for (const name of Object.keys(ICON_NAMES) as IconName[]) {
        it(`${name} references its sprite symbol`, () => {
            const html = renderToStaticMarkup(<Icon name={name} size={14} />);
            expect(html).toContain(`<use href="#ic-${name}"></use>`);
        });
    }

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
