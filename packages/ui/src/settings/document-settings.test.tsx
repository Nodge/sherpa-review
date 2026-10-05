// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsProvider } from './context.tsx';
import { DocumentSettingsSync, readDocumentAppearance } from './document-settings.tsx';
import type { UiSettingsStore } from './settings-store.js';
import { createUiSettingsStore, DEFAULT_UI_SETTINGS } from './settings-store.js';

describe('document attributes from settings', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        document.documentElement.removeAttribute('data-theme');
        document.documentElement.removeAttribute('data-textsize');
    });

    it('follows the system theme in auto without remounting', () => {
        const system = stubSystemTheme('dark');
        const unmount = mount(createUiSettingsStore({ loaded: true }));

        expect(themeAttribute()).toBe('dark');
        act(() => {
            system.switchTo('light');
        });
        expect(themeAttribute()).toBe('light');

        unmount();
        expect(themeAttribute()).toBeNull();
    });

    it('ignores the system theme when an explicit theme is selected', () => {
        const system = stubSystemTheme('dark');
        const unmount = mount(createUiSettingsStore({ loaded: true, initial: { theme: 'light' } }));

        expect(themeAttribute()).toBe('light');
        act(() => {
            system.switchTo('light');
        });
        expect(themeAttribute()).toBe('light');

        unmount();
    });

    it('uses a separate attribute for text size', () => {
        stubSystemTheme('dark');
        const settings = createUiSettingsStore({ loaded: true });
        const unmount = mount(settings);

        expect(document.documentElement.getAttribute('data-textsize')).toBe('m');
        act(() => {
            settings.update({ textSize: 'l' });
        });
        expect(document.documentElement.getAttribute('data-textsize')).toBe('l');

        unmount();
        expect(document.documentElement.getAttribute('data-textsize')).toBeNull();
    });

    
        const system = stubSystemTheme('light');
        
        const unmount = mount(settings);
        
        act(() => { system.switchTo('dark'); });
        
        act(() => { settings.update({ theme: 'light' }); });
        
        act(() => { system.switchTo('light'); });
        act(() => { system.switchTo('dark'); });
        
        
        expect(themeAttribute()).toBe('light');
        unmount();
    });

    it.each(['dark', 'light'] as const)('the first HTML sets %s appearance before GET', (theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        document.documentElement.setAttribute('data-textsize', 'l');
        expect(readDocumentAppearance(document.documentElement)).toEqual({ theme, textSize: 'l' });
    });

    
        document.documentElement.setAttribute('data-theme', 'light');
        stubSystemTheme('light');
        const settings = createUiSettingsStore({ initial: readDocumentAppearance(document.documentElement) });
        const unmount = mount(settings);
        
        
        
        
        
        unmount();
    });

    
        
        stubSystemTheme('light');
        const settings = createUiSettingsStore({ initial: readDocumentAppearance(document.documentElement) });
        const unmount = mount(settings);

        
        act(() => {
            
        });
        
        unmount();
    });

    it('preserves server attributes until the server responds', () => {
        // This is the document served with `theme: light`, `textSize: l`.
        document.documentElement.setAttribute('data-theme', 'light');
        document.documentElement.setAttribute('data-textsize', 'l');
        stubSystemTheme('dark');
        // Until the endpoint responds, the store takes its appearance from the initial HTML.
        const settings = createUiSettingsStore({ initial: readDocumentAppearance(document.documentElement) });
        const unmount = mount(settings);

        expect(themeAttribute()).toBe('light');
        expect(document.documentElement.getAttribute('data-textsize')).toBe('l');

        act(() => {
            settings.applyLoaded({ ...DEFAULT_UI_SETTINGS, theme: 'light', textSize: 'l' });
        });
        expect(themeAttribute()).toBe('light');
        expect(document.documentElement.getAttribute('data-textsize')).toBe('l');

        unmount();
    });

    it('repaints the document when the server responds with a different theme', () => {
        document.documentElement.setAttribute('data-theme', 'light');
        stubSystemTheme('dark');
        const settings = createUiSettingsStore({ initial: readDocumentAppearance(document.documentElement) });
        const unmount = mount(settings);

        act(() => {
            settings.applyLoaded({ ...DEFAULT_UI_SETTINGS, theme: 'dark' });
        });
        expect(themeAttribute()).toBe('dark');

        unmount();
    });
});

function themeAttribute(): string | null {
    return document.documentElement.getAttribute('data-theme');
}

function mount(store: UiSettingsStore): () => void {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <SettingsProvider store={store}>
                <DocumentSettingsSync />
            </SettingsProvider>,
        );
    });
    return () => {
        act(() => {
            root.unmount();
        });
        host.remove();
    };
}

/** jsdom does not evaluate media queries, so the system theme and its changes are set manually. */
function stubSystemTheme(initial: 'dark' | 'light') {
    const listeners = new Set<() => void>();
    let matches = initial === 'dark';
    vi.stubGlobal('matchMedia', (media: string) => ({
        media,
        get matches() {
            return matches;
        },
        addEventListener: (_event: string, listener: () => void) => {
            listeners.add(listener);
        },
        removeEventListener: (_event: string, listener: () => void) => {
            listeners.delete(listener);
        },
    }));
    return {
        switchTo: (next: 'dark' | 'light') => {
            matches = next === 'dark';
            for (const listener of [...listeners]) {
                listener();
            }
        },
    };
}
