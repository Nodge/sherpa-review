// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHAT_DOCK_CLASS, CHAT_DOCK_MEDIA, chatOverlaysContent, useChatDock } from './dock.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    document.documentElement.classList.remove(CHAT_DOCK_CLASS);
});

function render(chatOpen: boolean): (next: boolean) => void {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const draw = (open: boolean): void => {
        act(() => {
            root.render(<Probe chatOpen={open} />);
        });
    };
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    draw(chatOpen);
    return draw;
}

function Probe({ chatOpen }: { chatOpen: boolean }) {
    useChatDock(chatOpen);
    return null;
}

describe('chat docking class', () => {
    it('stays on the document root while chat is open', () => {
        const draw = render(true);
        expect(document.documentElement.classList.contains(CHAT_DOCK_CLASS)).toBe(true);

        draw(false);
        expect(document.documentElement.classList.contains(CHAT_DOCK_CLASS)).toBe(false);
    });

    it('disappears when the app unmounts', () => {
        render(true);
        expect(document.documentElement.classList.contains(CHAT_DOCK_CLASS)).toBe(true);

        const unmount = mounted.pop();
        unmount?.();
        expect(document.documentElement.classList.contains(CHAT_DOCK_CLASS)).toBe(false);
    });
});

describe('chat overlay mode', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('overlays the content below the docking breakpoint', () => {
        stubDockMedia(false);
        expect(chatOverlaysContent(true)).toBe(true);
    });

    it('docks chat as a column above the docking breakpoint', () => {
        stubDockMedia(true);
        expect(chatOverlaysContent(true)).toBe(false);
    });

    it('does not overlay anything when chat is closed', () => {
        stubDockMedia(false);
        expect(chatOverlaysContent(false)).toBe(false);
    });

    it('queries the exact media query used in the panel CSS', () => {
        const matchMedia = stubDockMedia(true);
        chatOverlaysContent(true);
        expect(matchMedia).toHaveBeenCalledWith(CHAT_DOCK_MEDIA);
    });
});

/** jsdom does not evaluate `matchMedia`, so the docking breakpoint is set manually. */
function stubDockMedia(docked: boolean) {
    const matchMedia = vi.fn((query: string) => ({ matches: docked, media: query }));
    vi.stubGlobal('matchMedia', matchMedia);
    return matchMedia;
}
