import { describe, expect, it } from 'vitest';

import {
    appendParagraph,
    BODY_PLACEHOLDER,
    parseReviewBody,
    removeParagraph,
    renderReviewBody,
    replaceParagraph,
} from './drafts.js';

describe('GitHub pending review body', () => {
    it('produces no paragraphs for an empty body', () => {
        expect(parseReviewBody('')).toEqual({ marked: false, paragraphs: [] });
        expect(parseReviewBody('\n\n   \n')).toEqual({ marked: false, paragraphs: [] });
    });

    it('produces no paragraphs for a placeholder-only body', () => {
        expect(parseReviewBody(BODY_PLACEHOLDER)).toEqual({ marked: false, paragraphs: [] });
        expect(parseReviewBody(`\n${BODY_PLACEHOLDER}\n`)).toEqual({ marked: false, paragraphs: [] });
    });

    it('preserves a placeholder-like line within reviewer text', () => {
        // Nobody writes the placeholder alongside paragraphs, so this line is reviewer text
        // (for example, a discussion of Sherpa markers) and must not be dropped.
        const text = `Sherpa marks an empty body with a line\n${BODY_PLACEHOLDER}\nand recognizes it by that line`;
        const body = `<!-- sherpa:draft 1 -->\n${text}`;

        expect(parseReviewBody(body)).toEqual({ marked: true, paragraphs: [{ n: 1, body: text }] });
        // Rewriting the body with a neighboring paragraph preserves the text.
        expect(parseReviewBody(appendParagraph(body, 'Second').body).paragraphs).toEqual([
            { n: 1, body: text },
            { n: 2, body: 'Second' },
        ]);
    });

    it('renders a body without paragraphs as a placeholder instead of an empty string', () => {
        expect(renderReviewBody([])).toBe(BODY_PLACEHOLDER);
        // The first paragraph replaces the placeholder, which is only needed for an empty body.
        expect(appendParagraph(BODY_PLACEHOLDER, 'First')).toEqual({
            body: '<!-- sherpa:draft 1 -->\nFirst',
            n: 1,
        });
    });

    it('parses a body without markers as paragraph 0', () => {
        expect(parseReviewBody('Written on the GitHub website.\n\nIn two paragraphs.')).toEqual({
            marked: false,
            paragraphs: [{ n: 0, body: 'Written on the GitHub website.\n\nIn two paragraphs.' }],
        });
    });

    it('splits the body at markers into numbered paragraphs', () => {
        const body = '<!-- sherpa:draft 1 -->\nFirst\n\n<!-- sherpa:draft 4 -->\nSecond\nwith a line break';

        expect(parseReviewBody(body)).toEqual({
            marked: true,
            paragraphs: [
                { n: 1, body: 'First' },
                { n: 4, body: 'Second\nwith a line break' },
            ],
        });
    });

    it('keeps text before the first marker as paragraph 0', () => {
        expect(parseReviewBody('Text from the website\n\n<!-- sherpa:draft 2 -->\nDraft')).toEqual({
            marked: true,
            paragraphs: [
                { n: 0, body: 'Text from the website' },
                { n: 2, body: 'Draft' },
            ],
        });
    });

    it('round-trips rendering and parsing', () => {
        const paragraphs = [
            { n: 1, body: 'One' },
            { n: 7, body: 'Two' },
        ];
        expect(parseReviewBody(renderReviewBody(paragraphs)).paragraphs).toEqual(paragraphs);
    });

    it('numbers a new paragraph as maximum + 1 instead of the next position', () => {
        const first = appendParagraph('', 'One');
        expect(first.n).toBe(1);

        const second = appendParagraph(first.body, 'Two');
        expect(second.n).toBe(2);

        // Removing the first keeps the second number unchanged, and the third still exceeds both.
        const afterRemoval = removeParagraph(second.body, 1) ?? '';
        expect(parseReviewBody(afterRemoval).paragraphs).toEqual([{ n: 2, body: 'Two' }]);
        expect(appendParagraph(afterRemoval, 'Three').n).toBe(3);
    });

    it('adds a marker to a body from the website on the first append', () => {
        const { body } = appendParagraph('Old text', 'Draft');

        expect(parseReviewBody(body)).toEqual({
            marked: true,
            paragraphs: [
                { n: 0, body: 'Old text' },
                { n: 1, body: 'Draft' },
            ],
        });
    });

    it('edits and deletes by number and returns null for an unknown number', () => {
        const body = renderReviewBody([
            { n: 1, body: 'One' },
            { n: 2, body: 'Two' },
        ]);

        expect(parseReviewBody(replaceParagraph(body, 2, 'Two and a half') ?? '').paragraphs).toEqual([
            { n: 1, body: 'One' },
            { n: 2, body: 'Two and a half' },
        ]);
        expect(replaceParagraph(body, 9, 'no such paragraph')).toBeNull();
        expect(removeParagraph(body, 9)).toBeNull();
        // Removing the last paragraph writes a placeholder. An empty body would break the review permanently.
        expect(removeParagraph(renderReviewBody([{ n: 1, body: 'One' }]), 1)).toBe(BODY_PLACEHOLDER);
    });
});
