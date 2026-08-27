import type { RouteSnapshot, UiRoutePhase } from '@sherpa/protocol';

import { stripInlineCode } from '../../markdown/markdown.js';
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
                    label={`Go to stop ${planLabel(stop.planIndex)} · ${stripInlineCode(stop.title)}`}
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

export interface GenerateCommandInput {
    readonly phase: UiRoutePhase | null;
    readonly smallPr: boolean;
    /** A request is already in flight. The phase has not changed yet, but a second request has no work to do here. */
    readonly generating: boolean;
    readonly onGenerate: () => void;
}

/**
 * "Regenerate the route" (README §14). Lives outside the ready-snapshot condition: the command is needed
 * precisely when no snapshot exists, in the failed phase.
 *
 * The command is hidden during generation: the server would return `already_running`, and the palette
 * would offer an action that does nothing. It is also hidden between the request and the phase change,
 * using `generating`, which also disables the retry button. A small PR does not bypass the threshold
 * (requirements §3.6), so the command is absent there too.
 */
export function generateCommand({ phase, smallPr, generating, onGenerate }: GenerateCommandInput): Shortcut {
    return {
        id: 'route.generate',
        keys: [],
        label: phase === 'failed' ? 'Regenerate the route' : 'Build the route',
        // The server clears stop progress on a new generation (M2-T7).
        consequence: 'resets stop marks',
        when: () => !smallPr && !generating && (phase === 'failed' || phase === 'none'),
        action: onGenerate,
    };
}

export function RouteGenerateCommand(input: GenerateCommandInput) {
    useShortcut(generateCommand(input));
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
