// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { findAgentNote, findLineRow, flashAgentNote, flashRow } from './line-target.js';

/**
 * Finding a line in the card markup. The side matters: line 41 on the new side and line 41
 * on the old side are different lines, and both can occur in one hunk.
 */

/** Card with the same line number on both sides: deleted 41 and added 41. */
function card(): HTMLElement {
    const element = document.createElement('div');
    element.innerHTML = `
        <div class="diff-row" id="ctx"><span data-key="c40:39">context</span></div>
        <div class="diff-row" id="del"><span data-key="d41">removed</span></div>
        <div class="diff-row" id="add"><span data-key="a41">added</span></div>
        <div class="diff-row" id="both"><span data-key="c41:43">context both sides</span></div>
    `;
    return element;
}

describe('diff line by number and side', () => {
    it('finds the added line on the new side and the deleted line on the old side despite the same number', () => {
        expect(findLineRow(card(), 'new', 41)?.id).toBe('add');
        expect(findLineRow(card(), 'old', 41)?.id).toBe('del');
    });

    it('falls back to an unchanged line with that number on the requested side when no changed line exists', () => {
        // 43 is the new side of context `c41:43`, 40 is the old side of `c40:39`.
        expect(findLineRow(card(), 'new', 43)?.id).toBe('both');
        expect(findLineRow(card(), 'old', 40)?.id).toBe('ctx');
        // The same context on the other side does not match: the card has no old-side line 43.
        expect(findLineRow(card(), 'old', 43)).toBeNull();
        expect(findLineRow(card(), 'new', 40)).toBeNull();
    });

    it('returns null when the line is absent, without picking another line', () => {
        expect(findLineRow(card(), 'new', 999)).toBeNull();
    });
});

describe('line flash', () => {
    it('adds the highlight class and removes it when the animation ends', () => {
        const row = card().querySelector<HTMLElement>('#add');
        if (row === null) {
            throw new Error('the card must contain an added line');
        }

        flashRow(row);
        expect(row.classList.contains('diff-row--palette-target')).toBe(true);

        row.dispatchEvent(new Event('animationend'));
        expect(row.classList.contains('diff-row--palette-target')).toBe(false);
    });
});

describe('note focus', () => {
    it('finds the note by id, focuses it, and removes highlighting when the animation ends', () => {
        const root = document.createElement('div');
        root.innerHTML = '<article data-note="31" tabindex="-1"></article>';
        document.body.append(root);
        const note = findAgentNote(root, 31);
        if (note === null) {
            throw new Error('the note must be found by data-note');
        }

        flashAgentNote(note);
        expect(document.activeElement).toBe(note);
        expect(note.classList.contains('agent-note--target')).toBe(true);

        note.dispatchEvent(new Event('animationend'));
        expect(note.classList.contains('agent-note--target')).toBe(false);
        root.remove();
    });
});
