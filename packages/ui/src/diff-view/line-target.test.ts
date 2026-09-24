// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { findAgentNote, findLineRow, flashAgentNote, flashRow, lineAt } from './line-target.js';

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


/** File card: unified rows carry the key on the row itself, split cells also carry their side. */
function fileCard(): HTMLElement {
    const element = document.createElement('article');
    element.dataset.file = 'checkout';
    element.innerHTML = `
        <div class="diff-row" data-key="a41" tabindex="0"><code class="diff-row__code">added</code></div>
        <div class="diff-row" data-key="d17" tabindex="0"><code class="diff-row__code">removed</code></div>
        <div class="diff-row" data-key="c40:39" tabindex="0"><code class="diff-row__code">context</code></div>
        <div class="diff-row diff-row--pair">
            <code class="diff-row__code" data-key="c40:39" data-side="old" id="split-old">context</code>
            <code class="diff-row__code" data-key="c40:39" data-side="new" id="split-new">context</code>
        </div>
    `;
    return element;
}

function at(card: HTMLElement, selector: string): ReturnType<typeof lineAt> {
    const element = card.querySelector(selector);
    if (element === null) {
        throw new Error(`card has no ${selector}`);
    }
    return lineAt(element);
}

describe('line under an element', () => {
    it('unified: `a` is new, `d` is old, `c` is new, matching the row itself', () => {
        const card = fileCard();

        expect(at(card, '[data-key="a41"] code')).toEqual({ fileId: 'checkout', side: 'new', line: 41 });
        expect(at(card, '[data-key="d17"] code')).toEqual({ fileId: 'checkout', side: 'old', line: 17 });
        expect(at(card, '.diff-row[data-key="c40:39"]')).toEqual({ fileId: 'checkout', side: 'new', line: 39 });
    });

    it('split: reads the side from the cell\'s `data-side`', () => {
        const card = fileCard();

        expect(at(card, '#split-old')).toEqual({ fileId: 'checkout', side: 'old', line: 40 });
        expect(at(card, '#split-new')).toEqual({ fileId: 'checkout', side: 'new', line: 39 });
    });

    it('returns null for an element outside a line or card', () => {
        const card = fileCard();
        const loose = document.createElement('div');
        loose.innerHTML = '<span data-key="a41"></span>';

        expect(lineAt(card)).toBeNull();
        expect(lineAt(null)).toBeNull();
        expect(lineAt(loose.querySelector('span'))).toBeNull();
    });

    it('returns null for an invalid line key attribute, without producing a NaN line number', () => {
        const card = fileCard();
        const alien = document.createElement('span');
        alien.dataset.key = 'gap:12';
        card.append(alien);

        expect(lineAt(alien)).toBeNull();
    });
});
