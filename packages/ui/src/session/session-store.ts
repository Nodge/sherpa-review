import type { Viewing } from '../iterations/viewing.js';
import { sameViewing, VIEWING_CURRENT } from '../iterations/viewing.js';
import type { ViewId } from './views.js';

/**
 * Session UI state is what `docs/design/README.md` calls "Per session (UI)": how
 * the PR is viewed, not what it contains. The store lives outside the React tree (docs/architecture.md §1)
 * and uses subscriptions plus `useSyncExternalStore`, with no synchronization effects.
 *
 * State holds the active view and selected file filter. The mechanism is generic, so new fields
 * (panels, palette) can be added alongside them.
 */

export interface ThreadsShow {
    readonly people: boolean;
    readonly bots: boolean;
    readonly resolved: boolean;
}

export const DEFAULT_THREADS_SHOW: ThreadsShow = { people: true, bots: false, resolved: false };
export const EMPTY_NOTES_EXPANDED: ReadonlySet<string> = new Set();
export const EMPTY_NOTE_STACKS_EXPANDED: ReadonlySet<string> = new Set();

export function isNoteExpanded(state: Pick<SessionState, 'notesExpanded'>, noteId: number | string): boolean {
    return state.notesExpanded.has(String(noteId));
}

export function isNoteStackExpanded(
    state: Pick<SessionState, 'noteStacksExpanded'>,
    stackKey: string,
): boolean {
    return state.noteStacksExpanded.has(stackKey);
}

/**
 * Route stop expansions in the current session. Sets are used instead of a single flag. The
 * "viewed" mark collapses hunks but preserves previous expansion. Clearing the mark must
 * restore the card exactly as it was left (docs/design/SPEC-elements.md §2.9).
 *
 * The "viewed" mark itself does not live here. It is persisted per PR on the server
 * (docs/design/README.md, "State model") and held by `StopProgressStore`.
 *
 * `expanded` means the stop is expanded despite tier-based collapse (low is collapsed by default).
 * `expandedViewed` means a viewed stop is temporarily expanded from its summary row.
 * `collapsed` means the stop was collapsed by hand (`x` shortcut, §5), regardless of tier.
 * `testCode` means test code is expanded in a digest stop (README §2). A set instead of a shared
 * flag allows multiple digests in a route, so expanding one digest's test code must not
 * expand another's. This toggle only changes the display and leaves the "viewed" mark alone.
 */
export interface StopsState {
    readonly expanded: ReadonlySet<string>;
    readonly expandedViewed: ReadonlySet<string>;
    readonly collapsed: ReadonlySet<string>;
    readonly testCode: ReadonlySet<string>;
}

export const EMPTY_STOPS: StopsState = {
    expanded: new Set(),
    expandedViewed: new Set(),
    collapsed: new Set(),
    testCode: new Set(),
};

/**
 * Route preset (docs/design/README.md "State model", docs/design/SPEC-elements.md §2.5).
 * `triage` uses the plan's "important first" order. `tour` uses the narrative reading order in the snapshot's `tourOrder`
 * field. Stop numbers are independent of the preset and fixed by the plan (§8 item 4).
 */
export type RoutePreset = 'triage' | 'tour';

export const DEFAULT_PRESET: RoutePreset = 'triage';

/** `null` means the string is not a preset (invalid URL fragment value). */
export function parsePreset(value: string | null): RoutePreset | null {
    return value === 'triage' || value === 'tour' ? value : null;
}

/**
 * "What is new since the previous pass" filter (docs/design/README.md §9). `new` keeps
 * only route stops classified relative to the previous snapshot. Stop numbers
 * stay fixed by the plan, and the file filter applies on top.
 */
export type RouteFilter = 'all' | 'new';

export const DEFAULT_ROUTE_FILTER: RouteFilter = 'all';

/** `null` means the string is not a route filter (invalid URL fragment value). */
export function parseRouteFilter(value: string | null): RouteFilter | null {
    return value === 'all' || value === 'new' ? value : null;
}

export interface SessionState {
    readonly view: ViewId;
    /**
     * What the tab is viewing: current PR state, a previous snapshot or an iteration without a route.
     * The selection is client-side and lives in the URL fragment.
     */
    readonly viewing: Viewing;
    /** File filter id (docs/design/README.md §Filters). One model for the tree, cards and route. */
    readonly filter: string;
    readonly preset: RoutePreset;
    readonly routeFilter: RouteFilter;
    /** Additive thread sources. They live only in the current tab session. */
    readonly threadsShow: ThreadsShow;
    /**
     * The "threads by one author" lens in Full diff holds the login of the participant selected
     * in the discussion card. Stored in the tab, never written to the URL. Survives PR and iteration
     * changes, but not a reload.
     */
    readonly threadAuthor: string | null;
    /** The command palette is open over the current view. */
    readonly paletteOpen: boolean;
    /** Chat is open in the third column, only for the current tab session. */
    readonly chatOpen: boolean;
    /** Expanded agent notes, shared between route and full diff, without persistence. */
    readonly notesExpanded: ReadonlySet<string>;
    /** Expanded note stacks, keyed by the stack's file, side and range. */
    readonly noteStacksExpanded: ReadonlySet<string>;
    readonly stops: StopsState;
}

export interface SessionStore {
    readonly subscribe: (listener: () => void) => () => void;
    readonly getSnapshot: () => SessionState;
    /** Every attempt to select a view, including selecting the current one again. */
    readonly subscribeViewSelection: (listener: () => void) => () => void;
    readonly getViewSelectionSnapshot: () => number;
    /**
     * The reviewer chose the view through a link with the `view` parameter or manually in this session. The default view
     * may change to suit the data (small PRs open in full diff, docs/design/SPEC-elements.md §4.1).
     * A chosen view must never change automatically.
     */
    readonly viewPinned: () => boolean;
    readonly setView: (view: ViewId) => void;
    readonly setFilter: (filter: string) => void;
    readonly setPreset: (preset: RoutePreset) => void;
    readonly setRouteFilter: (routeFilter: RouteFilter) => void;
    /**
     * `fragment` contains URL keys to set in the same patch as the selection change.
     * Otherwise, `viewingFragmentPatch` removes them as anchors from another diff ("show at the
     * old commit" sets `thread`).
     */
    readonly setViewing: (viewing: Viewing, fragment?: Readonly<Record<string, string | null>>) => void;
    readonly setThreadsShow: (threadsShow: ThreadsShow) => void;
    /** `null` clears the author lens. */
    readonly setThreadAuthor: (login: string | null) => void;
    readonly setPaletteOpen: (open: boolean) => void;
    readonly setChatOpen: (open: boolean) => void;
    readonly toggleNoteExpanded: (noteId: number | string) => void;
    /** Forces expansion for navigation from chat to a note. */
    readonly expandNote: (noteId: number | string) => void;
    readonly setNoteStackExpanded: (stackKey: string, expanded: boolean) => void;
    /** Closes the stack and all expanded notes inside it in one update. */
    readonly collapseNoteStack: (stackKey: string, noteIds: readonly (number | string)[]) => void;
    /** Normal stop expansion (low-tier stops are collapsed by default). */
    readonly setStopExpanded: (stopId: string, expanded: boolean) => void;
    /** Expansion of a viewed stop from its summary row. */
    readonly setViewedStopExpanded: (stopId: string, expanded: boolean) => void;
    /** Manual collapse of a stop in any tier. */
    readonly setStopCollapsed: (stopId: string, collapsed: boolean) => void;
    /** Show/Hide test code on a digest stop (docs/design/README.md §2). */
    readonly setStopTestCode: (stopId: string, shown: boolean) => void;
    /**
     * The mark was cleared. Temporary expansion of a viewed stop lasts only while it is
     * marked, and its previous expansion (`expanded`) must return unchanged.
     */
    readonly forgetViewedExpansion: (stopId: string) => void;
}

export interface SessionStoreOptions {
    readonly initial: Omit<SessionState, 'threadsShow' | 'threadAuthor' | 'paletteOpen' | 'chatOpen' | 'notesExpanded' | 'noteStacksExpanded' | 'stops' | 'preset' | 'routeFilter' | 'viewing'> & {
        readonly threadsShow?: ThreadsShow;
        readonly threadAuthor?: string | null;
        readonly routeFilter?: RouteFilter;
        readonly viewing?: Viewing;
        readonly paletteOpen?: boolean;
        readonly chatOpen?: boolean;
        readonly notesExpanded?: ReadonlySet<string>;
        readonly noteStacksExpanded?: ReadonlySet<string>;
        readonly stops?: StopsState;
        readonly preset?: RoutePreset;
    };
    /** The view came from the URL instead of the default and can no longer change to suit the data. */
    readonly viewPinned?: boolean;
    /**
     * Where state goes outside the session. On the main page, it goes into the URL fragment so a reload
     * returns to the same tab. Called only on an actual change.
     */
    readonly persist?: (state: SessionState, fragment?: Readonly<Record<string, string | null>>) => void;
}

export function createSessionStore(options: SessionStoreOptions): SessionStore {
    const listeners = new Set<() => void>();
    const viewSelectionListeners = new Set<() => void>();
    let viewSelection = 0;
    let viewPinned = options.viewPinned ?? false;
    let state: SessionState = {
        ...options.initial,
        threadsShow: options.initial.threadsShow ?? DEFAULT_THREADS_SHOW,
        threadAuthor: options.initial.threadAuthor ?? null,
        paletteOpen: options.initial.paletteOpen ?? false,
        chatOpen: options.initial.chatOpen ?? false,
        notesExpanded: options.initial.notesExpanded ?? EMPTY_NOTES_EXPANDED,
        noteStacksExpanded: options.initial.noteStacksExpanded ?? EMPTY_NOTE_STACKS_EXPANDED,
        stops: options.initial.stops ?? EMPTY_STOPS,
        preset: options.initial.preset ?? DEFAULT_PRESET,
        routeFilter: options.initial.routeFilter ?? DEFAULT_ROUTE_FILTER,
        viewing: options.initial.viewing ?? VIEWING_CURRENT,
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

    // Pass the fragment patch only when present. Without it, persist receives one argument.
    const persist = (next: SessionState, fragment?: Readonly<Record<string, string | null>>): void => {
        if (fragment === undefined) {
            options.persist?.(next);
            return;
        }
        options.persist?.(next, fragment);
    };

    const update = (next: SessionState, fragment?: Readonly<Record<string, string | null>>): void => {
        state = next;
        persist(next, fragment);
        for (const listener of [...listeners]) {
            listener();
        }
    };

    const setNoteExpanded = (noteId: number | string, expanded: boolean): void => {
        const key = String(noteId);
        if (state.notesExpanded.has(key) === expanded) {
            return;
        }
        const notesExpanded = new Set(state.notesExpanded);
        if (expanded) {
            notesExpanded.add(key);
        } else {
            notesExpanded.delete(key);
        }
        update({ ...state, notesExpanded });
    };

    const setNoteStackExpanded = (stackKey: string, expanded: boolean): void => {
        if (state.noteStacksExpanded.has(stackKey) === expanded) {
            return;
        }
        const noteStacksExpanded = new Set(state.noteStacksExpanded);
        if (expanded) {
            noteStacksExpanded.add(stackKey);
        } else {
            noteStacksExpanded.delete(stackKey);
        }
        update({ ...state, noteStacksExpanded });
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
        viewPinned: () => viewPinned,
        setView: (view) => {
            viewPinned = true;
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
        setRouteFilter: (routeFilter) => {
            if (routeFilter !== state.routeFilter) {
                update({ ...state, routeFilter });
            }
        },
        setViewing: (viewing, fragment) => {
            if (!sameViewing(viewing, state.viewing)) {
                update({ ...state, viewing }, fragment);
            } else if (fragment !== undefined) {
                persist(state, fragment);
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
        setThreadAuthor: (threadAuthor) => {
            if (threadAuthor !== state.threadAuthor) {
                update({ ...state, threadAuthor });
            }
        },
        setPaletteOpen: (paletteOpen) => {
            if (paletteOpen !== state.paletteOpen) {
                update({ ...state, paletteOpen });
            }
        },
        setChatOpen: (chatOpen) => {
            if (chatOpen !== state.chatOpen) {
                update({ ...state, chatOpen });
            }
        },
        toggleNoteExpanded: (noteId) => {
            setNoteExpanded(noteId, !state.notesExpanded.has(String(noteId)));
        },
        expandNote: (noteId) => {
            setNoteExpanded(noteId, true);
        },
        setNoteStackExpanded,
        collapseNoteStack: (stackKey, noteIds) => {
            const noteKeys = new Set(noteIds.map(String));
            const stackChanged = state.noteStacksExpanded.has(stackKey);
            const notesChanged = [...noteKeys].some((noteId) => state.notesExpanded.has(noteId));
            if (!stackChanged && !notesChanged) {
                return;
            }
            const noteStacksExpanded = new Set(state.noteStacksExpanded);
            noteStacksExpanded.delete(stackKey);
            const notesExpanded = new Set(state.notesExpanded);
            for (const noteId of noteKeys) {
                notesExpanded.delete(noteId);
            }
            update({ ...state, noteStacksExpanded, notesExpanded });
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
        setStopTestCode: (stopId, shown) => {
            toggleStop('testCode', stopId, shown);
        },
        forgetViewedExpansion: (stopId) => {
            toggleStop('expandedViewed', stopId, false);
        },
    };
}
