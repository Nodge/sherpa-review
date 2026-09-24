import type { RouteSnapshot, UiRoutePhase } from '@sherpa/protocol';

import type { MessageKey } from '../../i18n/index.js';
import { stripInlineCode } from '@sherpa/protocol/markdown';
import { routeGenerationAvailable } from '../../route/generation.js';
import type { OtherStopFacts } from '../../route/other-stop.js';
import { visibleStops } from '../../route/other-stop.js';
import { planLabel } from '../../route/route-model.js';
import type { RoutePreset } from '../../session/session-store.js';
import type { ViewId } from '../../session/views.js';
import { useShortcut } from '../../shortcuts/context.tsx';
import type { Shortcut } from '../../shortcuts/registry.js';

/**
 * "Go to stop NN" palette commands (docs/design/README.md §14, `route` group). They live at application
 * level instead of view level: a command must also work from the full diff, switching
 * to the route view and completing the scroll itself.
 *
 * One component per command: hooks cannot be declared in a loop, and the stop list changes.
 */
export function RouteCommands({
    snapshot,
    other,
    onJump,
}: {
    snapshot: RouteSnapshot;
    other: OtherStopFacts;
    onJump: (stopId: string) => void;
}) {
    return (
        <>
            {visibleStops(snapshot, other).map((stop) => (
                <StopCommand
                    key={stop.id}
                    id={stop.id}
                    stop={`${planLabel(stop.planIndex)} · ${stripInlineCode(stop.title)}`}
                    onJump={onJump}
                />
            ))}
        </>
    );
}

/** The command and the `t` shortcut share a label because the registry is shared (docs/design/SPEC-elements.md §5). */
export const PRESET_COMMAND_LABEL: MessageKey = 'shortcut.route.togglePreset';

export interface PresetCommandInput {
    readonly preset: RoutePreset;
    readonly setPreset: (preset: RoutePreset) => void;
    readonly setView: (view: ViewId) => void;
}

/**
 * The `t` shortcut and the "toggle preset" palette command (docs/design/SPEC-elements.md §5) share one declaration.
 * The preset is route state, but the command also works from the full diff: like "go
 * to stop", it switches to the route itself.
 */
export function presetCommand({ preset, setPreset, setView }: PresetCommandInput): Shortcut {
    const next: RoutePreset = preset === 'tour' ? 'triage' : 'tour';
    return {
        id: 'route.togglePreset',
        keys: ['t'],
        label: PRESET_COMMAND_LABEL,
        scope: 'global',
        section: 'route',
        consequence: next === 'tour' ? 'shortcut.route.preset.tour' : 'shortcut.route.preset.triage',
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
 * is ready: there is nothing to switch until a route exists (docs/design/SPEC-elements.md §2.5).
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
 * "Build / regenerate a route" (docs/design/README.md §14). In `ready` and `failed`, the old route
 * stays readable until a new skeleton is accepted.
 *
 * The command is hidden while generation runs because the server would return `already_running`. It is also hidden between
 * the request and the phase change, based on `generating`. A small PR does not bypass the threshold
 * (docs/architecture.md §7.6), so the command is absent there too.
 */
export function generateCommand({ phase, smallPr, generating, onGenerate }: GenerateCommandInput): Shortcut {
    return {
        id: 'route.generate',
        keys: [],
        label: phase === 'none' ? 'shortcut.route.generate' : 'shortcut.route.regenerate',
        scope: 'global',
        section: 'route',
        consequence: 'shortcut.route.generate.consequence',
        when: () => routeGenerationAvailable({ phase, smallPr, generating }),
        action: onGenerate,
    };
}

export function RouteGenerateCommand(input: GenerateCommandInput) {
    useShortcut(generateCommand(input));
    return null;
}

function StopCommand({ id, stop, onJump }: { id: string; stop: string; onJump: (stopId: string) => void }) {
    useShortcut({
        id: `route.stop.${id}`,
        keys: [],
        label: 'shortcut.route.stop',
        labelArg: stop,
        scope: 'global',
        section: 'route',
        action: () => {
            onJump(id);
        },
    });
    return null;
}
