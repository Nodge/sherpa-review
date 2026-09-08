// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { GALLERY_STATES } from './states.tsx';
import { ITERATION_PINNED_THREAD_STATES } from './iterations-pinned-threads-states.tsx';

/**
 * Registry of pinned thread states. Full diff in the gallery uses the live view with virtualization and stores,
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
    const state = ITERATION_PINNED_THREAD_STATES.find((candidate) => candidate.id === id);
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

describe('pinned threads gallery', () => {
    it('registers exactly the ids declared in the file', () => {
        expect(ITERATION_PINNED_THREAD_STATES.map((state) => state.id)).toEqual([
            'iterations-thread-pinned',
            'iterations-thread-pinned-old',
        ]);
    });

    it('appears exactly once in the shared registry, in the Iterations group', () => {
        const ids = GALLERY_STATES.filter((state) => state.id === 'iterations-thread-pinned');

        expect(ids).toHaveLength(1);
        expect(ids[0]?.group).toBe('Iterations');
    });

    it('both states mount: active iteration and a previous iteration in read-only mode', () => {
        expect(mount('iterations-thread-pinned').textContent).toContain('Full diff');
        expect(mount('iterations-thread-pinned-old').textContent).toContain('Full diff');
    });
});
