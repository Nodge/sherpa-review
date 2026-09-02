// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { GALLERY_STATES } from './states.tsx';
import { M4_T12_STATES } from './m4-t12-states.tsx';

/**
 * M4-T12 state registry. Full diff in the gallery is a live view with stores and virtualization,
 * so these tests check registration and that each frame mounts and identifies the slice.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {
        // jsdom has no layout.
    }
    unobserve(): void {
        // jsdom has no layout.
    }
    disconnect(): void {
        // jsdom has no layout.
    }
};

const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

function mount(id: string): HTMLElement {
    const state = M4_T12_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<>{state.render()}</>);
    });
    cleanups.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

describe('M4-T12 gallery', () => {
    it('registers exactly the ids defined by the task slice', () => {
        expect(M4_T12_STATES.map((state) => state.id)).toEqual([
            'iterations-slice',
            'iterations-slice-route',
            'iterations-slice-overview',
            'iterations-slice-empty',
            'iterations-slice-loading',
        ]);
    });

    it('states appear once each in the shared registry under Iterations', () => {
        for (const state of M4_T12_STATES) {
            const found = GALLERY_STATES.filter((candidate) => candidate.id === state.id);

            expect(found).toHaveLength(1);
            expect(found[0]?.group).toBe('Iterations');
        }
    });

    it('slice shows a pill with both sides and a read-only banner', () => {
        const host = mount('iterations-slice');

        expect(host.querySelector('.snapshot-pill')?.textContent).toContain('slice');
        expect(host.textContent).toContain('You are looking at the slice between iterations');
        expect(host.textContent).toContain('To the active iteration');
    });

    it('the route tab explains why a slice has no route', () => {
        const host = mount('iterations-slice-route');

        expect(host.textContent).toContain('it is «what’s new» without AI');
        expect(host.textContent).toContain('To the full diff');
    });

    it('the overview tab explains that cards use the active iteration', () => {
        const host = mount('iterations-slice-overview');

        expect(host.textContent).toContain('No overview for a slice');
        expect(host.textContent).toContain('To the full diff');
    });

    it('an empty slice says there are no changes between iterations and keeps the header', () => {
        const host = mount('iterations-slice-empty');

        expect(host.textContent).toContain('no changes');
        expect(host.querySelector('.snapshot-pill')?.textContent).toContain('slice');
    });

    it('slice loading shows 3 skeleton cards and a host notice', () => {
        const host = mount('iterations-slice-loading');

        // The PR header with its pill and the file panel space are present while loading. Incoming data
        // does not shift the layout, and the reviewer can see which slice is being calculated throughout.
        expect(host.querySelector('.pr-header')).not.toBeNull();
        expect(host.querySelector('.snapshot-pill')?.textContent).toContain('slice');
        expect(host.querySelector('.full-diff__panel-placeholder')).not.toBeNull();
        expect(host.querySelectorAll('.diff-skeleton-card')).toHaveLength(3);
        expect(host.textContent).toContain('it takes longer than usual');
    });
});
