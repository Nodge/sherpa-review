/**
 * Finds a diff line in the markup and highlights it after navigation. One implementation for 2
 * line jumps: from the command palette in the full diff and from a digest assertion anchor
 * on the route (README §2). `lineKey` prints the line key. This module only reads it.
 */

/** Class for highlighting a line after navigation. `diff-view.css` defines the animation. */
const ROW_FLASH = 'diff-row--palette-target';

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
    row.classList.remove(ROW_FLASH);
    // Restart the animation: without a forced reflow, revisiting the same line shows nothing.
    void row.offsetWidth;
    row.classList.add(ROW_FLASH);
    row.addEventListener(
        'animationend',
        () => {
            row.classList.remove(ROW_FLASH);
        },
        { once: true },
    );
}
