import type { UiState } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { Store, StreamHandlers } from './store.js';
import { createStore } from './store.js';

const STATE: UiState = {
    prKey: 'github-quillmart--quillmart--1',
    reviewHost: 'github',
    // PR metadata has not arrived yet: the server fills its cache outside snapshot assembly.
    pr: null,
    worker: { kind: 'never' },
    feedback: { available: true, reason: null },
    iterations: [],
    update: null,
    generationCap: null,
    tasks: [
        {
            id: 1,
            type: 'echo',
            priority: 'interactive',
            status: 'queued',
            heldByWorker: false,
            attempt: 1,
            instructions: 'return text',
            progressText: null,
            result: null,
            failReason: null,
            createdAt: '2026-08-19T10:00:00.000Z',
            updatedAt: '2026-08-19T10:00:00.000Z',
        },
    ],
};

const PR_META: NonNullable<UiState['pr']> = {
    id: '4821',
    url: 'https://github.com/quillmart/quillmart/pull/4821',
    title: 'Order editing window',
    author: { login: 'alice', displayName: null, bot: false, avatarUrl: null },
    fromBranch: 'alice/edit-window',
    toBranch: 'main',
    state: 'open',
    statusLabel: 'review_in_progress',
    checks: 'passed',
    updatedAt: '2026-08-19T10:00:00.000Z',
    capabilities: { publishVerdicts: ['comment', 'ship', 'sticky_ship', 'request_changes'], fileViewedSync: true, fileContent: true, commentIssues: true, commentResolve: true, editPublished: true, iterations: false, blobs: false },
    verdicts: [],
    viewer: { login: 'alice', displayName: null, bot: false, avatarUrl: null },
};

interface Harness {
    readonly store: Store;
    readonly emit: (data: string) => void;
    /** `progress` event: reading progress revision. */
    readonly progress: (data: string) => void;
    /** `review` event: thread revision. */
    readonly review: (data: string) => void;
    /** `chat` event: chat and notes revision. */
    readonly chat: (data: string) => void;
    /** Channel interruption. `recoverable: false` means the connection is permanently closed. */
    readonly error: (recoverable?: boolean) => void;
    /** URL the store used to connect. */
    readonly url: string;
    readonly closed: () => number;
    readonly connects: () => number;
}

/** Manually controlled channel: tests send events through calls instead of the network. */
function makeStore(): Harness {
    let handlers: StreamHandlers | null = null;
    let url = '';
    let closes = 0;
    let connects = 0;

    const store = createStore({
        token: 'secret 1',
        reconnectDelayMs: 1000,
        connect: (streamUrl, streamHandlers) => {
            url = streamUrl;
            handlers = streamHandlers;
            connects += 1;
            return {
                close: () => {
                    closes += 1;
                },
            };
        },
    });

    return {
        store,
        emit: (data) => {
            handlers?.onMessage(data);
        },
        progress: (data) => {
            handlers?.onProgress(data);
        },
        review: (data) => {
            handlers?.onReview(data);
        },
        chat: (data) => {
            handlers?.onChat(data);
        },
        error: (recoverable = true) => {
            handlers?.onError(recoverable);
        },
        url,
        closed: () => closes,
        connects: () => connects,
    };
}

describe('UI store', () => {
    it('connects to the SSE endpoint with the token in the query', () => {
        const { url } = makeStore();

        expect(url).toBe(`${UI_ENDPOINTS.events}?token=${encodeURIComponent('secret 1')}`);
    });

    it('stays connecting without state until the first event', () => {
        const { store } = makeStore();

        expect(store.getSnapshot()).toEqual({
            connection: 'connecting',
            state: null,
            error: null,
            progressRevision: null,
            threadsRevision: null,
            routeRevision: null,
            chatRevision: null,
        });
    });

    it('a valid snapshot switches to online and notifies subscribers', () => {
        const { store, emit } = makeStore();
        let notifications = 0;
        store.subscribe(() => {
            notifications += 1;
        });

        emit(JSON.stringify(STATE));

        expect(notifications).toBe(1);
        expect(store.getSnapshot().connection).toBe('online');
        expect(store.getSnapshot().state).toEqual(STATE);
    });

    it('PR metadata from the snapshot reaches the store', () => {
        const { store, emit } = makeStore();
        emit(JSON.stringify(STATE));

        emit(JSON.stringify({ ...STATE, pr: PR_META }));

        expect(store.getSnapshot().state?.pr).toEqual(PR_META);
    });

    it('a progress event brings the revision without changing state', () => {
        const { store, emit, progress } = makeStore();
        emit(JSON.stringify(STATE));

        progress(JSON.stringify({ progressRevision: 3 }));

        expect(store.getSnapshot()).toMatchObject({ connection: 'online', progressRevision: 3, state: STATE });
    });

    it('a review event brings the thread revision without changing state', () => {
        const { store, emit, review } = makeStore();
        emit(JSON.stringify(STATE));

        review(JSON.stringify({ threadsRevision: 7 }));

        expect(store.getSnapshot()).toMatchObject({ connection: 'online', threadsRevision: 7, state: STATE });
    });

    it('a chat event brings the revision and triggers a reread only when it changes', () => {
        const { store, emit, chat } = makeStore();
        const listener = vi.fn();
        store.subscribe(listener);
        emit(JSON.stringify(STATE));

        chat(JSON.stringify({ chatRevision: 4 }));
        chat(JSON.stringify({ chatRevision: 4 }));

        expect(store.getSnapshot()).toMatchObject({ connection: 'online', chatRevision: 4, state: STATE });
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('ignores a malformed progress event and keeps the channel alive', () => {
        const { store, emit, progress, closed } = makeStore();
        emit(JSON.stringify(STATE));
        progress(JSON.stringify({ progressRevision: 3 }));

        progress(JSON.stringify({ progressRevision: 'three' }));
        progress('{not json');

        expect(store.getSnapshot()).toMatchObject({ connection: 'online', progressRevision: 3 });
        expect(closed()).toBe(0);
    });

    it('a snapshot that fails schema validation never enters the store and causes fatal', () => {
        const { store, emit, closed } = makeStore();
        emit(JSON.stringify(STATE));

        emit(JSON.stringify({ ...STATE, tasks: [{ id: 'two' }] }));

        const snapshot = store.getSnapshot();
        expect(snapshot.connection).toBe('fatal');
        expect(snapshot.state).toEqual(STATE);
        expect(snapshot.error).toContain('Update Sherpa');
        // The channel is closed. Reconnecting to a server the UI does not understand makes no sense.
        expect(closed()).toBe(1);
    });

    it('unreadable JSON also causes fatal', () => {
        const { store, emit } = makeStore();

        emit('{not json');

        expect(store.getSnapshot().connection).toBe('fatal');
    });

    it('a channel interruption switches to reconnecting with the last known state', () => {
        const { store, emit, error } = makeStore();
        emit(JSON.stringify(STATE));

        error();

        expect(store.getSnapshot().connection).toBe('reconnecting');
        expect(store.getSnapshot().state).toEqual(STATE);
    });

    it('reconnection restores online', () => {
        const { store, emit, error } = makeStore();
        emit(JSON.stringify(STATE));
        error();

        emit(JSON.stringify({ ...STATE, tasks: [] }));

        expect(store.getSnapshot().connection).toBe('online');
        expect(store.getSnapshot().state?.tasks).toEqual([]);
    });

    it('the store reconnects itself when the connection is permanently closed', () => {
        vi.useFakeTimers();
        try {
            const { store, error, connects } = makeStore();

            error(false);
            expect(store.getSnapshot().connection).toBe('reconnecting');
            expect(connects()).toBe(1);

            vi.advanceTimersByTime(1000);
            expect(connects()).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('the channel stays silent after fatal: neither errors nor events change state', () => {
        const { store, emit, error } = makeStore();
        emit('{not json');

        error();
        emit(JSON.stringify(STATE));

        expect(store.getSnapshot().connection).toBe('fatal');
        expect(store.getSnapshot().state).toBeNull();
    });

    it('close unsubscribes and closes the channel', () => {
        const { store, emit, closed } = makeStore();
        let notifications = 0;
        store.subscribe(() => {
            notifications += 1;
        });

        store.close();
        emit(JSON.stringify(STATE));

        expect(closed()).toBe(1);
        expect(notifications).toBe(0);
        expect(store.getSnapshot().connection).toBe('connecting');
    });
});
