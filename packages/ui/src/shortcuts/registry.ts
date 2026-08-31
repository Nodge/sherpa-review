/**
 * Shared keyboard command registry (requirements §3.3). Declare each command once here,
 * then use that declaration for the command palette (M1-T9) and shortcuts sheet (M5), without
 * a second place that defines keyboard shortcuts.
 *
 * The app also has just one keydown listener, which decides who handles each key.
 * M1-T4 only registers 1/2/3 for switching views. The full SPEC §5 map comes in M5.
 */

/** Shortcut: a key name with optional `mod+` (⌘/Ctrl), `shift+`, `alt+` prefixes. */
export type ShortcutKeys = string;

export interface Shortcut {
    readonly id: string;
    /** An empty array shows the command in the palette but excludes it from keydown matching. */
    readonly keys: readonly ShortcutKeys[];
    /** Human-readable label for the palette and shortcuts sheet, in Russian. */
    readonly label: string;
    /** A command with a mod shortcut can run from an input. */
    readonly worksInInputs?: boolean;
    /** Visible consequence of a command before it runs. */
    readonly consequence?: string;
    /** The command is active only when this returns true. Without it, the command is always active. */
    readonly when?: () => boolean;
    readonly action: () => void;
}

/**
 * Keyboard event subset needed by the registry. The browser's `KeyboardEvent` satisfies this
 * shape. Tests do not need a DOM.
 */
export interface ShortcutEvent {
    readonly key: string;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly target: unknown;
    readonly preventDefault: () => void;
}

export interface ShortcutRegistry {
    /** Returns an unregister function. A duplicate id is an error: there must be only one command. */
    readonly register: (shortcut: Shortcut) => () => void;
    /** All registered commands in registration order, for the palette and shortcuts sheet. */
    readonly list: () => readonly Shortcut[];
    /** The palette subscribes to view commands that mount and unmount with their views. */
    readonly subscribe: (listener: () => void) => () => void;
    /** A modal layer temporarily disables commands in the background interface. */
    readonly setModalOpen: (open: boolean) => void;
    /** `true` means a command was found and executed (the event was suppressed). */
    readonly handle: (event: ShortcutEvent) => boolean;
}

interface Combination {
    readonly key: string;
    readonly mod: boolean;
    readonly shift: boolean;
    readonly alt: boolean;
}

export function createShortcutRegistry(): ShortcutRegistry {
    const shortcuts = new Map<string, Shortcut>();
    const listeners = new Set<() => void>();
    let snapshot: readonly Shortcut[] = [];
    let modalOpen = false;

    const notify = (): void => {
        snapshot = [...shortcuts.values()];
        for (const listener of [...listeners]) {
            listener();
        }
    };

    return {
        register: (shortcut) => {
            if (shortcuts.has(shortcut.id)) {
                throw new Error(`Command "${shortcut.id}" already registered`);
            }
            shortcuts.set(shortcut.id, shortcut);
            notify();
            return () => {
                if (shortcuts.delete(shortcut.id)) {
                    notify();
                }
            };
        },
        list: () => snapshot,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        setModalOpen: (open) => {
            modalOpen = open;
        },
        handle: (event) => {
            if (modalOpen) {
                return false;
            }
            const editable = isEditable(event.target);
            const hasMod = event.metaKey || event.ctrlKey;

            for (const shortcut of shortcuts.values()) {
                if (shortcut.when?.() === false) {
                    continue;
                }
                if (editable && !(shortcut.worksInInputs === true && hasMod)) {
                    // Text input takes priority over regular commands: "1" in a search field is a character, not a tab.
                    continue;
                }
                if (!shortcut.keys.some((keys) => matches(parseKeys(keys), event))) {
                    continue;
                }

                event.preventDefault();
                shortcut.action();
                return true;
            }
            return false;
        },
    };
}

/**
 * Attaches the single keydown listener. Returns a removal function, which production does not need
 * (the listener lives as long as the page), but without it the registry could not be used in a test.
 */
export function attachShortcuts(target: EventTarget, registry: ShortcutRegistry): () => void {
    const listener = (event: Event): void => {
        registry.handle(event as unknown as ShortcutEvent);
    };
    target.addEventListener('keydown', listener);
    return () => {
        target.removeEventListener('keydown', listener);
    };
}

function parseKeys(keys: ShortcutKeys): Combination {
    const parts = keys.toLowerCase().split('+');
    const key = parts.at(-1) ?? '';
    const modifiers = parts.slice(0, -1);
    return {
        key,
        mod: modifiers.includes('mod'),
        shift: modifiers.includes('shift'),
        alt: modifiers.includes('alt'),
    };
}

function matches(combination: Combination, event: ShortcutEvent): boolean {
    // `mod` is ⌘ on Mac and Ctrl elsewhere. Modifiers must match exactly in both directions:
    // Ctrl+1 must not trigger "1".
    const mod = event.metaKey || event.ctrlKey;
    return (
        event.key.toLowerCase() === combination.key &&
        mod === combination.mod &&
        event.shiftKey === combination.shift &&
        event.altKey === combination.alt
    );
}

/** Input field: keys belong to text here, not commands. */
function isEditable(target: unknown): boolean {
    if (target === null || typeof target !== 'object') {
        return false;
    }

    const element = target as { tagName?: unknown; isContentEditable?: unknown };
    if (element.isContentEditable === true) {
        return true;
    }

    const tagName = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
    return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}
