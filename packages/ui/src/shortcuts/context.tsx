import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';

import type { EscapeLayerKind, Shortcut, ShortcutRegistry } from './registry.js';

/**
 * View access to the single command registry (spec §3.3): the registry is created on page start,
 * and components with actions declare commands. Outside the provider (state gallery),
 * registration is a no-op because states must render without keyboard support.
 */

const ShortcutsContext = createContext<ShortcutRegistry | null>(null);

export function ShortcutsProvider({ registry, children }: { registry: ShortcutRegistry; children: ReactNode }) {
    return <ShortcutsContext value={registry}>{children}</ShortcutsContext>;
}

export function useShortcutRegistry(): ShortcutRegistry | null {
    return useContext(ShortcutsContext);
}

/**
 * Reactive registry snapshot for the palette and shortcuts sheet. Active scope commands come first, then global commands.
 * Other scopes are excluded because their keys would not work anyway.
 */
export function useShortcutList(): readonly Shortcut[] {
    const registry = useShortcutRegistry();
    const empty = useRef<readonly Shortcut[]>([]);
    return useSyncExternalStore(
        registry?.subscribe ?? NO_SUBSCRIBE,
        registry?.list ?? (() => empty.current),
        registry?.list ?? (() => empty.current),
    );
}

const NO_SUBSCRIBE = (): (() => void) => () => undefined;

/**
 * A command lives while its component is mounted. `action` and `when` are read through refs, so
 * fresh closures do not require re-registration. `id`/`keys`/`label` cannot change because
 * they describe the command rather than its state.
 */
export function useShortcut(shortcut: Shortcut): void {
    const registry = useContext(ShortcutsContext);
    const latest = useRef(shortcut);
    useEffect(() => {
        latest.current = shortcut;
    });

    const { id, label, labelArg, scope, section, worksInInputs, consequence, consequenceArg, group } = shortcut;
    const keys = shortcut.keys.join('\n');
    useEffect(() => {
        if (registry === null) {
            return;
        }
        return registry.register({
            id,
            keys: keys === '' ? [] : keys.split('\n'),
            label,
            ...(labelArg === undefined ? {} : { labelArg }),
            scope,
            section,
            ...(worksInInputs === undefined ? {} : { worksInInputs }),
            ...(consequence === undefined ? {} : { consequence }),
            ...(consequenceArg === undefined ? {} : { consequenceArg }),
            ...(group === undefined ? {} : { group }),
            when: () => latest.current.when?.() ?? true,
            action: () => {
                latest.current.action();
            },
        });
    }, [
        registry,
        id,
        keys,
        label,
        labelArg,
        scope,
        section,
        worksInInputs,
        consequence,
        consequenceArg,
        group,
    ]);
}

/**
 * A layer in the Esc hierarchy (M5 decision 10). While `active`, the layer is on the registry stack. On Esc
 * only the highest-priority active layer fires, so the overlay does not need its own
 * keyboard listener.
 */
export function useEscapeLayer(kind: EscapeLayerKind, handler: () => void, active = true): void {
    const registry = useContext(ShortcutsContext);
    const latest = useRef(handler);
    useEffect(() => {
        latest.current = handler;
    });

    useEffect(() => {
        if (registry === null || !active) {
            return;
        }
        return registry.registerEscapeLayer({
            kind,
            handler: () => {
                latest.current();
            },
        });
    }, [registry, kind, active]);
}
