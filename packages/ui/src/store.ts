import type { UiState } from '@sherpa/protocol';
import {
    UI_ENDPOINTS,
    UI_PROGRESS_EVENT,
    UI_REVIEW_EVENT,
    UI_ROUTE_EVENT,
    UI_STATE_EVENT,
    uiProgressEventSchema,
    uiReviewEventSchema,
    uiRouteEventSchema,
    uiStateSchema,
} from '@sherpa/protocol';

/**
 * The store lives outside the React tree (spec §1/C3). State arrives over SSE, and React reads it
 * through `useSyncExternalStore`. Anything that fails the protocol schema never enters the store.
 */

export type ConnectionState =
    /** The connection has not delivered its first snapshot yet. */
    | 'connecting'
    /** A snapshot has arrived and the channel is alive. */
    | 'online'
    /** The channel broke and the browser reconnects itself. The last snapshot stays on screen. */
    | 'reconnecting'
    /** The server sent something the UI does not understand: the channel can no longer be trusted. */
    | 'fatal';

export interface StoreSnapshot {
    readonly connection: ConnectionState;
    readonly state: UiState | null;
    /** Fatal error text, set only in `fatal`. */
    readonly error: string | null;
    /**
     * Last reading progress revision from the channel (T8). null means no event has arrived yet.
     * When it exceeds the revision seen by the view, the view rereads the progress endpoint.
     */
    readonly progressRevision: number | null;
    /** Last thread revision. When it increases, the view rereads the thread snapshot. */
    readonly threadsRevision: number | null;
    /** Last route revision (M2). When it increases, the view rereads `review/route`. */
    readonly routeRevision: number | null;
}

export interface Store {
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => StoreSnapshot;
    close: () => void;
}

export interface StreamHandlers {
    readonly onMessage: (data: string) => void;
    /** `progress` event: carries only the revision. The view rereads the data through the endpoint. */
    readonly onProgress: (data: string) => void;
    /** `review` event: carries only the thread revision. */
    readonly onReview: (data: string) => void;
    /** `route` event: carries only the route revision. */
    readonly onRoute: (data: string) => void;
    /**
     * `recoverable: true` means the channel reconnects itself (the browser retries after a stream interruption).
     * `false` means the connection is permanently closed, so the store must retry.
     */
    readonly onError: (recoverable: boolean) => void;
}

export interface StreamConnection {
    readonly close: () => void;
}

export interface StoreOptions {
    readonly token: string;
    /** SSE connection. Replaced in tests, `EventSource` in the browser. */
    readonly connect?: (url: string, handlers: StreamHandlers) => StreamConnection;
    /** Delay before a store-initiated reconnection attempt. Defaults to `RECONNECT_DELAY_MS`. */
    readonly reconnectDelayMs?: number;
}

const INVALID_STATE_MESSAGE =
    'The server sent state this UI does not understand. Update Sherpa. The skill, server and UI are distributed together.';

/** Delay before a store-initiated reconnection attempt: the browser does not always retry (see `onError`). */
const RECONNECT_DELAY_MS = 2000;

export function createStore(options: StoreOptions): Store {
    const listeners = new Set<() => void>();
    let snapshot: StoreSnapshot = {
        connection: 'connecting',
        state: null,
        error: null,
        progressRevision: null,
        threadsRevision: null,
        routeRevision: null,
    };
    let closed = false;

    const update = (next: StoreSnapshot): void => {
        snapshot = next;
        for (const listener of [...listeners]) {
            listener();
        }
    };

    const connect = options.connect ?? connectEventSource;
    const reconnectDelayMs = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
    const url = `${UI_ENDPOINTS.events}?token=${encodeURIComponent(options.token)}`;

    let connection: StreamConnection | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const handlers: StreamHandlers = {
        onMessage: (data) => {
            if (closed || snapshot.connection === 'fatal') {
                return;
            }

            const state = parseState(data);
            if (state === null) {
                update({ ...snapshot, connection: 'fatal', error: INVALID_STATE_MESSAGE });
                // The channel is no longer a source of truth. Reconnecting to it makes no sense.
                connection?.close();
                return;
            }
            update({ ...snapshot, connection: 'online', state, error: null });
        },
        onProgress: (data) => {
            if (closed || snapshot.connection === 'fatal') {
                return;
            }
            // Fail-closed: anything that fails the schema never enters the store. The progress revision is not channel
            // state, so one malformed event is no reason to declare the channel dead.
            const revision = parseProgressRevision(data);
            if (revision !== null && revision !== snapshot.progressRevision) {
                update({ ...snapshot, progressRevision: revision });
            }
        },
        onReview: (data) => {
            if (closed || snapshot.connection === 'fatal') {
                return;
            }
            const revision = parseThreadsRevision(data);
            if (revision !== null && revision !== snapshot.threadsRevision) {
                update({ ...snapshot, threadsRevision: revision });
            }
        },
        onRoute: (data) => {
            if (closed || snapshot.connection === 'fatal') {
                return;
            }
            const revision = parseRouteRevision(data);
            if (revision !== null && revision !== snapshot.routeRevision) {
                update({ ...snapshot, routeRevision: revision });
            }
        },
        onError: (recoverable) => {
            if (closed || snapshot.connection === 'fatal') {
                return;
            }
            if (snapshot.connection !== 'reconnecting') {
                update({ ...snapshot, connection: 'reconnecting', error: null });
            }
            if (recoverable) {
                return;
            }

            // The connection is permanently closed (the server is not responding). Retry ourselves.
            connection?.close();
            retry = setTimeout(open, reconnectDelayMs);
        },
    };

    function open(): void {
        retry = null;
        if (closed) {
            return;
        }
        connection = connect(url, handlers);
    }

    open();

    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => snapshot,
        close: () => {
            closed = true;
            listeners.clear();
            if (retry !== null) {
                clearTimeout(retry);
                retry = null;
            }
            connection?.close();
        },
    };
}

/** `null` means the data failed the protocol schema (fail-closed). */
function parseState(data: string): UiState | null {
    let payload: unknown;
    try {
        payload = JSON.parse(data);
    } catch {
        return null;
    }

    const parsed = uiStateSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
}

/** `null` means the event failed the protocol schema (fail-closed). */
function parseProgressRevision(data: string): number | null {
    let payload: unknown;
    try {
        payload = JSON.parse(data);
    } catch {
        return null;
    }

    const parsed = uiProgressEventSchema.safeParse(payload);
    return parsed.success ? parsed.data.progressRevision : null;
}

/** `null` means the review event failed the protocol schema. */
function parseThreadsRevision(data: string): number | null {
    let payload: unknown;
    try {
        payload = JSON.parse(data);
    } catch {
        return null;
    }

    const parsed = uiReviewEventSchema.safeParse(payload);
    return parsed.success ? parsed.data.threadsRevision : null;
}

/** `null` means the route event failed the protocol schema. */
function parseRouteRevision(data: string): number | null {
    let payload: unknown;
    try {
        payload = JSON.parse(data);
    } catch {
        return null;
    }

    const parsed = uiRouteEventSchema.safeParse(payload);
    return parsed.success ? parsed.data.routeRevision : null;
}

function connectEventSource(url: string, handlers: StreamHandlers): StreamConnection {
    const source = new EventSource(url);
    // The event name is not in `EventSourceEventMap`, so the listener receives a base `Event`.
    source.addEventListener(UI_STATE_EVENT, (event) => {
        handlers.onMessage((event as MessageEvent<string>).data);
    });
    source.addEventListener(UI_PROGRESS_EVENT, (event) => {
        handlers.onProgress((event as MessageEvent<string>).data);
    });
    source.addEventListener(UI_REVIEW_EVENT, (event) => {
        handlers.onReview((event as MessageEvent<string>).data);
    });
    source.addEventListener(UI_ROUTE_EVENT, (event) => {
        handlers.onRoute((event as MessageEvent<string>).data);
    });
    source.addEventListener('error', () => {
        // The browser retries an interrupted established stream, but not a failed
        // connection attempt (server not running): its `readyState` goes straight to `CLOSED`.
        handlers.onError(source.readyState !== EventSource.CLOSED);
    });

    return {
        close: () => {
            source.close();
        },
    };
}
