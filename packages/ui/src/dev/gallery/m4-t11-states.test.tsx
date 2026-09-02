// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { GALLERY_STATES } from './states.tsx';
import { M4_T11_STATES } from './m4-t11-states.tsx';

/**
 * M4-T11 state registry. The frame is a live Full diff view beside the chat panel, so these
 * tests check registration, mounting and the banner and chip text. `notes/model.test.ts`
 * checks note placement within an iteration, and `iteration-banners.test.tsx` checks banner behaviour.
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
HTMLElement.prototype.scrollIntoView = function noopScrollIntoView(): void {
    // jsdom has no scrolling.
};

const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

function mount(id: string): HTMLElement {
    const state = M4_T11_STATES.find((candidate) => candidate.id === id);
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

describe('M4-T11 gallery', () => {
    it('registers exactly the ids defined by the milestone task breakdown', () => {
        expect(M4_T11_STATES.map((state) => state.id)).toEqual(['iterations-notes-lost']);
    });

    it('takes the T2 placeholder id in the shared registry without duplicating it', () => {
        const ids = GALLERY_STATES.filter((state) => state.id === 'iterations-notes-lost');

        expect(ids).toHaveLength(1);
        expect(ids[0]?.group).toBe('Iterations');
        expect(ids[0]?.title).not.toContain('placeholder');
    });

    it('the frame shows the banner, lost anchor chip and total note count', () => {
        const host = mount('iterations-notes-lost');

        expect(host.textContent).toContain('1 note lost its anchor after the new push');
        expect(host.textContent).toContain('anchor lost after the push · handlers.ts:48–54');
        // The chat header counter includes all notes, including the one with a lost anchor.
        expect(host.textContent).toContain('Notes 5');
    });
});
