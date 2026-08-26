import type { ViewId } from './views.js';

/**
 * UI session state, what the README calls "Per session (UI)": how the PR is viewed,
 * rather than its contents. The store lives outside the React tree (requirements §1/C3), with subscriptions
 * and `useSyncExternalStore`, without synchronization effects.
 *
 * State holds the active view and selected file filter. Later tasks add their own fields
 * (panels, palette), which is why the mechanism is generic.
 */

export interface ThreadsShow {
    readonly people: boolean;
    readonly bots: boolean;
    readonly resolved: boolean;
}

export const DEFAULT_THREADS_SHOW: ThreadsShow = { people: true, bots: false, resolved: false };

/**
 * Route stop expansion in the current session (M2-T6). Three sets instead of one flag: the
 * "viewed" mark collapses hunks but preserves previous expansion. Clearing the mark must
 * restore the card to exactly the state it was left in (SPEC §2.9).
 *
 * The "viewed" mark itself does not live here: it persists per PR on the server (M2-T7,
 * README State model), held by `StopProgressStore`.
 *
 * `expanded` means the stop is expanded despite tier-based collapse (low is collapsed by default).
 * `expandedViewed` means a viewed stop is temporarily expanded from its summary row.
 * `collapsed` means the stop was collapsed by hand (`x` shortcut, SPEC §5), regardless of tier.
 */
export interface StopsState {
    readonly expanded: ReadonlySet<string>;
    readonly expandedViewed: ReadonlySet<string>;
    readonly collapsed: ReadonlySet<string>;
}

export const EMPTY_STOPS: StopsState = {
    expanded: new Set(),
    expandedViewed: new Set(),
    collapsed: new Set(),
};

/**
 * Route preset (README State model, SPEC §2.5): `triage` is the plan's "most important first" order,
 * `tour` is the narrative reading order from the snapshot's `tourOrder`. The preset does not affect
 * stop numbers, which are fixed by the plan (SPEC §8 item 4).
 */
export type RoutePreset = 'triage' | 'tour';

export const DEFAULT_PRESET: RoutePreset = 'triage';

/** `null` means the string is not a preset (invalid URL fragment value). */
export function parsePreset(value: string | null): RoutePreset | null {
    return value === 'triage' || value === 'tour' ? value : null;
}

export interface SessionState {
    readonly view: ViewId;
    /** File filter id (README §Filters). One model for the tree, cards and, in M2, the route. */
    readonly filter: string;
    readonly preset: RoutePreset;
    /** Additive thread sources. They live only in the current tab session. */
    readonly threadsShow: ThreadsShow;
    /** The command palette is open over the current view. */
    readonly paletteOpen: boolean;
    readonly stops: StopsState;
}

export interface SessionStore {
    readonly subscribe: (listener: () => void) => () => void;
    readonly getSnapshot: () => SessionState;
    /** Every attempt to select a view, including selecting the current one again. */
    readonly subscribeViewSelection: (listener: () => void) => () => void;
    readonly getViewSelectionSnapshot: () => number;
    readonly setView: (view: ViewId) => void;
    readonly setFilter: (filter: string) => void;
    readonly setPreset: (preset: RoutePreset) => void;
    readonly setThreadsShow: (threadsShow: ThreadsShow) => void;
    readonly setPaletteOpen: (open: boolean) => void;
    /** Normal stop expansion (low-tier stops are collapsed by default). */
    readonly setStopExpanded: (stopId: string, expanded: boolean) => void;
    /** Expansion of a viewed stop from its summary row. */
    readonly setViewedStopExpanded: (stopId: string, expanded: boolean) => void;
    /** Manual collapse of a stop in any tier. */
    readonly setStopCollapsed: (stopId: string, collapsed: boolean) => void;
    /**
     * The mark was cleared. Temporary expansion of a viewed stop lasts only while it is
     * marked, and its previous expansion (`expanded`) must return unchanged.
     */
    readonly forgetViewedExpansion: (stopId: string) => void;
}

export interface SessionStoreOptions {
    readonly initial: Omit<SessionState, 'threadsShow' | 'paletteOpen' | 'stops' | 'preset'> & {
        readonly threadsShow?: ThreadsShow;
        readonly paletteOpen?: boolean;
        readonly stops?: StopsState;
        readonly preset?: RoutePreset;
    };
    /**
     * Where state goes outside the session. On the main page, it goes into the URL fragment so a reload
     * returns to the same tab. Called only on an actual change.
     */
    readonly persist?: (state: SessionState) => void;
}

export function createSessionStore(options: SessionStoreOptions): SessionStore {
    const listeners = new Set<() => void>();
    const viewSelectionListeners = new Set<() => void>();
    let viewSelection = 0;
    let state: SessionState = {
        ...options.initial,
        threadsShow: options.initial.threadsShow ?? DEFAULT_THREADS_SHOW,
        paletteOpen: options.initial.paletteOpen ?? false,
        stops: options.initial.stops ?? EMPTY_STOPS,
        preset: options.initial.preset ?? DEFAULT_PRESET,
    };

    const toggleStop = (key: keyof StopsState, stopId: string, on: boolean): void => {
        const current = state.stops[key];
        if (current.has(stopId) === on) {
            return;
        }
        const next = new Set(current);
        if (on) {
            next.add(stopId);
        } else {
            next.delete(stopId);
        }
        update({ ...state, stops: { ...state.stops, [key]: next } });
    };

    const update = (next: SessionState): void => {
        state = next;
        options.persist?.(next);
        for (const listener of [...listeners]) {
            listener();
        }
    };

    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => state,
        subscribeViewSelection: (listener) => {
            viewSelectionListeners.add(listener);
            return () => {
                viewSelectionListeners.delete(listener);
            };
        },
        getViewSelectionSnapshot: () => viewSelection,
        setView: (view) => {
            viewSelection += 1;
            for (const listener of [...viewSelectionListeners]) {
                listener();
            }
            if (view !== state.view) {
                update({ ...state, view });
            }
        },
        setFilter: (filter) => {
            if (filter !== state.filter) {
                update({ ...state, filter });
            }
        },
        setPreset: (preset) => {
            if (preset !== state.preset) {
                update({ ...state, preset });
            }
        },
        setThreadsShow: (threadsShow) => {
            if (
                threadsShow.people !== state.threadsShow.people ||
                threadsShow.bots !== state.threadsShow.bots ||
                threadsShow.resolved !== state.threadsShow.resolved
            ) {
                update({ ...state, threadsShow });
            }
        },
        setPaletteOpen: (paletteOpen) => {
            if (paletteOpen !== state.paletteOpen) {
                update({ ...state, paletteOpen });
            }
        },

        setStopExpanded: (stopId, expanded) => {
            toggleStop('expanded', stopId, expanded);
        },
        setViewedStopExpanded: (stopId, expanded) => {
            toggleStop('expandedViewed', stopId, expanded);
        },
        setStopCollapsed: (stopId, collapsed) => {
            toggleStop('collapsed', stopId, collapsed);
        },
        forgetViewedExpansion: (stopId) => {
            toggleStop('expandedViewed', stopId, false);
        },
    };
}
