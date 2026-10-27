// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsProvider } from '../../settings/context.tsx';
import { createUiSettingsStore } from '../../settings/settings-store.js';
import { TokenSwatches, TypographyScale } from './tokens-showcase.tsx';

// Vitest disables CSS even with ?raw. The example needs the source text that Vite reads.
vi.mock('../../styles/tokens.css?raw', async () => {
    const { readFileSync } = await import('node:fs');
    return { default: readFileSync('src/styles/tokens.css', 'utf8') };
});

/** A test extra style: the example checks the mechanism independently of styles in `styles/extra/`. */
vi.mock('../../styles/extra-styles.js', () => ({
    EXTRA_STYLES: [{ id: 'sample', label: { en: 'Sample style', ru: 'Sample style (ru)' } }],
}));
vi.mock('./extra-style-sources.js', () => ({
    EXTRA_STYLE_CSS: [
        ['dark', 'light'].map((scheme) => `
            :root[data-theme='sample-${scheme}'],
            [data-theme='sample-${scheme}'] {
                --surface-app: ${scheme === 'dark' ? '#202122' : '#fefefe'};
                --font-sans: 'Sample Sans', sans-serif;
                --font-mono: 'Sample Mono', monospace;
                --font-size-ui: 0.875rem;
            }
        `).join('\n'),
    ],
}));

describe('token display values', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each([
        ['dark', null, '#0d0e10'],
        ['light', null, '#f6f7f9'],
        ['dark', 'sample', '#202122'],
        ['light', 'sample', '#fefefe'],
    ] as const)('shows the value for theme %s with style %s', (theme, style, expected) => {
        const host = document.createElement('div');
        host.innerHTML = renderToStaticMarkup(
            <SettingsProvider store={createUiSettingsStore({ loaded: true, initial: { theme, style } })}>
                <TokenSwatches />
            </SettingsProvider>,
        );
        const swatches = [...host.querySelectorAll('.swatch')];
        const surface = swatches.find((swatch) => swatch.querySelector('.swatch__name')?.textContent === '--surface-app');
        expect(surface?.querySelector('.swatch__value')?.textContent).toBe(expected);
        expect(swatches.filter((swatch) => swatch.querySelector('.swatch__name')?.textContent === '--surface-app'))
            .toHaveLength(1);
    });

    it.each([
        ['dark', null, "'IBM Plex Sans', system-ui, sans-serif", "'IBM Plex Mono', ui-monospace, monospace", '0.8125rem'],
        ['light', null, "'IBM Plex Sans', system-ui, sans-serif", "'IBM Plex Mono', ui-monospace, monospace", '0.8125rem'],
        ['auto', null, "'IBM Plex Sans', system-ui, sans-serif", "'IBM Plex Mono', ui-monospace, monospace", '0.8125rem'],
        ['dark', 'sample', "'Sample Sans', sans-serif", "'Sample Mono', monospace", '0.875rem'],
        ['light', 'sample', "'Sample Sans', sans-serif", "'Sample Mono', monospace", '0.875rem'],
        ['auto', 'sample', "'Sample Sans', sans-serif", "'Sample Mono', monospace", '0.875rem'],
    ] as const)('labels typography %s with style %s by font families and sizes', (theme, style, sans, mono, uiSize) => {
        const host = document.createElement('div');
        host.innerHTML = renderToStaticMarkup(
            <SettingsProvider store={createUiSettingsStore({ loaded: true, initial: { theme, style } })}>
                <TypographyScale />
            </SettingsProvider>,
        );

        expect.soft([...host.querySelectorAll('h3')].slice(0, 2).map((heading) => heading.textContent))
            .toEqual([sans, mono]);
        const labels = [...host.querySelectorAll('.sample__label')].map((label) => label.textContent);
        expect.soft(labels.filter((label) => label.startsWith('--font-size-ui ·')))
            .toEqual([`--font-size-ui · ${uiSize}`, `--font-size-ui · ${uiSize}`]);
        // A size without an override keeps its base value in both font families.
        expect(labels.filter((label) => label.startsWith('--font-size-code ·')))
            .toEqual(['--font-size-code · 0.75rem', '--font-size-code · 0.75rem']);
    });

    it.each(['dark', 'light'] as const)('auto with system %s keeps the style until it is turned off', (system) => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('matchMedia', () => ({
            matches: system === 'dark',
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        }));
        const settings = createUiSettingsStore({ loaded: true, initial: { theme: 'dark', style: 'sample' } });
        const host = document.createElement('div');
        const root = createRoot(host);
        try {
            act(() => {
                root.render(<SettingsProvider store={settings}><TokenSwatches /><TypographyScale /></SettingsProvider>);
            });
            act(() => {
                settings.update({ theme: 'auto' });
            });

            expect(host.textContent).toContain("'Sample Sans', sans-serif");
            expect(surfaceValue(host)).toBe(system === 'dark' ? '#202122' : '#fefefe');
            expect([...host.querySelectorAll('.sample__label')].map((label) => label.textContent))
                .toContain('--font-size-ui · 0.875rem');

            act(() => { settings.update({ style: null }); });
            expect(host.textContent).toContain("'IBM Plex Sans', system-ui, sans-serif");
            expect(host.textContent).toContain("'IBM Plex Mono', ui-monospace, monospace");
            expect(host.textContent).not.toContain('Sample Sans');
            expect(surfaceValue(host)).toBe(system === 'dark' ? '#0d0e10' : '#f6f7f9');
            expect([...host.querySelectorAll('.sample__label')].map((label) => label.textContent))
                .toContain('--font-size-ui · 0.8125rem');
        } finally {
            act(() => { root.unmount(); });
        }
    });
});

function surfaceValue(host: HTMLElement): string | null | undefined {
    return [...host.querySelectorAll('.swatch')]
        .find((swatch) => swatch.querySelector('.swatch__name')?.textContent === '--surface-app')
        ?.querySelector('.swatch__value')?.textContent;
}
