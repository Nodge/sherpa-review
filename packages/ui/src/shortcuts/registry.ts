import type { MessageKey } from '../i18n/ru.js';
import type { Translate } from '../i18n/translate.js';

/**
 * Shared keyboard command registry (requirements §3.3). Declare each command once here,
 * and the same declaration builds the command palette (M1-T9) and shortcuts sheet (M5-T5) without
 * a second place that defines keyboard shortcuts.
 *
 * The application also has a single keydown listener: it decides which command owns the key. It also keeps
 * the Esc priority order. Overlay layers (palette, modal, popover, toast, selection) close
 * strictly by priority, one per keypress.
 */

/** Shortcut: a key name with optional `mod+` (⌘/Ctrl), `shift+`, `alt+` prefixes. */
export type ShortcutKeys = string;

/**
 * Where the command applies. The same key means different things in different views (`v` means a
 * stop in the route and a file in the full diff). The scope distinguishes them, not registration order.
 */
export type ShortcutScope = 'global' | 'route' | 'full-diff' | 'overview';

/** Shortcuts sheet section. Section order is `SHORTCUT_SECTIONS`. */
export type ShortcutSection = 'navigation' | 'reading' | 'comments' | 'route' | 'agent' | 'ship';

/** Shortcuts sheet section order and label keys, shared by the registry and the `?` overlay. */
export const SHORTCUT_SECTIONS: readonly { readonly id: ShortcutSection; readonly label: MessageKey }[] = [
    { id: 'navigation', label: 'shortcut.section.navigation' },
    { id: 'reading', label: 'shortcut.section.reading' },
    { id: 'comments', label: 'shortcut.section.comments' },
    { id: 'route', label: 'shortcut.section.route' },
    { id: 'agent', label: 'shortcut.section.agent' },
    { id: 'ship', label: 'shortcut.section.ship' },
];

export interface Shortcut {
    readonly id: string;
    /**
     * An empty array keeps the command visible in the palette but excludes it from keydown matching.
     * A space inside a string denotes a chord: `'g o'` means "G, then O".
     */
    readonly keys: readonly ShortcutKeys[];
    /** Dictionary label key: the palette and shortcuts sheet translate it into the reviewer's language. */
    readonly label: MessageKey;
    /** Dynamic part of a parameterized label key: the stop title. */
    readonly labelArg?: string | number;
    readonly scope: ShortcutScope;
    readonly section: ShortcutSection;
    /** A command with a mod shortcut can run from an input. */
    readonly worksInInputs?: boolean;
    /** Key for the visible consequence of the command before it runs. */
    readonly consequence?: MessageKey;
    /** Dynamic part of the consequence: the draft count in the ship label. */
    readonly consequenceArg?: string | number;
    /** Palette group. Without one, the command goes into the general "Commands" group. */
    readonly group?: MessageKey;
    /** Keep the palette open after running: the command returns a status line to it. */
    readonly keepOpen?: boolean;
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

/**
 * Layers closed by Esc, from highest to lowest priority. Priority matters more than appearance order:
 * a palette above a selection closes first, and the selection survives its closure.
 */
export type EscapeLayerKind = 'palette' | 'modal' | 'popover' | 'toast' | 'selection';

const ESCAPE_ORDER: readonly EscapeLayerKind[] = ['palette', 'modal', 'popover', 'toast', 'selection'];

export interface EscapeLayer {
    readonly kind: EscapeLayerKind;
    readonly handler: () => void;
}

/** Timeout for the second key of a chord. */
export const CHORD_TIMEOUT_MS = 1000;

export interface ShortcutRegistryOptions {
    readonly chordTimeoutMs?: number;
    /** Timer injection point: the test should not wait a real second. */
    readonly setTimer?: (callback: () => void, ms: number) => unknown;
    readonly clearTimer?: (handle: unknown) => void;
}

export interface ShortcutRegistry {
    /** Returns an unregister function. A duplicate id is an error: there must be only one command. */
    readonly register: (shortcut: Shortcut) => () => void;
    /** All registered commands in registration order, including other scopes. */
    readonly listAll: () => readonly Shortcut[];
    /**
     * Commands available right now: active scope first, then global commands. The source
     * for the palette and shortcuts sheet, which must not include other scopes.
     */
    readonly list: () => readonly Shortcut[];
    /** The palette subscribes to view commands that mount and unmount with their views. */
    readonly subscribe: (listener: () => void) => () => void;
    /** Active view scope. Commands from other scopes neither match nor appear. */
    readonly setActiveScope: (scope: ShortcutScope) => void;
    readonly getActiveScope: () => ShortcutScope;
    /** A modal layer temporarily disables commands in the background interface. */
    readonly setModalOpen: (open: boolean) => void;
    /** A layer in the Esc priority order. Returns a removal function. */
    readonly registerEscapeLayer: (layer: EscapeLayer) => () => void;
    /** `true` means a command was found and executed (the event was suppressed). */
    readonly handle: (event: ShortcutEvent) => boolean;
}

interface Combination {
    readonly key: string;
    readonly mod: boolean;
    readonly shift: boolean;
    readonly alt: boolean;
}

export function createShortcutRegistry(options: ShortcutRegistryOptions = {}): ShortcutRegistry {
    const chordTimeoutMs = options.chordTimeoutMs ?? CHORD_TIMEOUT_MS;
    const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    const clearTimer = options.clearTimer ?? ((handle: unknown) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    });

    const shortcuts = new Map<string, Shortcut>();
    const listeners = new Set<() => void>();
    const escapeLayers: { readonly order: number; readonly layer: EscapeLayer }[] = [];
    let escapeOrder = 0;
    let allSnapshot: readonly Shortcut[] = [];
    let scopedSnapshot: readonly Shortcut[] = [];
    let activeScope: ShortcutScope = 'global';
    let modalOpen = false;
    /** The first key of a chord was pressed. Waiting for the second. */
    let pendingChord: { readonly combination: Combination; readonly timer: unknown } | null = null;

    const scoped = (): readonly Shortcut[] => {
        const all = [...shortcuts.values()];
        const own = activeScope === 'global' ? [] : all.filter((item) => item.scope === activeScope);
        return [...own, ...all.filter((item) => item.scope === 'global')];
    };
    const notify = (): void => {
        allSnapshot = [...shortcuts.values()];
        scopedSnapshot = scoped();
        for (const listener of [...listeners]) {
            listener();
        }
    };
    const cancelChord = (): void => {
        if (pendingChord !== null) {
            clearTimer(pendingChord.timer);
            pendingChord = null;
        }
    };
    const runEscapeLayer = (): boolean => {
        let best: { readonly order: number; readonly layer: EscapeLayer } | null = null;
        for (const candidate of escapeLayers) {
            if (best === null || rank(candidate.layer.kind) < rank(best.layer.kind)) {
                best = candidate;
                continue;
            }
            // Among layers with equal priority, the last registered one takes precedence:
            // two successive popovers close in the order they were opened.
            if (rank(candidate.layer.kind) === rank(best.layer.kind) && candidate.order > best.order) {
                best = candidate;
            }
        }
        if (best === null) {
            return false;
        }
        best.layer.handler();
        return true;
    };

    return {
        register: (shortcut) => {
            if (shortcuts.has(shortcut.id)) {
                throw new Error(`Shortcut "${shortcut.id}" is already registered`);
            }
            shortcuts.set(shortcut.id, shortcut);
            notify();
            return () => {
                if (shortcuts.delete(shortcut.id)) {
                    notify();
                }
            };
        },
        listAll: () => allSnapshot,
        list: () => scopedSnapshot,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        setActiveScope: (scope) => {
            if (scope === activeScope) {
                return;
            }
            activeScope = scope;
            cancelChord();
            notify();
        },
        getActiveScope: () => activeScope,
        setModalOpen: (open) => {
            modalOpen = open;
            if (open) {
                // A modal may have opened by mouse during the chord. Nothing is waiting for its second key anymore.
                cancelChord();
            }
        },
        registerEscapeLayer: (layer) => {
            escapeOrder += 1;
            const entry = { order: escapeOrder, layer };
            escapeLayers.push(entry);
            return () => {
                const index = escapeLayers.indexOf(entry);
                if (index >= 0) {
                    escapeLayers.splice(index, 1);
                }
            };
        },
        handle: (event) => {
            // Handle Esc in inputs (the palette field is an input) and under a modal:
            // the layer priority order is the only way to close the top overlay.
            if (event.key === 'Escape') {
                if (pendingChord !== null) {
                    cancelChord();
                    event.preventDefault();
                    return true;
                }
                if (!runEscapeLayer()) {
                    return false;
                }
                event.preventDefault();
                return true;
            }

            // A modal suppresses everything, including an unfinished chord: `g o` must not run under it.
            if (modalOpen) {
                cancelChord();
                return false;
            }

            const editable = isEditable(event.target);
            const hasMod = event.metaKey || event.ctrlKey;
            const available = (): readonly Shortcut[] =>
                scopedSnapshot.filter((shortcut) => shortcut.when?.() !== false);

            if (pendingChord !== null) {
                const first = pendingChord.combination;
                cancelChord();
                // Focus has moved to an input. The second key belongs to the text.
                for (const shortcut of editable ? [] : available()) {
                    const matched = shortcut.keys.some((keys) => {
                        const steps = parseSequence(keys);
                        return (
                            steps.length === 2 &&
                            sameCombination(steps[0], first) &&
                            matches(steps[1], event)
                        );
                    });
                    if (matched) {
                        event.preventDefault();
                        shortcut.action();
                        return true;
                    }
                }
                // The chord did not match: handle the key normally (`g`, then `v` marks viewed).
            }

            // The first key of a chord takes priority over single-key commands: intercept it and wait for the second.
            if (!editable && !hasMod && !event.altKey) {
                const starts = available().some((shortcut) =>
                    shortcut.keys.some((keys) => {
                        const steps = parseSequence(keys);
                        return steps.length === 2 && matches(steps[0], event);
                    }),
                );
                if (starts) {
                    pendingChord = {
                        combination: combinationOf(event),
                        timer: setTimer(() => {
                            pendingChord = null;
                        }, chordTimeoutMs),
                    };
                    event.preventDefault();
                    return true;
                }
            }

            for (const shortcut of available()) {
                if (editable && !(shortcut.worksInInputs === true && hasMod)) {
                    // Text input takes priority over regular commands: "1" in a search field is a character, not a tab.
                    continue;
                }
                const matched = shortcut.keys.some((keys) => {
                    const steps = parseSequence(keys);
                    return steps.length === 1 && matches(steps[0], event);
                });
                if (!matched) {
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

function rank(kind: EscapeLayerKind): number {
    return ESCAPE_ORDER.indexOf(kind);
}

/** Chord steps: `'g o'` becomes two shortcuts, a regular command becomes one. */
export function parseSequence(keys: ShortcutKeys): readonly Combination[] {
    return keys
        .split(' ')
        .filter((step) => step !== '')
        .map(parseKeys);
}

export function parseKeys(keys: ShortcutKeys): Combination {
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

function combinationOf(event: ShortcutEvent): Combination {
    return {
        key: event.key.toLowerCase(),
        mod: event.metaKey || event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
    };
}

function sameCombination(first: Combination | undefined, second: Combination): boolean {
    return first?.key === second.key && first.mod === second.mod && first.alt === second.alt;
}

/**
 * A character key already accounts for the layout and shift: `?` is `shift+/`, but
 * `event.key` is `?`, so checking the modifier makes no sense. Otherwise `?` would never work.
 */
function symbolKey(key: string): boolean {
    return key.length === 1 && !/[a-z0-9]/.test(key);
}

function matches(combination: Combination | undefined, event: ShortcutEvent): boolean {
    if (combination === undefined) {
        return false;
    }
    // `mod` is ⌘ on Mac and Ctrl elsewhere. Modifiers must match exactly in both directions:
    // Ctrl+1 must not trigger "1".
    const mod = event.metaKey || event.ctrlKey;
    return (
        event.key.toLowerCase() === combination.key &&
        mod === combination.mod &&
        (symbolKey(combination.key) || event.shiftKey === combination.shift) &&
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

/**
 * Shortcut label for the palette and shortcuts sheet: `mod+k` → `⌘K`, chord `g o` → `G then O`.
 * The word joining chord steps is the only dictionary word in the label, so this takes `t`.
 */
export function formatKeys(keys: readonly ShortcutKeys[], t: Translate): string | null {
    if (keys.length === 0) {
        return null;
    }
    return keys.map((combination) => formatCombination(combination, t)).join(' / ');
}

/** Arrows render as glyphs: `ARROWRIGHT` is unreadable in the shortcuts sheet. */
const KEY_GLYPHS: Readonly<Record<string, string>> = {
    arrowright: '→',
    arrowleft: '←',
    arrowup: '↑',
    arrowdown: '↓',
};

function formatCombination(keys: ShortcutKeys, t: Translate): string {
    return keys
        .split(' ')
        .filter((step) => step !== '')
        .map((step) => {
            const glyph = KEY_GLYPHS[step.toLowerCase()];
            return (
                glyph ??
                step
                    .replace('mod+', '⌘')
                    .replace('shift+', '⇧')
                    .replace('alt+', '⌥')
                    .toUpperCase()
            );
        })
        .join(` ${t('shortcut.chord.then')} `);
}
