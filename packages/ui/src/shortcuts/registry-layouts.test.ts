import { describe, expect, it, vi } from 'vitest';

import type { Shortcut, ShortcutEvent } from './registry.js';
import { createShortcutRegistry } from './registry.js';

/**
 * Keyboard layouts: find the command by the typed character, and when it is not a Latin letter or digit,
 * also by the physical key. Basic behaviour is in `registry.test.ts`.
 */

function keydown(key: string, code: string, extra: Partial<ShortcutEvent> = {}): ShortcutEvent {
    return {
        key,
        code,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        target: { tagName: 'BODY' },
        preventDefault: vi.fn(),
        ...extra,
    };
}

function shortcut(overrides: Partial<Shortcut> & Pick<Shortcut, 'id' | 'keys' | 'action'>): Shortcut {
    // The label is a dictionary key. The registry only cares about its type.
    return { label: 'shortcut.palette.open', scope: 'global', section: 'navigation', ...overrides };
}

describe('Russian layout', () => {
    it('a Cyrillic letter runs the command for its physical key', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'diff.markViewed', keys: ['v'], action }));

        const event = keydown('\u043c', 'KeyV');
        expect(registry.handle(event)).toBe(true);
        expect(action).toHaveBeenCalledOnce();
        expect(event.preventDefault).toHaveBeenCalledOnce();
    });

    it('a mod shortcut works by physical key', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'palette.open', keys: ['mod+k'], action }));

        expect(registry.handle(keydown('\u043b', 'KeyK', { metaKey: true }))).toBe(true);
        expect(action).toHaveBeenCalledOnce();
    });

    it('the `g o` chord can be typed in Cyrillic', () => {
        // The second-key timeout does not expire: the test completes the chord itself.
        const registry = createShortcutRegistry({ setTimer: () => 1, clearTimer: () => undefined });
        const action = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['g o'], action }));

        expect(registry.handle(keydown('\u043f', 'KeyG'))).toBe(true);
        expect(action).not.toHaveBeenCalled();

        expect(registry.handle(keydown('\u0449', 'KeyO'))).toBe(true);
        expect(action).toHaveBeenCalledOnce();
    });

    it('a digit stays a digit', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'view.route', keys: ['1'], action }));

        expect(registry.handle(keydown('1', 'Digit1'))).toBe(true);
        expect(action).toHaveBeenCalledOnce();
    });

    it('modifiers stay strict: ctrl+Cyrillic does not match a single key', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'diff.markViewed', keys: ['v'], action }));

        const event = keydown('\u043c', 'KeyV', { ctrlKey: true });
        expect(registry.handle(event)).toBe(false);
        expect(action).not.toHaveBeenCalled();
    });

    it('Cyrillic stays text in an input, while a mod command with worksInInputs runs', () => {
        const registry = createShortcutRegistry();
        const viewed = vi.fn();
        const palette = vi.fn();
        registry.register(shortcut({ id: 'diff.markViewed', keys: ['v'], action: viewed }));
        registry.register(
            shortcut({ id: 'palette.open', keys: ['mod+k'], worksInInputs: true, action: palette }),
        );

        const typed = keydown('\u043c', 'KeyV', { target: { tagName: 'TEXTAREA' } });
        expect(registry.handle(typed)).toBe(false);
        expect(viewed).not.toHaveBeenCalled();
        expect(typed.preventDefault).not.toHaveBeenCalled();

        const mod = keydown('\u043b', 'KeyK', { metaKey: true, target: { tagName: 'TEXTAREA' } });
        expect(registry.handle(mod)).toBe(true);
        expect(palette).toHaveBeenCalledOnce();
    });
});

describe('the `?` and `/` keys across layouts', () => {
    it('`?` matches both the US and Russian physical keys', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'help.cheatsheet', keys: ['?'], action }));

        expect(registry.handle(keydown('?', 'Slash', { shiftKey: true }))).toBe(true);
        expect(registry.handle(keydown(',', 'Slash', { shiftKey: true }))).toBe(true);
        expect(action).toHaveBeenCalledTimes(2);
    });

    it('`/` arrives as a period in the Russian layout and still matches', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'tree.filter', keys: ['/'], action }));

        expect(registry.handle(keydown('.', 'Slash'))).toBe(true);
        expect(action).toHaveBeenCalledOnce();
    });
});

describe('Latin layouts', () => {
    it('Dvorak uses the typed character instead of the physical key', () => {
        const registry = createShortcutRegistry();
        const typed = vi.fn();
        const physical = vi.fn();
        // The physical-key command is registered first: `handle` stops at the first
        // match, so an extra candidate from `code` would send the keypress to `j`. The test catches that.
        registry.register(shortcut({ id: 'physical.j', keys: ['j'], action: physical }));
        registry.register(shortcut({ id: 'typed.c', keys: ['c'], action: typed }));

        expect(registry.handle(keydown('c', 'KeyJ'))).toBe(true);
        expect(typed).toHaveBeenCalledOnce();
        expect(physical).not.toHaveBeenCalled();
    });
});
