import { describe, expect, it, vi } from 'vitest';

import { createSessionStore } from '../../session/session-store.js';
import { createShortcutRegistry } from '../../shortcuts/registry.js';
import { PRESET_COMMAND_LABEL, presetCommand } from './route-commands.tsx';

/**
 * The "toggle preset" command shares one declaration between the `t` shortcut and the palette (SPEC §5).
 * The registry is shared, so the tests check both its description and what `action` does.
 */

function keyEvent(key: string) {
    return {
        key,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        target: null,
        preventDefault: vi.fn(),
    };
}

describe('preset toggle command', () => {
    it('uses the t key with the same wording as the palette', () => {
        const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const command = presetCommand({
            preset: 'triage',
            setPreset: session.setPreset,
            setView: session.setView,
        });

        expect(command.keys).toEqual(['t']);
        expect(command.label).toBe(PRESET_COMMAND_LABEL);
        expect(command.consequence).toBe('reorders the stops into reading order');
    });

    it('switches the preset back and forth while staying on the route', () => {
        const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const run = (): void => {
            presetCommand({
                preset: session.getSnapshot().preset,
                setPreset: session.setPreset,
                setView: session.setView,
            }).action();
        };

        run();
        expect(session.getSnapshot()).toMatchObject({ view: 'route', preset: 'tour' });

        run();
        expect(session.getSnapshot()).toMatchObject({ view: 'route', preset: 'triage' });
    });

    it('selects the view even from the route itself, so Review complete does not stay on screen', () => {
        const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const before = session.getViewSelectionSnapshot();

        presetCommand({
            preset: 'triage',
            setPreset: session.setPreset,
            setView: session.setView,
        }).action();

        expect(session.getViewSelectionSnapshot()).toBe(before + 1);
    });

    it('switches the preset from the full diff and opens the route', () => {
        const session = createSessionStore({ initial: { view: 'diff', filter: 'all' } });

        presetCommand({
            preset: 'triage',
            setPreset: session.setPreset,
            setView: session.setView,
        }).action();

        expect(session.getSnapshot()).toMatchObject({ view: 'route', preset: 'tour' });
    });

    it('uses the shared registry: t reaches it and the palette lists it', () => {
        const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const registry = createShortcutRegistry();
        registry.register(
            presetCommand({
                preset: 'triage',
                setPreset: session.setPreset,
                setView: session.setView,
            }),
        );

        expect(registry.handle(keyEvent('t'))).toBe(true);
        expect(session.getSnapshot().preset).toBe('tour');
        expect(registry.list().map((shortcut) => shortcut.label)).toContain(PRESET_COMMAND_LABEL);
    });
});
