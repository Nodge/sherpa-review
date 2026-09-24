import { describe, expect, it, vi } from 'vitest';

import { createT, ru as ruDictionary } from '../i18n/index.js';
import type { Shortcut, ShortcutEvent, ShortcutRegistry } from './registry.js';
import { createShortcutRegistry, formatKeys } from './registry.js';

/**
 * Scopes, chords, `?` and Esc priority. Basic behaviour is in `registry.test.ts`.
 */

function keydown(key: string, extra: Partial<ShortcutEvent> = {}): ShortcutEvent {
    return {
        key,
        code: '',
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

/** Registry with a manual chord timer: the test does not wait a real second. */
function chordRegistry(): { readonly registry: ShortcutRegistry; readonly expire: () => void } {
    let fire: (() => void) | null = null;
    const registry = createShortcutRegistry({
        setTimer: (callback) => {
            fire = callback;
            return 1;
        },
        clearTimer: () => {
            fire = null;
        },
    });
    return {
        registry,
        expire: () => {
            fire?.();
        },
    };
}

describe('scopes', () => {
    it('an active-scope command takes priority over a global command with the same key', () => {
        const registry = createShortcutRegistry();
        const global = vi.fn();
        const route = vi.fn();
        registry.register(shortcut({ id: 'global.v', keys: ['v'], action: global }));
        registry.register(shortcut({ id: 'route.v', keys: ['v'], scope: 'route', action: route }));

        registry.setActiveScope('route');

        expect(registry.handle(keydown('v'))).toBe(true);
        expect(route).toHaveBeenCalledOnce();
        expect(global).not.toHaveBeenCalled();
    });

    it('a command from another scope neither matches nor appears in the list', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'route.v', keys: ['v'], scope: 'route', action }));
        registry.setActiveScope('full-diff');

        expect(registry.handle(keydown('v'))).toBe(false);
        expect(action).not.toHaveBeenCalled();
        expect(registry.list()).toHaveLength(0);
        expect(registry.listAll()).toHaveLength(1);
    });

    it('commands within a scope match in registration order', () => {
        const registry = createShortcutRegistry();
        const first = vi.fn();
        const second = vi.fn();
        registry.register(shortcut({ id: 'first', keys: ['v'], scope: 'route', action: first }));
        registry.register(shortcut({ id: 'second', keys: ['v'], scope: 'route', action: second }));
        registry.setActiveScope('route');

        registry.handle(keydown('v'));

        expect(first).toHaveBeenCalledOnce();
        expect(second).not.toHaveBeenCalled();
    });

    it('changing scope notifies palette subscribers, repeating the same scope does not', () => {
        const registry = createShortcutRegistry();
        registry.register(shortcut({ id: 'route.v', keys: ['v'], scope: 'route', action: vi.fn() }));
        const listener = vi.fn();
        registry.subscribe(listener);

        registry.setActiveScope('route');
        expect(listener).toHaveBeenCalledOnce();
        expect(registry.list().map((item) => item.id)).toEqual(['route.v']);

        registry.setActiveScope('route');
        expect(listener).toHaveBeenCalledOnce();
        expect(registry.getActiveScope()).toBe('route');
    });
});

describe('chords', () => {
    it('`g` followed by `o` runs the chord command', () => {
        const { registry } = chordRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['1', 'g o'], action }));

        const first = keydown('g');
        expect(registry.handle(first)).toBe(true);
        expect(first.preventDefault).toHaveBeenCalledOnce();
        expect(action).not.toHaveBeenCalled();

        expect(registry.handle(keydown('o'))).toBe(true);
        expect(action).toHaveBeenCalledOnce();
    });

    it('the first shortcut of a command with a chord works on its own', () => {
        const { registry } = chordRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['1', 'g o'], action }));

        expect(registry.handle(keydown('1'))).toBe(true);
        expect(action).toHaveBeenCalledOnce();
    });

    it('an expired timeout cancels the chord', () => {
        const { registry, expire } = chordRegistry();
        const chord = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['g o'], action: chord }));

        registry.handle(keydown('g'));
        expire();

        expect(registry.handle(keydown('o'))).toBe(false);
        expect(chord).not.toHaveBeenCalled();
    });

    it('an unrelated key cancels the chord and is handled on its own', () => {
        const { registry } = chordRegistry();
        const chord = vi.fn();
        const viewed = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['g o'], action: chord }));
        registry.register(shortcut({ id: 'diff.markViewed', keys: ['v'], action: viewed }));

        registry.handle(keydown('g'));
        expect(registry.handle(keydown('v'))).toBe(true);

        expect(viewed).toHaveBeenCalledOnce();
        expect(chord).not.toHaveBeenCalled();
    });

    it('Esc cancels the chord without further handling', () => {
        const { registry } = chordRegistry();
        const chord = vi.fn();
        const layer = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['g o'], action: chord }));
        registry.registerEscapeLayer({ kind: 'popover', handler: layer });

        registry.handle(keydown('g'));
        const escape = keydown('Escape');
        expect(registry.handle(escape)).toBe(true);

        expect(layer).not.toHaveBeenCalled();
        expect(escape.preventDefault).toHaveBeenCalledOnce();
        // The chord is cleared: the next `o` is just a key.
        expect(registry.handle(keydown('o'))).toBe(false);
        expect(chord).not.toHaveBeenCalled();
    });

    it('a chord does not start in an input', () => {
        const { registry } = chordRegistry();
        const chord = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['g o'], action: chord }));

        const event = keydown('g', { target: { tagName: 'INPUT' } });

        expect(registry.handle(event)).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('a modal opened during a chord suppresses its second key', () => {
        const { registry } = chordRegistry();
        const chord = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['g o'], action: chord }));

        registry.handle(keydown('g'));
        // The modal was opened with the mouse before the timeout expired.
        registry.setModalOpen(true);

        expect(registry.handle(keydown('o'))).toBe(false);
        expect(chord).not.toHaveBeenCalled();

        // Opening the modal cleared the chord instead of deferring it until the modal closes.
        registry.setModalOpen(false);
        expect(registry.handle(keydown('o'))).toBe(false);
        expect(chord).not.toHaveBeenCalled();
    });

    it('a chord does not start under a modal', () => {
        const { registry } = chordRegistry();
        const chord = vi.fn();
        registry.register(shortcut({ id: 'view.overview', keys: ['g o'], action: chord }));
        registry.setModalOpen(true);

        const event = keydown('g');
        expect(registry.handle(event)).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('a chord from another scope does not intercept its first key', () => {
        const { registry } = chordRegistry();
        const chord = vi.fn();
        registry.register(shortcut({ id: 'route.chord', keys: ['g o'], scope: 'route', action: chord }));
        registry.setActiveScope('full-diff');

        expect(registry.handle(keydown('g'))).toBe(false);
    });
});

describe('the `?` key', () => {
    it('matches the character without an explicit shift', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'help.cheatsheet', keys: ['?'], action }));

        expect(registry.handle(keydown('?', { shiftKey: true }))).toBe(true);
        expect(action).toHaveBeenCalledOnce();
    });

    it('stays a character in an input', () => {
        const registry = createShortcutRegistry();
        const action = vi.fn();
        registry.register(shortcut({ id: 'help.cheatsheet', keys: ['?'], action }));

        expect(registry.handle(keydown('?', { shiftKey: true, target: { tagName: 'INPUT' } }))).toBe(false);
        expect(action).not.toHaveBeenCalled();
    });
});

describe('Esc priority', () => {
    it('handles one highest-priority layer per keypress', () => {
        const registry = createShortcutRegistry();
        const selection = vi.fn();
        const palette = vi.fn();
        registry.registerEscapeLayer({ kind: 'selection', handler: selection });
        const dropPalette = registry.registerEscapeLayer({ kind: 'palette', handler: palette });

        const first = keydown('Escape');
        expect(registry.handle(first)).toBe(true);
        expect(palette).toHaveBeenCalledOnce();
        expect(selection).not.toHaveBeenCalled();
        expect(first.preventDefault).toHaveBeenCalledOnce();

        dropPalette();
        expect(registry.handle(keydown('Escape'))).toBe(true);
        expect(selection).toHaveBeenCalledOnce();
    });

    it('among layers with equal priority, closes the last registered one', () => {
        const registry = createShortcutRegistry();
        const first = vi.fn();
        const second = vi.fn();
        registry.registerEscapeLayer({ kind: 'popover', handler: first });
        registry.registerEscapeLayer({ kind: 'popover', handler: second });

        registry.handle(keydown('Escape'));

        expect(second).toHaveBeenCalledOnce();
        expect(first).not.toHaveBeenCalled();
    });

    it('works in inputs and under a modal layer', () => {
        const registry = createShortcutRegistry();
        const handler = vi.fn();
        registry.registerEscapeLayer({ kind: 'palette', handler });
        registry.setModalOpen(true);

        expect(registry.handle(keydown('Escape', { target: { tagName: 'INPUT' } }))).toBe(true);
        expect(handler).toHaveBeenCalledOnce();
    });

    it('does not suppress Esc when there are no layers', () => {
        const registry = createShortcutRegistry();

        const event = keydown('Escape');
        expect(registry.handle(event)).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('removing a layer removes it from the priority order', () => {
        const registry = createShortcutRegistry();
        const handler = vi.fn();
        const unregister = registry.registerEscapeLayer({ kind: 'modal', handler });

        unregister();

        expect(registry.handle(keydown('Escape'))).toBe(false);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe('formatKeys', () => {
    const ru = createT('ru');
    const en = createT('en');

    it('renders modifiers as symbols and joins chord keys with a dictionary word', () => {
        expect(formatKeys(['mod+k'], ru)).toBe('⌘K');
        expect(formatKeys(['mod+shift+enter'], ru)).toBe('⌘⇧ENTER');
        expect(formatKeys(['1', 'g o'], ru)).toBe(`1 / G ${ruDictionary['shortcut.chord.then']} O`);
        expect(formatKeys(['g o'], en)).toBe('G then O');
        expect(formatKeys([], ru)).toBeNull();
    });
});
