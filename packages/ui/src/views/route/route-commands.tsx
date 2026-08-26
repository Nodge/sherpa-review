import type { RouteSnapshot } from '@sherpa/protocol';

import { planLabel } from '../../route/route-model.js';
import { useShortcut } from '../../shortcuts/context.tsx';

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
