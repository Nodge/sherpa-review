import { useEffect } from 'react';

import type { DiffViewStore } from './store.js';

export function shouldClearSelectionOnPointerDown(target: EventTarget | null): boolean {
    return !(target instanceof Element) || target.closest('.diff-rows, .selection-popover') === null;
}

/**
 * Line selection lifecycle (SPEC §2.14): the card starts the drag, while
 * mouse release, Esc, and clicks outside diff lines.
 *
 * Both views need this hook: when it lived inside the full diff list, selection started on the route
 * had nothing to close it, and the action bar disappeared for good.
 */
export function useSelectionLifecycle(store: DiffViewStore): void {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                store.clearSelection();
            }
        };
        const onPointerDown = (event: MouseEvent): void => {
            if (shouldClearSelectionOnPointerDown(event.target)) {
                store.clearSelection();
            }
        };
        const onPointerUp = (): void => {
            store.finishSelection();
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('mousedown', onPointerDown);
        window.addEventListener('mouseup', onPointerUp);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('mousedown', onPointerDown);
            window.removeEventListener('mouseup', onPointerUp);
            store.finishSelection();
        };
    }, [store]);
}
