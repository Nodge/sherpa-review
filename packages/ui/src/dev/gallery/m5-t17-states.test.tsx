// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { M5_T17_STATES } from './m5-t17-states.tsx';

/**
 * File menu frames render without a server or clicks. Rendering uses jsdom rather than static
 * markup: the menu uses a portal in `body`, which server rendering does not provide.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-virtual', () => ({
    defaultRangeExtractor: () => [],
    useVirtualizer: ({ count }: { count: number }) => ({
        getTotalSize: () => count * 26,
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                key: index,
                start: index * 26,
                size: 26,
                end: (index + 1) * 26,
                lane: 0,
            })),
        scrollToIndex: () => undefined,
    }),
}));

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function render(id: string): HTMLElement {
    const state = M5_T17_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(state.render());
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

function items(): HTMLButtonElement[] {
    return [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

describe('M5-T17 gallery', () => {
    it('registers 3 menu frames', () => {
        expect(M5_T17_STATES.map((state) => state.id)).toEqual([
            'file-menu-card',
            'file-menu-tree',
            'file-menu-read-only',
        ]);
    });

    it('card frame: menu open, all items available, file viewed', () => {
        const host = render('file-menu-card');

        expect(host.querySelector('.file-card')).not.toBeNull();
        expect(items().map((item) => item.textContent)).toEqual([
            'Copy path',
            'Copy file link',
            'Open on the web',
            'Clear the mark',
        ]);
        expect(items().filter((item) => item.getAttribute('aria-disabled') === 'true')).toEqual([]);
    });

    it('tree frame: both host links disabled, viewed mark available', () => {
        render('file-menu-tree');

        expect(items().map((item) => item.getAttribute('aria-disabled'))).toEqual([null, 'true', 'true', null]);
    });

    it('previous iteration frame: only the viewed mark is disabled', () => {
        render('file-menu-read-only');

        expect(items().map((item) => item.getAttribute('aria-disabled'))).toEqual([null, null, null, 'true']);
        expect(items()[3]?.title).toBe('only in the active iteration');
    });
});
