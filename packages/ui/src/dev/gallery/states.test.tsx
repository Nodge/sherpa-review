import { describe, expect, it } from 'vitest';

import { GALLERY_STATES } from './states.tsx';

describe('gallery registry', () => {
    it('has no duplicate ids', () => {
        const seen = new Set<string>();
        const duplicates = new Set<string>();

        for (const state of GALLERY_STATES) {
            if (seen.has(state.id)) {
                duplicates.add(state.id);
            }
            seen.add(state.id);
        }

        expect([...duplicates], 'duplicate gallery state ids').toEqual([]);
    });
});
