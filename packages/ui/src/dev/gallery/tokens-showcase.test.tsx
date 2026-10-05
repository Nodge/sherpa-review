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

describe('token display values', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each([
        ['dark', false, '#0d0e10'],
        ['light', false, '#f6f7f9'],
        ['dark', true, '#2d2c33'],
        ['light', true, '#ffffff'],
    ] as const)('shows the value for theme %s', (theme, expected) => {
        const host = document.createElement('div');
        host.innerHTML = renderToStaticMarkup(
            <SettingsProvider store={createUiSettingsStore({ loaded: true, initial: { theme } })}>
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
        ['dark', false, "'IBM Plex Sans', system-ui, sans-serif", "'IBM Plex Mono', ui-monospace, monospace", '0.8125rem'],
        ['light', false, "'IBM Plex Sans', system-ui, sans-serif", "'IBM Plex Mono', ui-monospace, monospace", '0.8125rem'],
        ['auto', false, "'IBM Plex Sans', system-ui, sans-serif", "'IBM Plex Mono', ui-monospace, monospace", '0.8125rem'],
        [
            'dark',
            true,
            "'IBM Plex Sans', 'Helvetica Neue', Arial, Helvetica, sans-serif",
            "Menlo, Monaco, Consolas, 'Liberation Mono', 'Ubuntu Mono', 'DejaVu Sans Mono', 'Courier New', Courier, monospace",
            '0.875rem',
        ],
        [
            'light',
            true,
            "'IBM Plex Sans', 'Helvetica Neue', Arial, Helvetica, sans-serif",
            "Menlo, Monaco, Consolas, 'Liberation Mono', 'Ubuntu Mono', 'DejaVu Sans Mono', 'Courier New', Courier, monospace",
            '0.875rem',
        ],
        [
            'auto',
            true,
            "'IBM Plex Sans', 'Helvetica Neue', Arial, Helvetica, sans-serif",
            "Menlo, Monaco, Consolas, 'Liberation Mono', 'Ubuntu Mono', 'DejaVu Sans Mono', 'Courier New', Courier, monospace",
            '0.875rem',
        ],
    ] as const)('labels typography for %s with font families and sizes', (theme, sans, mono, uiSize) => {
        const host = document.createElement('div');
        host.innerHTML = renderToStaticMarkup(
            <SettingsProvider store={createUiSettingsStore({ loaded: true, initial: { theme } })}>
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

    
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('matchMedia', () => ({
            matches: system === 'dark',
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        }));
        const settings = createUiSettingsStore({ loaded: true, initial: { theme: 'dark' } });
        const host = document.createElement('div');
        const root = createRoot(host);
        try {
            act(() => {
                root.render(<SettingsProvider store={settings}><TokenSwatches /><TypographyScale /></SettingsProvider>);
            });
            act(() => {
                settings.update({ theme: 'auto' });
            });

            expect(host.textContent).toContain("'IBM Plex Sans', 'Helvetica Neue', Arial, Helvetica, sans-serif");
            expect(surfaceValue(host)).toBe(system === 'dark' ? '#2d2c33' : '#ffffff');
            expect([...host.querySelectorAll('.sample__label')].map((label) => label.textContent))
                .toContain('--font-size-ui · 0.875rem');

            
            expect(host.textContent).toContain("'IBM Plex Sans', system-ui, sans-serif");
            expect(host.textContent).toContain("'IBM Plex Mono', ui-monospace, monospace");
            
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
