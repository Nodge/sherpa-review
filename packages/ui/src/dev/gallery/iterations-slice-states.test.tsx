// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { GALLERY_STATES } from './states.tsx';
import { ITERATION_SLICE_STATES } from './iterations-slice-states.tsx';

/**
 * Registry of inter-iteration slice states. Full diff in the gallery uses the live view with stores and virtualization,
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
    const state = ITERATION_SLICE_STATES.find((candidate) => candidate.id === id);
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

describe('inter-iteration slice gallery', () => {
    it('registers exactly the ids defined by the task slice', () => {
        expect(ITERATION_SLICE_STATES.map((state) => state.id)).toEqual([
            'iterations-slice',
            'iterations-slice-picker',
            'iterations-slice-route',
            'iterations-slice-overview',
            'iterations-slice-empty',
            'iterations-slice-loading',
        ]);
    });

    it('states appear once each in the shared registry under Iterations', () => {
        for (const state of ITERATION_SLICE_STATES) {
            const found = GALLERY_STATES.filter((candidate) => candidate.id === state.id);

            expect(found).toHaveLength(1);
            expect(found[0]?.group).toBe('Iterations');
        }
    });

    it('the slice shows an indicator with both sides and a read-only banner', () => {
        const host = mount('iterations-slice');

        expect(host.querySelector('.snapshot-pill')?.textContent).toContain('slice');
        expect(host.textContent).toContain('You are looking at the slice between iterations');
        expect(host.textContent).toContain('To the active iteration');
    });

    it('the slice menu marks both endpoints, leaves the intermediate iteration unmarked and shows a Shift+click hint', () => {
        const host = mount('iterations-slice-picker');

        expect([...host.querySelectorAll('.snapshot-picker__section')].map((node) => node.textContent)).toEqual([
            'Snapshots and iterations',
        ]);
        const rows = [...host.querySelectorAll('.snapshot-picker__row')];
        expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['true', 'false', 'true']);
        expect(host.querySelector('.snapshot-picker__hint')?.textContent).toBe('⇧ + click — changes between iterations');
    });

    it('the route tab explains why a slice has no route', () => {
        const host = mount('iterations-slice-route');

        expect(host.textContent).toContain('it is “what’s new” without AI');
        expect(host.textContent).toContain('To the full diff');
    });

    it('the overview tab explains that cards use the active iteration', () => {
        const host = mount('iterations-slice-overview');

        expect(host.textContent).toContain('No overview for a slice');
        expect(host.textContent).toContain('To the full diff');
    });

    it('an empty slice says there are no changes between iterations and keeps the header', () => {
        const host = mount('iterations-slice-empty');

        expect(host.textContent).toContain('No changes between iterations');
        expect(host.querySelector('.snapshot-pill')?.textContent).toContain('slice');
    });

    it('slice loading shows 3 skeleton cards and a host notice', () => {
        const host = mount('iterations-slice-loading');

        // The PR header with its indicator and the file panel space are present while waiting. Data arrival
        // does not shift the layout, and the reviewer can see which slice is being calculated throughout.
        expect(host.querySelector('.pr-header')).not.toBeNull();
        expect(host.querySelector('.snapshot-pill')?.textContent).toContain('slice');
        expect(host.querySelector('.full-diff__panel-placeholder')).not.toBeNull();
        expect(host.querySelectorAll('.diff-skeleton-card')).toHaveLength(3);
        expect(host.textContent).toContain('it takes longer than usual');
    });
});
