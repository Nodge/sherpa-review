import { describe, expect, it } from 'vitest';

import { updateFragment } from '../fragment.js';
import type { Viewing } from '../iterations/viewing.js';
import { VIEWING_CURRENT } from '../iterations/viewing.js';
import { sessionFragmentPatch } from './session-fragment.js';
import { createSessionStore } from './session-store.js';

/**
 * What iteration selection writes to the URL. A slice uses the `base`/`head` pair,
 * changing the selection removes previous anchors, and returning to the active iteration clears the URL.
 */

const SLICE: Viewing = { kind: 'slice', base: '182799', head: '182801' };

function fragmentAfter(steps: readonly Viewing[], initialHash: string): string {
    let hash = initialHash;
    let previous: Viewing = VIEWING_CURRENT;
    const session = createSessionStore({
        initial: { view: 'diff', filter: 'all' },
        persist: (state) => {
            hash = updateFragment(hash, sessionFragmentPatch(state, previous));
            previous = state.viewing;
        },
    });
    for (const viewing of steps) {
        session.setViewing(viewing);
    }
    return hash;
}

describe('iteration selection in the URL', () => {
    it('writes a slice as a base/head pair and removes anchors from the previous selection', () => {
        const hash = fragmentAfter([SLICE], '#t=token&view=diff&file=f1&line=12&thread=t1');
        const params = new URLSearchParams(hash.slice(1));

        expect(params.get('base')).toBe('182799');
        expect(params.get('head')).toBe('182801');
        expect(params.get('file')).toBeNull();
        expect(params.get('line')).toBeNull();
        expect(params.get('thread')).toBeNull();
        expect(params.get('diff')).toBeNull();
    });

    it('removes the slice from the URL when returning to the active iteration', () => {
        const hash = fragmentAfter([SLICE, VIEWING_CURRENT], '#t=token&view=diff');
        const params = new URLSearchParams(hash.slice(1));

        expect(params.get('base')).toBeNull();
        expect(params.get('head')).toBeNull();
        expect(params.get('t')).toBe('token');
    });

    it('keeps only the previous iteration when switching to it from a slice', () => {
        const hash = fragmentAfter([SLICE, { kind: 'diff', diffId: '182799' }], '#t=token&view=diff');
        const params = new URLSearchParams(hash.slice(1));

        expect(params.get('diff')).toBe('182799');
        expect(params.get('base')).toBeNull();
        expect(params.get('head')).toBeNull();
    });
});
