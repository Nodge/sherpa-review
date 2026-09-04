// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { PALETTE_STATES } from './palette-states.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom cannot scroll, and the palette scrolls the list itself to the cursor.
HTMLElement.prototype.scrollIntoView = function noopScrollIntoView(): void {
    return undefined;
};

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function render(id: string): HTMLElement {
    const state = PALETTE_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<>{state.render()}</>);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

function rows(host: HTMLElement): string[] {
    return [...host.querySelectorAll('.command-palette__item')].map((item) => item.textContent);
}

describe('command palette gallery', () => {
    it('registers exactly the ids defined by the task slice', () => {
        expect(PALETTE_STATES.map((state) => state.id)).toEqual([
            'palette-fuzzy',
            'palette-empty',
            'palette-no-results',
            'palette-diff-search',
            'palette-chat-recent',
            'palette-chat-query',
            'palette-chat-anchors',
        ]);
    });

    it('an empty @ shows the last 8 exchanges, newest first', () => {
        const host = render('palette-chat-recent');
        const items = rows(host);

        expect(items).toHaveLength(8);
        expect(host.querySelector('.command-palette__group-label')?.textContent).toBe('Chat history');
        expect(items[0]).toContain('Why does the policy need a separate');
        expect(items.join('\n')).toContain('still answering');
        expect(items.join('\n')).toContain('no answer');
        expect(items.join('\n')).toContain('cancelled');
        // The ninth and tenth most recent exchanges are excluded from the results.
        expect(host.textContent).not.toContain('Why does a closed window return 409');
        expect(host.textContent).not.toContain('Break down the change in this PR');
    });

    it('@ with text searches both the question and the answer', () => {
        const items = rows(render('palette-chat-query'));

        expect(items).toEqual([
            // Match in the question.
            expect.stringContaining('How is the closure reason chosen between dispatch and the deadline?'),
            // Match only in the answer.
            expect.stringContaining('Break down the mechanics and risks of this PR.'),
            expect.stringContaining('Why does a closed window return 409 instead of 400?'),
        ]);
    });

    it('anchor labels: whole PR, another iteration, note with a lost anchor', () => {
        const items = rows(render('palette-chat-anchors'));

        expect(items).toEqual([
            expect.stringContaining('edit-window.ts:24–32'),
            expect.stringContaining('question about the whole PR'),
            expect.stringContaining('handlers.ts:48–54'),
        ]);
        expect(items[0]).not.toContain('anchor is not in this iteration');
        expect(items[2]).toContain('anchor is not in this iteration');
        expect(items[2]).toContain('the note lost its anchor');
    });
});
