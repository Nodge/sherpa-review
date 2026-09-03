import { describe, expect, it } from 'vitest';

import type { QuestionRange } from './chat-prompts.js';
import { MAX_LISTED_RANGES, placeRangeQuestion, placeRangesQuestion } from './chat-prompts.js';
import { createT } from '../i18n/index.js';

const t = createT('en');

function range(patch: Partial<QuestionRange> = {}): QuestionRange {
    return { path: 'src/cache.ts', side: 'new', start: 18, end: 26, ...patch };
}

describe('the "place the ranges" question from "Other"', () => {
    it('lists one range and asks to explain each one', () => {
        expect(placeRangesQuestion([range()], t)).toBe(
            'Place the ranges the model left unplaced into the route stops: src/cache.ts:18–26. ' +
                'For each one — which stop it belongs to and why, or that it is a separate topic.',
        );
    });

    it('uses one number for a single line', () => {
        expect(placeRangesQuestion([range({ start: 18, end: 18 })], t)).toContain('src/cache.ts:18.');
    });

    it('labels the old side because line numbers differ between sides', () => {
        expect(placeRangesQuestion([range({ side: 'old', start: 4, end: 9 })], t)).toContain(
            'src/cache.ts:4–9 (removed)',
        );
    });

    it('preserves range order', () => {
        const question = placeRangesQuestion([
            range({ path: 'a.ts', start: 1, end: 2 }),
            range({ path: 'b.ts', start: 3, end: 4 }),
        ], t);

        expect(question).toContain('a.ts:1–2, b.ts:3–4.');
    });

    it('limits the list to 20 ranges and counts the remainder accurately', () => {
        const many = Array.from({ length: 23 }, (_, index) =>
            range({ path: `f${String(index)}.ts`, start: index + 1, end: index + 1 }),
        );

        const question = placeRangesQuestion(many, t);

        expect(question).toContain(`f${String(MAX_LISTED_RANGES - 1)}.ts:${String(MAX_LISTED_RANGES)} and 3 more.`);
        expect(question).not.toContain('f20.ts');
    });

    it('still forms a meaningful question without ranges', () => {
        expect(placeRangesQuestion([], t)).toBe(
            'Place the ranges the model left unplaced into the route stops. ' +
                'For each one — which stop it belongs to and why, or that it is a separate topic.',
        );
    });
});

describe('question about a hatch band range', () => {
    it('names a line range on the new side', () => {
        expect(placeRangeQuestion(range(), t)).toBe(
            'Which route stop do lines 18–26 in src/cache.ts belong to? The model did not place them.',
        );
    });

    it('calls old-side lines deleted lines', () => {
        expect(placeRangeQuestion(range({ side: 'old' }), t)).toBe(
            'Which route stop do removed lines 18–26 in src/cache.ts belong to? The model did not place them.',
        );
    });

    it('uses singular wording for a single line', () => {
        expect(placeRangeQuestion(range({ start: 18, end: 18 }), t)).toBe(
            'Which route stop does line 18 in src/cache.ts belong to? The model did not place it.',
        );
        expect(placeRangeQuestion(range({ side: 'old', start: 4, end: 4 }), t)).toBe(
            'Which route stop does removed line 4 in src/cache.ts belong to? The model did not place it.',
        );
    });
});
