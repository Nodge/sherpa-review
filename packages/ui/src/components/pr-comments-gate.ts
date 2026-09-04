import { useCallback, useRef, useState } from 'react';

/**
 * The "PR comments" modal opens from two places, the action bar and the Discussion card
 * in Overview (SPEC additions §1e item 5). State lives above both, and focus return depends
 * on the opener. The callback arrives when opening and runs on closing.
 */
export interface PrCommentsGate {
    readonly open: boolean;
    readonly openModal: (returnFocus?: () => void) => void;
    readonly close: () => void;
}

export function usePrCommentsGate(): PrCommentsGate {
    const [open, setOpen] = useState(false);
    const returnFocus = useRef<(() => void) | null>(null);
    const openModal = useCallback((focus?: () => void) => {
        returnFocus.current = focus ?? null;
        setOpen(true);
    }, []);
    const close = useCallback(() => {
        setOpen(false);
        const focus = returnFocus.current;
        returnFocus.current = null;
        // Restore focus after removing the modal from the DOM, otherwise the focus trap intercepts it.
        queueMicrotask(() => {
            focus?.();
        });
    }, []);
    return { open, openModal, close };
}
