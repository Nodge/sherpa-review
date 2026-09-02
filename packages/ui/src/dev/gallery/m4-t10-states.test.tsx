// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { GALLERY_STATES } from './states.tsx';
import { M4_T10_STATES } from './m4-t10-states.tsx';

/**
 * M4-T10 state registry. Full diff in the gallery is a live view with virtualization and stores,
 * so these tests only check registration and mounting. `threads/thread-list.test.tsx` checks the pin chip, action
 * and group of files no longer in the PR.
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
    const state = M4_T10_STATES.find((candidate) => candidate.id === id);
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

describe('M4-T10 gallery', () => {
    it('registers exactly the ids defined by the milestone task breakdown', () => {
        expect(M4_T10_STATES.map((state) => state.id)).toEqual([
            'iterations-thread-pinned',
            'iterations-thread-pinned-old',
        ]);
    });

    it('takes the T2 placeholder id in the shared registry without duplicating it', () => {
        const ids = GALLERY_STATES.filter((state) => state.id === 'iterations-thread-pinned');

        expect(ids).toHaveLength(1);
        expect(ids[0]?.group).toBe('Iterations');
        expect(ids[0]?.title).not.toContain('placeholder');
    });

    it('both states mount: active iteration and a previous iteration in read-only mode', () => {
        expect(mount('iterations-thread-pinned').textContent).toContain('Full diff');
        expect(mount('iterations-thread-pinned-old').textContent).toContain('Full diff');
    });
});
