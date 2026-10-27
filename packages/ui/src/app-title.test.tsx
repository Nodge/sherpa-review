// @vitest-environment jsdom
import type { PrMeta, UiState } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './app.tsx';
import { createSessionStore } from './session/session-store.js';
import type { Store, StoreSnapshot } from './store.js';

/**
 * The browser tab title identifies the PR (#37). It uses the number from the key until metadata arrives, then the PR title.
 * The store deliberately has no review host because the test checks the title effect, not data loading.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PR: PrMeta = {
    id: '4821',
    url: 'https://github.com/quillmart/quillmart/pull/4821',
    title: 'Order editing window',
    author: { login: 'alice', displayName: null, bot: false, avatarUrl: null },
    fromBranch: 'alice/edit-window',
    toBranch: 'main',
    state: 'open',
    statusLabel: 'review_in_progress',
    checks: 'passed',
    updatedAt: '2026-08-24T06:00:00.000Z',
    capabilities: { publishVerdicts: ['comment', 'ship', 'sticky_ship', 'request_changes'], fileViewedSync: true, fileContent: true, commentIssues: true, commentResolve: true, editPublished: true, iterations: false, blobs: false },
    verdicts: [],
    viewer: { login: 'alice', displayName: null, bot: false, avatarUrl: null },
};

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function uiState(pr: PrMeta | null): UiState {
    return {
        prKey: 'fixture-4821',
        worker: { kind: 'never' },
        tasks: [],
        reviewHost: null,
        pr,
        feedback: { kind: 'issues', available: false, reason: 'The test feedback channel is unavailable.', discussionUrl: null },
        iterations: [],
        update: null,
        generationCap: null,
    };
}

/** A store with manually replaced snapshots. PR metadata arrives in the second snapshot, as over SSE. */
function fakeStore(initial: StoreSnapshot): Store & { readonly push: (next: StoreSnapshot) => void } {
    let snapshot = initial;
    const listeners = new Set<() => void>();
    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getSnapshot: () => snapshot,
        close: () => undefined,
        push: (next) => {
            snapshot = next;
            for (const listener of listeners) {
                listener();
            }
        },
    };
}

function snapshot(state: UiState | null): StoreSnapshot {
    return {
        connection: state === null ? 'connecting' : 'online',
        state,
        error: null,
        progressRevision: null,
        threadsRevision: null,
        routeRevision: null,
        chatRevision: null,
    };
}

function mount(store: Store): void {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const session = createSessionStore({ initial: { view: 'overview', filter: 'all' } });

    act(() => {
        root.render(<App store={store} session={session} token="t-1" />);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
}

describe('browser tab title', () => {
    it('keeps the title from index.html until a snapshot arrives', () => {
        document.title = 'Sherpa';
        mount(fakeStore(snapshot(null)));

        expect(document.title).toBe('Sherpa');
    });

    it('uses the PR number from the key without metadata, then the PR title when metadata arrives', () => {
        document.title = 'Sherpa';
        const store = fakeStore(snapshot(uiState(null)));
        mount(store);

        expect(document.title).toBe('PR 4821 · Sherpa');

        act(() => {
            store.push(snapshot(uiState(PR)));
        });

        expect(document.title).toBe('Order editing window · Sherpa');
    });
});
