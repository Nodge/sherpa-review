/**
 * Target for actions "under the cursor" (docs/design/SPEC-elements.md §5): the element under the mouse cursor if the user's last
 * input was mouse movement, otherwise the focused element. This rule lives here
 * in a single `target` function so each command does not have to decide it again.
 *
 * Store the position, not the element: between mouse movement and a keypress, the wheel can scroll content
 * under a stationary cursor, and a stored element would point to a line
 * that is no longer there.
 */

/** The document API the pointer monitor needs. jsdom lacks `elementFromPoint`, so the test supplies it. */
export interface PointerDocument {
    readonly elementFromPoint: (x: number, y: number) => Element | null;
    readonly activeElement: Element | null;
    readonly addEventListener: ListenerBinding;
    readonly removeEventListener: ListenerBinding;
}

/** The window API the pointer monitor needs. It only needs to know when the page loses focus. */
export interface PointerWindow {
    readonly addEventListener: ListenerBinding;
    readonly removeEventListener: ListenerBinding;
}

/** The subscription API the pointer monitor needs. Same shape as `EventTarget`, without the event type map. */
type ListenerBinding = (type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => void;

export interface PointerTarget {
    /** Element under the mouse. `null` means the mouse has not moved since focus changed or has left the window. */
    readonly hovered: () => Element | null;
    /** Target by the rule: under the mouse, otherwise focused. */
    readonly target: (selector: string) => Element | null;
    readonly dispose: () => void;
}

export function createPointerTarget(win: PointerWindow, doc: PointerDocument): PointerTarget {
    let position: { readonly x: number; readonly y: number } | null = null;
    // A flag for the last input is enough. There is no need to compare movement and focus timestamps.
    let lastSignal: 'pointer' | 'focus' = 'focus';

    const onPointerMove = (event: Event): void => {
        const { clientX, clientY } = event as PointerEvent;
        position = { x: clientX, y: clientY };
        lastSignal = 'pointer';
    };
    const onFocusIn = (): void => {
        lastSignal = 'focus';
    };
    const onLeave = (): void => {
        position = null;
    };

    doc.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    doc.addEventListener('focusin', onFocusIn, { capture: true });
    // Listen for the cursor leaving without `capture`: these events do not bubble, and during capture the document
    // would hear the mouse leaving any nested node, caused by wheel scrolling, a virtualizer reusing a row,
    // or an element under the cursor being removed. That would forget the position even though the mouse has not moved.
    doc.addEventListener('pointerleave', onLeave);
    doc.addEventListener('mouseleave', onLeave);
    win.addEventListener('blur', onLeave);

    const hovered = (): Element | null =>
        position === null || lastSignal !== 'pointer' ? null : doc.elementFromPoint(position.x, position.y);

    return {
        hovered,
        target: (selector) => hovered()?.closest(selector) ?? doc.activeElement?.closest(selector) ?? null,
        dispose: () => {
            doc.removeEventListener('pointermove', onPointerMove, { capture: true });
            doc.removeEventListener('focusin', onFocusIn, { capture: true });
            doc.removeEventListener('pointerleave', onLeave);
            doc.removeEventListener('mouseleave', onLeave);
            win.removeEventListener('blur', onLeave);
        },
    };
}

/**
 * Without a pointer monitor (gallery, component tests), the target always comes from focus, matching the behaviour before the
 * "under the cursor" rule.
 */
export const FOCUS_ONLY_TARGET: PointerTarget = {
    hovered: () => null,
    target: (selector) =>
        typeof document === 'undefined' ? null : (document.activeElement?.closest(selector) ?? null),
    dispose: () => undefined,
};
