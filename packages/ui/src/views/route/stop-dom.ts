import type { StopBox } from './scroll.js';
import { cssEscape } from './scroll.js';

/**
 * What the route reads from its own markup: section and file card geometry. The set is
 * always current because rendered content already reflects the lens, folds and lazy rendering.
 */

/** Stop sections in markup order. Lazy measurement stops at the first visible section when selecting an anchor. */
export function* stopBoxes(container: HTMLElement): Generator<StopBox> {
    for (const section of container.querySelectorAll<HTMLElement>('[data-stop]')) {
        const stopId = section.dataset.stop;
        if (stopId !== undefined) {
            const rect = section.getBoundingClientRect();
            yield { stopId, top: rect.top, bottom: rect.bottom };
        }
    }
}

/**
 * Top file card on screen and its stop. Readable content starts below
 * the sticky toolbar, so a card entirely beneath it cannot be the top card.
 */
export function topFileCard(container: HTMLElement): { readonly stopId: string; readonly fileId: string } | null {
    const top = container.getBoundingClientRect().top;
    const toolbar = container.querySelector<HTMLElement>('.route-toolbar');
    const line = toolbar === null ? top : Math.max(top, toolbar.getBoundingClientRect().bottom);
    for (const card of container.querySelectorAll<HTMLElement>('.file-card[data-file]')) {
        if (card.getBoundingClientRect().bottom <= line) {
            continue;
        }
        const stopId = card.closest<HTMLElement>('[data-stop]')?.dataset.stop;
        const fileId = card.dataset.file;
        return stopId === undefined || fileId === undefined ? null : { stopId, fileId };
    }
    return null;
}

/**
 * Next card in the same stop: nearest expanded card below, or simply the next card if all below are collapsed
 * (same rule as `nextFileToAdvance` in the full diff). The card set
 * comes from the markup, which already reflects the lens. A placeholder body identifies collapsed cards.
 */
export function nextCardInStop(container: HTMLElement, stopId: string, fileId: string): string | null {
    const section = container.querySelector<HTMLElement>(`[data-stop="${cssEscape(stopId)}"]`);
    if (section === null) {
        return null;
    }
    const cards = [...section.querySelectorAll<HTMLElement>('.file-card[data-file]')];
    const index = cards.findIndex((card) => card.dataset.file === fileId);
    if (index < 0) {
        return null;
    }
    const rest = cards.slice(index + 1);
    const next = rest.find((card) => card.querySelector('.file-card__collapsed--file') === null) ?? rest[0];
    return next?.dataset.file ?? null;
}
