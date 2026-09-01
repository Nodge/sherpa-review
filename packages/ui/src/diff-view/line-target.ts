/**
 * Finds a diff line in the markup and highlights it after navigation. One implementation for 2
 * line jumps: from the command palette in the full diff and from a digest assertion anchor
 * on the route (README §2). `lineKey` prints the line key. This module only reads it.
 */

/** Highlight classes after navigation. Line and note styles define the animations. */
const ROW_FLASH = 'diff-row--palette-target';
const NOTE_FLASH = 'agent-note--target';

/**
 * Card line by its side's number: changed (`a{n}` / `d{n}`), otherwise unchanged,
 * with that number on the requested side (`c{old}:{new}`). The side is required: line 41
 * on the new side and line 41 on the old side are different lines. Without the side, navigation to a deleted line
 * would land on the added line. `null` means the line is absent from this card.
 */
export function findLineRow(card: ParentNode, side: 'old' | 'new', line: number): HTMLElement | null {
    const number = String(line);
    const exact = side === 'new' ? `[data-key="a${number}"]` : `[data-key="d${number}"]`;
    const context = side === 'new' ? `[data-key^="c"][data-key$=":${number}"]` : `[data-key^="c${number}:"]`;
    const cell = card.querySelector<HTMLElement>(exact) ?? card.querySelector<HTMLElement>(context);
    return cell === null ? null : (cell.closest<HTMLElement>('.diff-row') ?? cell);
}

/** Line flash: removes the class when the animation ends so another visit restarts it. */
export function flashRow(row: HTMLElement): void {
    flash(row, ROW_FLASH);
}

export function findAgentNote(root: ParentNode, noteId: number | string): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[data-note="${String(noteId)}"]`);
}

/** Highlights an expanded note after navigation from chat. */
export function flashAgentNote(note: HTMLElement): void {
    flash(note, NOTE_FLASH);
    note.focus({ preventScroll: true });
}

function flash(element: HTMLElement, className: string): void {
    element.classList.remove(className);
    // Restart the animation: without a forced reflow, another visit to the same target does nothing.
    void element.offsetWidth;
    element.classList.add(className);
    element.addEventListener(
        'animationend',
        () => {
            element.classList.remove(className);
        },
        { once: true },
    );
}
