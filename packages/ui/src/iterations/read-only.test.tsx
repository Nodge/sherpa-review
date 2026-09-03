// @vitest-environment jsdom
import type { Thread } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { publishDisabledReason } from '../components/review-action-model.js';
import { createT } from '../i18n/index.js';
import { ViewedToggle } from '../components/viewed-toggle.tsx';
import type { ComposerTransport } from '../threads/composer.js';
import { createThreadStore } from '../threads/store.js';
import { NewCommentComposer, openPrComposer, ThreadList } from '../threads/thread-list.tsx';
import { READ_ONLY_REASON, ReadOnlyIterationProvider } from './read-only.tsx';

const t = createT('en');

/**
 * Read-only mode for a previous iteration: controls that write to the PR are disabled with the same
 * tooltip (M4 boundaries).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of mounted.splice(0)) {
        cleanup();
    }
});

function render(node: React.ReactNode, readOnly: boolean): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<ReadOnlyIterationProvider readOnly={readOnly}>{node}</ReadOnlyIterationProvider>);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

const TRANSPORT: ComposerTransport = {
    save: () => Promise.reject(new Error('the test does not save')),
    update: () => Promise.resolve({ outcome: 'saved' as const }),
    delete: () => Promise.resolve(),
};

const THREAD: Thread = {
    id: 't1',
    resolved: false,
    resolvedBy: null,
    outdated: false,
    pinnedTo: null,
    anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
    root: {
        id: 'c1',
        author: { login: 'avery', displayName: 'Avery', bot: false },
        body: 'question about the line',
        createdAt: '2026-08-31T06:00:00.000Z',
        editedAt: null,
        draft: false,
        issue: false,
        replies: [],
    },
};

describe('write controls in read-only mode', () => {
    it('the viewed toggle is disabled and explains why', () => {
        const host = render(<ViewedToggle viewed={false} className="file-card__viewed" onToggle={() => undefined} />, true);
        const toggle = host.querySelector<HTMLButtonElement>('.viewed-toggle');

        expect(toggle?.disabled).toBe(true);
        expect(toggle?.title).toBe(t(READ_ONLY_REASON));
    });

    it('the toggle works as before in the active iteration', () => {
        const host = render(
            <ViewedToggle viewed={false} className="file-card__viewed" title="0 of 3" onToggle={() => undefined} />,
            false,
        );
        const toggle = host.querySelector<HTMLButtonElement>('.viewed-toggle');

        expect(toggle?.disabled).toBe(false);
        expect(toggle?.title).toBe('0 of 3');
    });

    it('the comment composer cannot save or be edited', () => {
        const store = createThreadStore([], new Set(['f1']));
        openPrComposer(store, true);
        const host = render(
            <NewCommentComposer
                composerKey="new:pr"
                store={store}
                transport={TRANSPORT}
                initialLayout="markdown"
            />,
            true,
        );

        const save = host.querySelector<HTMLButtonElement>('.thread-composer__save');
        expect(save?.disabled).toBe(true);
        expect(save?.title).toBe(t(READ_ONLY_REASON));
        expect(host.querySelector<HTMLTextAreaElement>('.thread-composer__markdown')?.disabled).toBe(true);
    });

    it('thread replies are disabled while the thread remains readable', () => {
        const store = createThreadStore([THREAD], new Set(['f1']));
        const host = render(
            <ThreadList
                threads={[THREAD]}
                store={store}
                actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                now={Date.now()}
            />,
            true,
        );
        const entry = host.querySelector<HTMLButtonElement>('.thread-composer-entry');

        expect(host.textContent).toContain('question about the line');
        expect(entry?.disabled).toBe(true);
        expect(entry?.title).toBe(t(READ_ONLY_REASON));
    });

    it('resolving and reopening a thread are unavailable', () => {
        const store = createThreadStore([THREAD], new Set(['f1']));
        const host = render(
            <ThreadList
                threads={[THREAD]}
                store={store}
                actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                now={Date.now()}
            />,
            true,
        );
        const resolve = [...host.querySelectorAll<HTMLButtonElement>('.thread__actions button')].find(
            (button) => button.textContent === 'Resolve',
        );

        expect(resolve?.disabled).toBe(true);
        expect(resolve?.title).toBe(t(READ_ONLY_REASON));
    });

    it('retrying a failed send in the composer is also blocked', () => {
        const store = createThreadStore([], new Set(['f1']));
        openPrComposer(store, true);
        const composer = store.getComposer('new:pr');
        expect(composer).not.toBeNull();
        store.updateComposer('new:pr', { text: 'did not arrive', status: 'error' });
        const host = render(
            <NewCommentComposer
                composerKey="new:pr"
                store={store}
                transport={TRANSPORT}
                initialLayout="markdown"
            />,
            true,
        );
        const retry = [...host.querySelectorAll<HTMLButtonElement>('.thread-composer__status button')].find(
            (button) => button.textContent === 'retry',
        );

        expect(retry?.disabled).toBe(true);
        expect(retry?.title).toBe(t(READ_ONLY_REASON));
    });

    it('ship and publishing are disabled for the same reason', () => {
        expect(
            publishDisabledReason({
                t: createT('en'),
                connection: 'online',
                pendingComposer: false,
                publishing: false,
                readOnlyIteration: true,
            }),
        ).toBe(t(READ_ONLY_REASON));
        expect(
            publishDisabledReason({ t: createT('en'), connection: 'online', pendingComposer: false, publishing: false }),
        ).toBeNull();
    });
});
