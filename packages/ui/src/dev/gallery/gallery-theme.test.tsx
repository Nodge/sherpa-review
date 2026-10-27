// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Gallery, parseGalleryStyle, parseGalleryTheme } from './gallery.tsx';
import { GALLERY_STATES } from './states.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Test extra style: the gallery tests the mechanism without using styles from `styles/extra/`. */
vi.mock('../../styles/extra-styles.js', () => ({
    EXTRA_STYLES: [{ id: 'sample', label: { en: 'Sample style', ru: 'Sample style (ru)' } }],
}));

const mounted: (() => void)[] = [];
afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    history.replaceState(null, '', '/');
});

describe('gallery theme', () => {
    it('URL distinguishes 3 theme modes and the build style', () => {
        for (const theme of ['auto', 'dark', 'light'] as const) {
            expect(parseGalleryTheme(theme)).toBe(theme);
        }
        expect(parseGalleryTheme(null)).toBe('dark');
        expect(parseGalleryTheme('unknown')).toBe('dark');
        expect(parseGalleryStyle('sample')).toBe('sample');
        expect(parseGalleryStyle('')).toBeNull();
        expect(parseGalleryStyle(null)).toBeNull();
        expect(parseGalleryStyle('unknown')).toBeNull();
    });

    it('switches style independently of theme and saves both choices in the URL', () => {
        const host = mount(<Gallery initialId="settings-menu-open" />);
        const toggle = host.querySelector<HTMLButtonElement>('.gallery__stage-title [role="switch"]');
        const themes = host.querySelectorAll<HTMLButtonElement>('.gallery__themes[role="group"] button');
        expect(toggle?.textContent).toBe('Sample style');
        expect(themes).toHaveLength(3);
        act(() => {
            toggle?.click();
        });

        expect(document.documentElement.dataset.theme).toBe('sample-dark');
        expect(toggle?.getAttribute('aria-checked')).toBe('true');
        expect(new URLSearchParams(location.hash.slice(1)).get('theme')).toBe('dark');
        expect(new URLSearchParams(location.hash.slice(1)).get('style')).toBe('sample');

        const light = [...themes].find((button) => button.textContent === 'light');
        act(() => { light?.click(); });
        expect(document.documentElement.dataset.theme).toBe('sample-light');
        expect(light?.getAttribute('aria-pressed')).toBe('true');
        expect(toggle?.getAttribute('aria-checked')).toBe('true');
        expect(new URLSearchParams(location.hash.slice(1)).get('theme')).toBe('light');
        expect(new URLSearchParams(location.hash.slice(1)).get('style')).toBe('sample');

        act(() => { toggle?.click(); });
        expect(document.documentElement.dataset.theme).toBe('light');
        expect(light?.getAttribute('aria-pressed')).toBe('true');
        expect(new URLSearchParams(location.hash.slice(1)).has('style')).toBe(false);
    });

    it.each([
        ['dark', 'Dark'],
        ['light', 'Light'],
    ] as const)('style in theme %s has a card with the selected mode and enabled style', (theme, label) => {
        const state = GALLERY_STATES.find((candidate) => candidate.id === `settings-menu-open-sample-${theme}`);
        expect(state).toBeDefined();
        const host = mount(state?.render());
        const themed = host.querySelector(`[data-theme="sample-${theme}"]`);
        expect(themed).not.toBeNull();
        const selected = [...(themed?.querySelectorAll('button[aria-pressed="true"]') ?? [])];
        expect(selected.some((button) => button.textContent === label)).toBe(true);
        const toggle = themed?.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Sample style"]');
        expect(toggle?.getAttribute('aria-checked')).toBe('true');
        act(() => { toggle?.click(); });
        expect(toggle?.getAttribute('aria-checked')).toBe('false');
        expect(themed?.getAttribute('data-theme')).toBe(theme);
    });

    it('light card keeps the base style when the stage style is enabled', () => {
        const host = mount(<Gallery initialId="settings-menu-open-light" initialStyle="sample" />);
        expect(document.documentElement.dataset.theme).toBe('sample-dark');
        const themed = host.querySelector('.gallery-themed');
        expect(themed?.getAttribute('data-theme')).toBe('light');
        expect(themed?.querySelector('[role="switch"][aria-label="Sample style"]')?.getAttribute('aria-checked')).toBe('false');
    });
});

function mount(node: React.ReactNode): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(node);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}
