import { describe, expect, it } from 'vitest';

import { parsePaletteQuery } from './query.js';

describe('parsePaletteQuery', () => {
    it('keeps plain text as a fuzzy query', () => {
        expect(parsePaletteQuery(' handlers ')).toEqual({ kind: 'browse', text: 'handlers' });
    });

    it('@ enables chat history search', () => {
        expect(parsePaletteQuery('@ window ')).toEqual({ kind: 'chat', text: 'window' });
        expect(parsePaletteQuery('@')).toEqual({ kind: 'chat', text: '' });
    });

    it('/ enables diff content search', () => {
        expect(parsePaletteQuery('/ orderId ')).toEqual({ kind: 'diff', text: 'orderId' });
        expect(parsePaletteQuery('/')).toEqual({ kind: 'diff', text: '' });
    });

    it(': accepts only positive integer line numbers', () => {
        expect(parsePaletteQuery(': 42')).toEqual({ kind: 'line', line: 42 });
        expect(parsePaletteQuery(':0')).toEqual({ kind: 'line', line: null });
        expect(parsePaletteQuery(':abc')).toEqual({ kind: 'line', line: null });
    });
});
