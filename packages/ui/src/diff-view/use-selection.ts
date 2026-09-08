import { useEffect, useSyncExternalStore } from 'react';

import { useEscapeLayer } from '../shortcuts/context.tsx';
import type { DiffViewStore } from './store.js';

export function shouldClearSelectionOnPointerDown(target: EventTarget | null): boolean {
    return !(target instanceof Element) || target.closest('.diff-rows, .selection-popover') === null;
}

/**
 * Line selection lifecycle (docs/design/SPEC-elements.md §2.14): the card starts dragging, window events end it:
 * mouse release, Esc, and clicks outside diff lines.
 *
 * Both views need this hook: when it lived inside the full diff list, selection started on the route
 * had nothing to close it, and the action bar disappeared for good.
 */
export function useSelectionLifecycle(store: DiffViewStore): void {
    // Selection is the lowest Esc layer: the palette and popovers above it close first.
    const hasSelection =
        useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).selection !== null;
    useEscapeLayer('selection', store.clearSelection, hasSelection);

    useEffect(() => {
        const onPointerDown = (event: MouseEvent): void => {
            if (shouldClearSelectionOnPointerDown(event.target)) {
                store.clearSelection();
            }
        };
        const onPointerUp = (): void => {
            store.finishSelection();
        };
        window.addEventListener('mousedown', onPointerDown);
        window.addEventListener('mouseup', onPointerUp);
        return () => {
            window.removeEventListener('mousedown', onPointerDown);
            window.removeEventListener('mouseup', onPointerUp);
            store.finishSelection();
        };
    }, [store]);
}
