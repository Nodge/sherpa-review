import type { ViewId } from './views.js';

/**
 * UI session state, what the README calls "Per session (UI)": how the PR is viewed,
 * rather than its contents. The store lives outside the React tree (requirements §1/C3), with subscriptions
 * and `useSyncExternalStore`, without synchronization effects.
 *
 * State holds the active view and selected file filter. Later tasks add their own fields
 * (panels, palette), which is why the mechanism is generic.
 */

export interface SessionState {
    readonly view: ViewId;
    /** File filter id (README §Filters). One model for the tree, cards and, in M2, the route. */
    readonly filter: string;
}

export interface SessionStore {
    readonly subscribe: (listener: () => void) => () => void;
    readonly getSnapshot: () => SessionState;
    readonly setView: (view: ViewId) => void;
    readonly setFilter: (filter: string) => void;
}

export interface SessionStoreOptions {
    readonly initial: SessionState;
    /**
     * Where state goes outside the session. On the main page, it goes into the URL fragment so a reload
     * returns to the same tab. Called only on an actual change.
     */
    readonly persist?: (state: SessionState) => void;
}

export function createSessionStore(options: SessionStoreOptions): SessionStore {
    const listeners = new Set<() => void>();
    let state = options.initial;

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
        setView: (view) => {
            if (view !== state.view) {
                update({ ...state, view });
            }
        },
        setFilter: (filter) => {
            if (filter !== state.filter) {
                update({ ...state, filter });
            }
        },
    };
}
