/**
 * Finds and reveals a navigation target in the markup: diff line, agent note, composer.
 * One implementation handles line navigation from the command palette in the full diff and from an
 * assertion anchor in the route digest (docs/design/README.md §2). `lineKey` writes the line key. Here it is
 * only read.
 */

import { lineKeyNumbers, lineSide, parseLineKey } from './selection.js';

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
    return cell === null ? null : (cell.closest<HTMLElement>('.diff-row, .markdown-review__block') ?? cell);
}

/** Line address in the markup: the card's file and the number on its side. */
export interface LineAddress {
    readonly fileId: string;
    readonly side: 'old' | 'new';
    readonly line: number;
}

/**
 * Inverse of `findLineRow`: which line is rendered under this element. Used by commands
 * "under the cursor": the mouse gives an element, but the command needs an address. `null` means the element is outside a diff
 * line or a file card.
 *
 * In split mode, the cell's `data-side` gives the side. In unified mode it is absent, so the key determines the side
 * (`lineSide`), just as it does for selection and the row itself.
 */
export function lineAt(element: Element | null | undefined): LineAddress | null {
    const cell = element?.closest<HTMLElement>('[data-key]') ?? null;
    const fileId = cell?.closest<HTMLElement>('[data-file]')?.dataset.file;
    const key = parseLineKey(cell?.dataset.key);
    if (key === null || fileId === undefined) {
        return null;
    }
    const numbers = lineKeyNumbers(key);
    if (numbers === null) {
        return null;
    }
    const dataSide = cell?.dataset.side;
    const side = dataSide === 'old' || dataSide === 'new' ? dataSide : lineSide(key);
    const line = side === 'old' ? numbers.old : numbers.new;
    return line === null ? null : { fileId, side, line };
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

/** Composer by its opening key. `null` means its card is absent from the markup. */
export function findComposer(root: ParentNode, key: string): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[data-composer-key="${CSS.escape(key)}"]`);
}

/** Focuses the composer field: textarea in Markdown mode, ProseMirror in visual mode. */
export function focusComposerInput(composer: HTMLElement): void {
    composer.querySelector<HTMLElement>('textarea, [contenteditable="true"]')?.focus({ preventScroll: true });
}

/**
 * Reveals the target as soon as it appears in the markup: tries on the next frame, then on every
 * document mutation while the node is absent, up to the timeout. `reveal` returns `false`
 * while there is nothing to reveal. Returns a function to cancel the wait (for effect cleanup).
 */
export function revealWhenReady(reveal: () => boolean, timeoutMs: number): () => void {
    let observer: MutationObserver | null = null;
    let frame: number | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const stop = (): void => {
        observer?.disconnect();
        observer = null;
        if (frame !== null) {
            cancelAnimationFrame(frame);
            frame = null;
        }
        if (timeout !== null) {
            clearTimeout(timeout);
            timeout = null;
        }
    };
    const attempt = (): boolean => {
        if (!reveal()) {
            return false;
        }
        stop();
        return true;
    };

    frame = requestAnimationFrame(() => {
        frame = null;
        if (attempt()) {
            return;
        }
        observer = new MutationObserver(() => {
            attempt();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        timeout = setTimeout(stop, timeoutMs);
    });
    return stop;
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
