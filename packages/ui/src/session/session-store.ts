import type { ViewId } from './views.js';

/**
 * UI session state, what the README calls "Per session (UI)": how the PR is viewed,
 * rather than its contents. The store lives outside the React tree (requirements §1/C3), with subscriptions
 * and `useSyncExternalStore`, without synchronization effects.
 *
 * In M1-T4, the state holds only the active view. Later tasks add their own fields (diff mode,
 * filter, panels), which is why the mechanism is generic.
 */

export interface SessionState {
    readonly view: ViewId;
}

export interface SessionStore {
    readonly subscribe: (listener: () => void) => () => void;
    readonly getSnapshot: () => SessionState;
    readonly setView: (view: ViewId) => void;
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
    };
}
