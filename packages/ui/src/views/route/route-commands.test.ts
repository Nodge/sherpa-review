import { describe, expect, it, vi } from 'vitest';

import { createSessionStore } from '../../session/session-store.js';
import { createShortcutRegistry } from '../../shortcuts/registry.js';
import { generateCommand, PRESET_COMMAND_LABEL, presetCommand } from './route-commands.tsx';

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

describe('route generation command', () => {
    const run = (
        phase: 'none' | 'reading' | 'filling' | 'ready' | 'failed',
        smallPr = false,
        generating = false,
    ) => {
        const calls: number[] = [];
        const command = generateCommand({
            phase,
            smallPr,
            generating,
            onGenerate: () => {
                calls.push(calls.length + 1);
            },
        });
        return { command, calls };
    };

    it('calls it regeneration in the failed phase and states the consequence', () => {
        const { command } = run('failed');

        expect(command.label).toBe('Regenerate the route');
        expect(command.consequence).toBe('resets stop marks');
        expect(command.when?.()).toBe(true);
    });

    it('offers to build a route when there has never been one', () => {
        const { command } = run('none');

        expect(command.label).toBe('Build the route');
        expect(command.when?.()).toBe(true);
    });

    it('hides the command during generation or when the route is ready because the server would reject it', () => {
        expect(run('reading').command.when?.()).toBe(false);
        expect(run('filling').command.when?.()).toBe(false);
        expect(run('ready').command.when?.()).toBe(false);
    });

    it('hides the command while the request is in flight, before the phase changes', () => {
        expect(run('failed', false, true).command.when?.()).toBe(false);
        expect(run('none', false, true).command.when?.()).toBe(false);
    });

    it('never shows the command for a small PR because it does not bypass the threshold', () => {
        expect(run('none', true).command.when?.()).toBe(false);
        expect(run('failed', true).command.when?.()).toBe(false);
    });

    it('appears in the palette and calls generation', () => {
        const registry = createShortcutRegistry();
        const { command, calls } = run('failed');
        registry.register(command);

        registry.list().find((shortcut) => shortcut.id === 'route.generate')?.action();

        expect(calls).toHaveLength(1);
    });
});
