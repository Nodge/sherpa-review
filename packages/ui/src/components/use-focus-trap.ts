import type { RefObject } from 'react';
import { useEffect } from 'react';

/**
 * Modal dialog focus trap: Tab keeps focus within `ref`, and focus arriving
 * from outside returns to the first interactive element (or the last with ⇧Tab).
 *
 * Esc is not handled here. Closing uses the registry's Esc priority order (`useEscapeLayer`).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
    useEffect(() => {
        if (!active) {
            return;
        }
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.defaultPrevented || event.key !== 'Tab') {
                return;
            }
            const root = ref.current;
            const focusable = focusableElements(root);
            if (focusable.length === 0) {
                event.preventDefault();
                root?.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable.at(-1);
            const activeElement = document.activeElement;
            if (root?.contains(activeElement) !== true) {
                event.preventDefault();
                (event.shiftKey ? last : first)?.focus();
            } else if (event.shiftKey && activeElement === first) {
                event.preventDefault();
                last?.focus();
            } else if (!event.shiftKey && activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [ref, active]);
}

export function focusableElements(root: HTMLElement | null): HTMLElement[] {
    if (root === null) {
        return [];
    }
    const selector = [
        'button:not(:disabled)',
        '[href]',
        'input:not(:disabled)',
        'textarea:not(:disabled)',
        '[contenteditable="true"]',
        '[tabindex]:not([tabindex="-1"])',
    ].join(', ');
    return [...root.querySelectorAll<HTMLElement>(selector)].filter((element) => !element.hasAttribute('hidden'));
}
