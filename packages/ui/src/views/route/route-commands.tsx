import type { RouteSnapshot } from '@sherpa/protocol';

import { planLabel } from '../../route/route-model.js';
import type { RoutePreset } from '../../session/session-store.js';
import type { ViewId } from '../../session/views.js';
import { useShortcut } from '../../shortcuts/context.tsx';
import type { Shortcut } from '../../shortcuts/registry.js';

/**
 * "Go to stop NN" palette commands (README §14, `route` group). They live at the App
 * level instead of view level: a command must also work from the full diff, switching
 * to the route view and completing the scroll itself.
 *
 * One component per command: hooks cannot be declared in a loop, and the stop list changes.
 */
export function RouteCommands({
    snapshot,
    onJump,
}: {
    snapshot: RouteSnapshot;
    onJump: (stopId: string) => void;
}) {
    return (
        <>
            {snapshot.stops.map((stop) => (
                <StopCommand
                    key={stop.id}
                    id={stop.id}
                    label={`Go to stop ${planLabel(stop.planIndex)} · ${stop.title}`}
                    onJump={onJump}
                />
            ))}
        </>
    );
}

/** The command and `t` shortcut share a label through the common registry (SPEC §5). */
export const PRESET_COMMAND_LABEL = 'Toggle the preset (triage / full tour)';

export interface PresetCommandInput {
    readonly preset: RoutePreset;
    readonly setPreset: (preset: RoutePreset) => void;
    readonly setView: (view: ViewId) => void;
}

/**
 * The `t` shortcut and "toggle preset" palette command (SPEC §5) share one declaration.
 * The preset is route state, but the command also works from the full diff: like "go
 * to stop", it switches to the route itself.
 */
export function presetCommand({ preset, setPreset, setView }: PresetCommandInput): Shortcut {
    const next: RoutePreset = preset === 'tour' ? 'triage' : 'tour';
    return {
        id: 'route.togglePreset',
        keys: ['t'],
        label: PRESET_COMMAND_LABEL,
        consequence: next === 'tour' ? 'reorders the stops into reading order' : 'restores the triage order',
        action: () => {
            setPreset(next);
            // View selection is called even from the route itself. It is the only way to dismiss
            // Review complete, otherwise the preset would change silently beneath the terminal screen.
            setView('route');
        },
    };
}

/**
 * The command lives alongside stop commands at application level, and only when the route
 * exists: there is nothing to toggle until then (SPEC §2.5).
 */
export function RoutePresetCommand(input: PresetCommandInput) {
    useShortcut(presetCommand(input));
    return null;
}

function StopCommand({ id, label, onJump }: { id: string; label: string; onJump: (stopId: string) => void }) {
    useShortcut({
        id: `route.stop.${id}`,
        keys: [],
        label,
        action: () => {
            onJump(id);
        },
    });
    return null;
}
