// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { Gallery, parseGalleryTheme } from './gallery.tsx';
import { GALLERY_STATES } from './states.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];
afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    history.replaceState(null, '', '/');
});

describe('gallery theme', () => {
    it('the URL distinguishes the three theme modes', () => {
        for (const theme of ['auto', 'dark', 'light'] as const) {
            expect(parseGalleryTheme(theme)).toBe(theme);
        }
        expect(parseGalleryTheme(null)).toBe('dark');
        expect(parseGalleryTheme('unknown')).toBe('dark');
        
        
        
        
    });

    
        const host = mount(<Gallery initialId="settings-menu-open" />);
        const toggle = host.querySelector<HTMLButtonElement>('.gallery__stage-title [role="switch"]');
        const themes = host.querySelectorAll<HTMLButtonElement>('.gallery__themes[role="group"] button');
        expect(toggle).not.toBeNull();
        expect(themes).toHaveLength(3);
        act(() => {
            toggle?.click();
        });

        
        expect(toggle?.getAttribute('aria-checked')).toBe('true');
        expect(new URLSearchParams(location.hash.slice(1)).get('theme')).toBe('dark');
        

        const light = [...themes].find((button) => button.textContent === 'light');
        act(() => { light?.click(); });
        
        expect(light?.getAttribute('aria-pressed')).toBe('true');
        expect(toggle?.getAttribute('aria-checked')).toBe('true');
        expect(new URLSearchParams(location.hash.slice(1)).get('theme')).toBe('light');
        

        act(() => { toggle?.click(); });
        expect(document.documentElement.dataset.theme).toBe('light');
        expect(light?.getAttribute('aria-pressed')).toBe('true');
        
    });

    it.each([
        ['dark', 'Dark'],
        ['light', 'Light'],
    
        
        expect(state).toBeDefined();
        const host = mount(state?.render());
        
        expect(themed).not.toBeNull();
        const selected = [...(themed?.querySelectorAll('button[aria-pressed="true"]') ?? [])];
        expect(selected.some((button) => button.textContent === label)).toBe(true);
        
        expect(toggle?.getAttribute('aria-checked')).toBe('true');
        act(() => { toggle?.click(); });
        expect(toggle?.getAttribute('aria-checked')).toBe('false');
        expect(themed?.getAttribute('data-theme')).toBe(theme);
    });

    
        
        
        const themed = host.querySelector('.gallery-themed');
        expect(themed?.getAttribute('data-theme')).toBe('light');
        
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
