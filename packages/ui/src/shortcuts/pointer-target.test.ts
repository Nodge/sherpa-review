// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { createPointerTarget } from './pointer-target.js';

/**
 * "Last signal" rule. Mouse movement targets the element under the pointer, and any focus
 * change returns the target to focus. jsdom has no `elementFromPoint`, so a custom document is supplied.
 */

interface Harness {
    readonly pointer: ReturnType<typeof createPointerTarget>;
    /** What `elementFromPoint` will return next. */
    under: Element | null;
    readonly move: (x: number, y: number) => void;
    readonly focus: () => void;
    readonly leave: () => void;
    readonly blurWindow: () => void;
    readonly points: { x: number; y: number }[];
    readonly listenerCount: () => number;
}

function harness(activeElement: Element | null = null): Harness {
    const listeners = new Map<string, Set<EventListener>>();
    const bind = (target: 'doc' | 'win') => ({
        addEventListener: (type: string, listener: EventListener) => {
            const key = `${target}:${type}`;
            const set = listeners.get(key) ?? new Set<EventListener>();
            set.add(listener);
            listeners.set(key, set);
        },
        removeEventListener: (type: string, listener: EventListener) => {
            listeners.get(`${target}:${type}`)?.delete(listener);
        },
    });
    const fire = (key: string, event: Event): void => {
        for (const listener of listeners.get(key) ?? []) {
            listener(event);
        }
    };
    const points: { x: number; y: number }[] = [];
    const state: { under: Element | null } = { under: null };
    const pointer = createPointerTarget(
        { ...bind('win') },
        {
            ...bind('doc'),
            activeElement,
            elementFromPoint: (x, y) => {
                points.push({ x, y });
                return state.under;
            },
        },
    );

    return {
        pointer,
        get under() {
            return state.under;
        },
        set under(element: Element | null) {
            state.under = element;
        },
        move: (x, y) => {
            fire('doc:pointermove', Object.assign(new Event('pointermove'), { clientX: x, clientY: y }));
        },
        focus: () => {
            fire('doc:focusin', new Event('focusin'));
        },
        leave: () => {
            fire('doc:pointerleave', new Event('pointerleave'));
        },
        blurWindow: () => {
            fire('win:blur', new Event('blur'));
        },
        points,
        listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    };
}

function row(): HTMLElement {
    const card = document.createElement('article');
    card.dataset.file = 'f1';
    const line = document.createElement('div');
    line.dataset.key = 'a7';
    card.append(line);
    return line;
}

describe('pointer monitor', () => {
    it('has no pointer target before the first mouse movement', () => {
        const h = harness();
        h.under = row();

        expect(h.pointer.hovered()).toBeNull();
        expect(h.points).toHaveLength(0);
    });

    it('gets the element from elementFromPoint at the last position on mouse movement', () => {
        const h = harness();
        const line = row();
        h.under = line;

        h.focus();
        h.move(40, 120);

        expect(h.pointer.hovered()).toBe(line);
        expect(h.points).toEqual([{ x: 40, y: 120 }]);
    });

    it('returns the target to focus when focus changes after mouse movement', () => {
        const h = harness();
        h.under = row();

        h.move(40, 120);
        h.focus();

        expect(h.pointer.hovered()).toBeNull();
    });

    it('reads the position at call time because content may have moved under a stationary pointer', () => {
        const h = harness();
        const first = row();
        const second = row();
        h.under = first;
        h.move(10, 10);
        expect(h.pointer.hovered()).toBe(first);

        h.under = second;
        expect(h.pointer.hovered()).toBe(second);
        expect(h.points).toEqual([
            { x: 10, y: 10 },
            { x: 10, y: 10 },
        ]);
    });

    it('forgets the position when the pointer leaves the window', () => {
        const h = harness();
        h.under = row();

        h.move(40, 120);
        h.leave();
        expect(h.pointer.hovered()).toBeNull();

        h.move(40, 120);
        h.blurWindow();
        expect(h.pointer.hovered()).toBeNull();
    });

    it('falls back to the active element for a selector target when the mouse is not the last signal', () => {
        const active = document.createElement('div');
        active.dataset.stop = 's03';
        const inside = document.createElement('button');
        active.append(inside);
        const h = harness(inside);

        expect(h.pointer.target('[data-stop]')).toBe(active);

        const hoveredStop = document.createElement('div');
        hoveredStop.dataset.stop = 's07';
        h.under = hoveredStop;
        h.move(1, 2);
        expect(h.pointer.target('[data-stop]')).toBe(hoveredStop);

        // There is no stop under the pointer. The target stays with focus instead of being lost entirely.
        h.under = document.createElement('div');
        expect(h.pointer.target('[data-stop]')).toBe(active);
    });

    it('preserves the position when the pointer leaves a nested element', () => {
        const line = row();
        const card = line.parentElement;
        if (card === null) {
            throw new Error('the row needs a card');
        }
        document.body.append(card);
        const pointer = createPointerTarget(window, {
            addEventListener: (type, listener, options) => {
                document.addEventListener(type, listener, options);
            },
            removeEventListener: (type, listener, options) => {
                document.removeEventListener(type, listener, options);
            },
            get activeElement() {
                return document.activeElement;
            },
            elementFromPoint: () => line,
        });
        document.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 8, clientY: 9 }));
        expect(pointer.hovered()).toBe(line);

        // Wheel scrolling makes the browser report leaving the node under a stationary pointer, not the window.
        line.dispatchEvent(new Event('pointerleave'));
        line.dispatchEvent(new Event('mouseleave'));
        expect(pointer.hovered()).toBe(line);

        document.dispatchEvent(new Event('pointerleave'));
        expect(pointer.hovered()).toBeNull();

        pointer.dispose();
        card.remove();
    });

    it('removing the pointer monitor unsubscribes all listeners', () => {
        const h = harness();
        expect(h.listenerCount()).toBe(5);

        h.pointer.dispose();
        expect(h.listenerCount()).toBe(0);
    });
});
