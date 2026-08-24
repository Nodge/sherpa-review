import { describe, expect, it } from 'vitest';

import { fuzzyMatch } from './fuzzy.js';

describe('fuzzyMatch', () => {
    it('matches a case-insensitive ordered subsequence', () => {
        expect(fuzzyMatch('market/Handlers.ts', 'hdt')).toBe(true);
        expect(fuzzyMatch('market/Handlers.ts', 'HDR')).toBe(true);
    });

    it('rejects reordered or missing characters', () => {
        expect(fuzzyMatch('handlers.ts', 'hred')).toBe(false);
        expect(fuzzyMatch('handlers.ts', 'handlerz')).toBe(false);
    });

    it('matches any text with an empty query', () => {
        expect(fuzzyMatch('a.ts', '   ')).toBe(true);
    });
});
