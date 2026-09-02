// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { Comment, Thread } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ReadOnlyIterationProvider } from '../iterations/read-only.tsx';
import { ThreadPinProvider } from '../iterations/thread-pin.tsx';
import type { ThreadPinContextValue } from '../iterations/thread-pin.tsx';
import { openDraftEditor } from './draft-editor.tsx';
import { createThreadStore } from './store.js';
import type { ThreadStore } from './store.js';
import { openReply, OutsideThreads, ThreadList } from './thread-list.tsx';

/**
 * Comment bodies render as markdown (M2F-T5). Bots write headings, lists,
 * links and code blocks, and the thread card must render that markup instead of a raw string.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = fixtureIteration('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const NOW = Date.parse('2026-08-24T12:00:00.000Z');

const TRANSPORT = {
    save: () => Promise.reject(new Error('this test does not save')),
    update: () => Promise.reject(new Error('this test does not save')),
    delete: () => Promise.reject(new Error('this test does not save')),
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

const DRAFT: Comment = {
    id: 'draft-reply',
    author: { login: 'alice', displayName: 'Alice Ingram', bot: false },
    body: 'I will check the race again before Ship.',
    draft: true,
    issue: null,
    createdAt: '2026-08-24T10:00:00.000Z',
    editedAt: null,
    replies: [],
};

function render(threads: readonly Thread[], store = createThreadStore(threads, FILE_IDS)): string {
    return renderWithStore(threads, store);
}

function renderWithStore(threads: readonly Thread[], store: ThreadStore, inlineDraftEditing = false): string {
    return renderToStaticMarkup(
        <ThreadList
            threads={threads}
            store={store}
            actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
            now={NOW}
            inlineDraftEditing={inlineDraftEditing}
        />,
    );
}

function threadOf(login: string): Thread {
    const thread = DATA.threads.find((candidate) => candidate.root.author.login === login);
    if (thread === undefined) {
        throw new Error(`the medium fixture has no thread by ${login}`);
    }
    return thread;
}

describe('comment body', () => {
    it('renders bot markup as elements: heading, list, link, code block', () => {
        const html = render([threadOf('ai-review-bot')]);
        const body = html.slice(html.indexOf('thread__body'));

        expect(body).toContain('<p class="md-heading">PCI: unmasked PAN in retained logs</p>');
        expect(body).toContain('<ul class="md-list">');
        expect(body).toContain('<strong>Severity:</strong>');
        expect(body).toContain('<code class="md-code">logs/checkout-*.jsonl</code>');
        expect(body).toContain('<pre class="md-pre">');
        // A bare URL opens a link in a new tab without a referrer.
        expect(body).toContain('target="_blank" rel="noreferrer"');
        expect(body).not.toContain('`');
    });

    it('renders a bracketed link as a link instead of text', () => {
        const body = render([threadOf('lint-bot')]);

        expect(body).toContain(
            '<a class="md-link" href="https://eslint.org/docs/latest/rules/no-fallthrough" target="_blank" rel="noreferrer">no-fallthrough</a>',
        );
    });

    it('keeps plain human text in a single paragraph', () => {
        const body = render([threadOf('kai')]);

        expect(body).toContain('<p class="md-p">Why is the window a class');
        expect(body).toContain('<code class="md-code">Clock</code>');
    });
});

describe('range comment', () => {
    it('shows the range in thread metadata', () => {
        const source = threadOf('kai');
        if (source.anchor?.position == null) {
            throw new Error('the thread has no position');
        }
        const ranged: Thread = {
            ...source,
            anchor: { ...source.anchor, position: { ...source.anchor.position, size: 3 } },
        };
        const html = render([ranged]);
        const last = source.anchor.position.line + 2;

        expect(html).toContain(`:${String(source.anchor.position.line)}–${String(last)} ·`);
    });
});

describe('editing a line comment', () => {
    it('does not show an edit pencil on a published comment by another author', () => {
        const thread = threadOf('kai');
        const html = renderWithStore([thread], createThreadStore([thread], FILE_IDS), true);

        expect(html).not.toContain('Edit the draft');
        expect(html).toContain('Reply…');
        expect(html).toContain('Resolve');
        expect(html).not.toContain('Copy link');
    });

    it('edits your draft in place with a blue border and chip', () => {
        const source = threadOf('kai');
        const draft: Thread = {
            ...source,
            root: { ...source.root, id: 'line-draft', body: DRAFT.body, draft: true, replies: [] },
        };
        const store = createThreadStore([draft], FILE_IDS);
        const host = document.createElement('div');
        document.body.append(host);
        let root = createRoot(host);
        act(() => {
            root.render(
                <ThreadList
                    threads={[draft]}
                    store={store}
                    actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                    inlineDraftEditing
                    initialLayout="markdown"
                />,
            );
        });

        const edit = host.querySelector<HTMLButtonElement>('[aria-label="Edit draft line-draft"]');
        expect(host.querySelector('[aria-label="Delete draft line-draft"]')).not.toBeNull();
        expect(host.textContent).not.toContain('Resolve');
        expect(host.textContent).not.toContain('Copy link');
        expect(host.querySelector('.thread-composer-entry')).toBeNull();
        act(() => {
            edit?.click();
        });

        const row = host.querySelector('.thread__row.is-editing');
        expect(row).not.toBeNull();
        expect(row?.querySelector('.thread__chip--editing')?.textContent).toBe('editing');
        expect(row?.querySelector('.thread-composer__markdown')).not.toBeNull();
        expect(host.querySelectorAll('.thread-composer')).toHaveLength(1);
        expect(host.querySelector('.thread-composer-draft-preview')).toBeNull();
        expect(host.querySelector('.thread-composer-entry')).toBeNull();

        act(() => {
            root.unmount();
        });
        expect(store.getComposer('edit:line-draft')).not.toBeNull();

        root = createRoot(host);
        act(() => {
            root.render(
                <ThreadList
                    threads={[draft]}
                    store={store}
                    actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                    inlineDraftEditing
                    initialLayout="markdown"
                />,
            );
        });
        expect(host.querySelector('.thread__row.is-editing .thread-composer__markdown')).not.toBeNull();

        act(() => {
            store.closeComposer('edit:line-draft');
        });
        expect(host.querySelector('.thread__row.is-editing')).toBeNull();
        expect(host.querySelector('.thread__chip--editing')).toBeNull();
        expect(host.querySelector('.thread__body')?.textContent).toContain(DRAFT.body);

        act(() => {
            root.unmount();
        });
        host.remove();
    });

    it('a draft outside the diff flow gets edit and delete buttons without published-comment actions', () => {
        const source = threadOf('kai');
        const draft: Thread = {
            ...source,
            root: { ...source.root, id: 'outside-draft', body: DRAFT.body, draft: true, replies: [] },
        };
        const html = renderWithStore([draft], createThreadStore([draft], FILE_IDS));

        expect(html).toContain('Edit draft outside-draft');
        expect(html).toContain('Delete draft outside-draft');
        expect(html).not.toContain('Resolve');
        expect(html).not.toContain('Copy link');
        expect(html).not.toContain('Reply…');
    });

    it('a published outside thread keeps resolve, link and reply actions', () => {
        const thread = threadOf('kai');
        const html = renderWithStore([thread], createThreadStore([thread], FILE_IDS));

        expect(html).toContain('Resolve');
        expect(html).toContain('Copy link');
        expect(html).toContain('Reply…');
        expect(html).not.toContain('Delete the draft');
    });

    it('deletes a draft through the trash button only after confirmation inside the card', async () => {
        const source = threadOf('kai');
        const draft: Thread = {
            ...source,
            root: { ...source.root, id: 'line-draft', body: DRAFT.body, draft: true, replies: [] },
        };
        const store = createThreadStore([draft], FILE_IDS);
        const remove = vi.fn(() => Promise.resolve());
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ThreadList
                    threads={[draft]}
                    store={store}
                    actions={{ transport: { save: TRANSPORT.save, update: TRANSPORT.update, delete: remove }, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                    inlineDraftEditing
                />,
            );
        });

        act(() => {
            host.querySelector<HTMLButtonElement>('[aria-label="Delete draft line-draft"]')?.click();
        });
        expect(host.querySelector('.thread__delete-confirm')?.textContent).toContain('Delete the draft?');
        expect(remove).not.toHaveBeenCalled();

        await act(async () => {
            const confirm = [...host.querySelectorAll<HTMLButtonElement>('.thread__delete-confirm button')].find(
                (button) => button.textContent === 'Delete',
            );
            confirm?.click();
            await vi.waitFor(() => {
                expect(store.getSnapshot().threads).toHaveLength(0);
            });
        });
        expect(remove).toHaveBeenCalledWith('line-draft');

        act(() => {
            root.unmount();
        });
        host.remove();
    });

    it('deletes a draft through the trash button only after confirmation in a row inside the card', async () => {
        const source = threadOf('kai');
        const draft: Thread = {
            ...source,
            id: 'outside-draft-thread',
            root: { ...source.root, id: 'outside-draft', body: DRAFT.body, draft: true, replies: [] },
        };
        const store = createThreadStore([draft], FILE_IDS);
        const pendingDelete = deferred<undefined>();
        const remove = vi.fn(() => pendingDelete.promise);
        store.openComposer({
            key: 'stale:outside-draft',
            threadId: draft.id,
            parentId: null,
            anchor: null,
            text: DRAFT.body,
            originalText: DRAFT.body,
            commentId: 'outside-draft',
            status: 'saved',
            saveUncertain: false,
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ThreadList
                    threads={[draft]}
                    store={store}
                    actions={{ transport: { ...TRANSPORT, delete: remove }, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                />,
            );
        });

        act(() => {
            host.querySelector<HTMLButtonElement>('[aria-label="Delete draft outside-draft"]')?.click();
        });
        expect(host.querySelector('.thread__delete-confirm')?.textContent).toContain(
            'Delete the draft? It will not be published',
        );
        expect(remove).not.toHaveBeenCalled();

        act(() => {
            host.querySelector<HTMLButtonElement>('.thread__delete-confirm-button')?.click();
        });
        expect(remove).toHaveBeenCalledWith('outside-draft');
        expect(store.getComposerGuardSnapshot().pending).toBe(true);
        expect(store.getComposer('stale:outside-draft')).not.toBeNull();

        await act(async () => {
            pendingDelete.resolve(undefined);
            await vi.waitFor(() => {
                expect(store.getSnapshot().threads.some((thread) => thread.root.id === 'outside-draft')).toBe(false);
            });
        });
        expect(store.getComposerGuardSnapshot().pending).toBe(false);
        expect(store.getComposer('stale:outside-draft')).toBeNull();
        expect(host.querySelector('.thread__delete-confirm')).toBeNull();

        act(() => {
            root.unmount();
        });
        host.remove();
    });
});

describe('reply draft', () => {
    it('shows a card with an edit button and no second preview in an outside context', () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const html = render([thread]);

        expect(html).toContain(`Edit draft ${DRAFT.id}`);
        expect(html).toContain(`Delete draft ${DRAFT.id}`);
        expect(html).toContain(DRAFT.body);
        expect(html).not.toContain('thread-composer-draft-preview');
        expect(html).not.toContain('Continue the draft');
    });

    it('opens exactly one editor for an outside reply draft through its pencil', () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const store = createThreadStore([thread], FILE_IDS);
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ThreadList
                    threads={[thread]}
                    store={store}
                    actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                    initialLayout="markdown"
                />,
            );
        });

        act(() => {
            host.querySelector<HTMLButtonElement>(`[aria-label="Edit draft ${DRAFT.id}"]`)?.click();
        });

        expect(host.querySelectorAll('.thread-composer')).toHaveLength(1);
        expect(host.querySelector('.thread-composer-draft-preview')).toBeNull();
        expect(store.getComposer(`edit:${DRAFT.id}`)).not.toBeNull();
        expect(store.getComposer(`reply:${thread.id}`)).toBeNull();

        act(() => {
            openReply(store, thread, DRAFT);
        });
        expect(host.querySelectorAll('.thread-composer')).toHaveLength(1);
        expect(store.getComposer(`reply:${thread.id}`)).toBeNull();

        act(() => {
            root.unmount();
        });
        host.remove();
    });

    it('offers to save changes after opening', () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const store = createThreadStore([thread], FILE_IDS);
        openReply(store, thread, DRAFT);

        const html = renderWithStore([thread], store);

        expect(html).toContain('Save changes');
        expect(html).not.toContain('thread-composer-draft-preview');
        expect(html).not.toContain(`Edit draft ${DRAFT.id}`);

        openDraftEditor(store, thread, DRAFT);
        expect(store.getComposer(`reply:${thread.id}`)).not.toBeNull();
        expect(store.getComposer(`edit:${DRAFT.id}`)).toBeNull();
    });

    it('closes the field after the first reply save and leaves a single draft card', async () => {
        const thread = threadOf('kai');
        const store = createThreadStore([thread], FILE_IDS);
        openReply(store, thread, null);
        store.updateComposer(`reply:${thread.id}`, { text: 'New reply.' });
        const save = vi.fn(() => Promise.resolve({ ...DRAFT, id: 'new-draft-reply', body: 'New reply.' }));
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ThreadList
                    threads={[thread]}
                    store={store}
                    actions={{ transport: { save, update: TRANSPORT.update, delete: TRANSPORT.delete }, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                    initialLayout="markdown"
                />,
            );
        });

        await act(async () => {
            host.querySelector<HTMLButtonElement>('.thread-composer__save')?.click();
            await vi.waitFor(() => {
                expect(store.getComposer(`reply:${thread.id}`)).toBeNull();
            });
        });

        expect(save).toHaveBeenCalledOnce();
        act(() => {
            root.render(
                <ThreadList
                    threads={store.getSnapshot().threads}
                    store={store}
                    actions={{ transport: { save, update: TRANSPORT.update, delete: TRANSPORT.delete }, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                    initialLayout="markdown"
                />,
            );
        });
        expect(host.querySelectorAll('.thread-composer')).toHaveLength(0);
        expect(host.querySelectorAll('[aria-label="Edit draft new-draft-reply"]')).toHaveLength(1);
        expect(host.querySelector('.thread-composer-draft-preview')).toBeNull();

        act(() => {
            root.unmount();
        });
        host.remove();
    });

    it('restores the original text on Cancel while editing a reply and does not delete the Comment', async () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const store = createThreadStore([thread], FILE_IDS);
        openReply(store, thread, DRAFT);
        store.updateComposer(`reply:${thread.id}`, { text: 'broken', status: 'idle' });
        const update = vi.fn(() => Promise.resolve());
        const remove = vi.fn(() => Promise.resolve());
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ThreadList
                    threads={[thread]}
                    store={store}
                    actions={{ transport: { save: TRANSPORT.save, update, delete: remove }, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                    initialLayout="markdown"
                />,
            );
        });
        const cancel = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
            (button) => button.textContent === 'Cancel',
        );

        act(() => {
            cancel?.click();
        });
        expect(host.querySelector('.thread-composer__confirm')?.textContent).toContain('Discard this draft?');
        expect(update).not.toHaveBeenCalled();

        await act(async () => {
            [...host.querySelectorAll<HTMLButtonElement>('.thread-composer__confirm button')]
                .find((button) => button.textContent === 'discard')
                ?.click();
            await vi.waitFor(() => {
                expect(store.getComposer(`reply:${thread.id}`)).toBeNull();
            });
        });

        expect(update).toHaveBeenCalledWith(DRAFT.id, DRAFT.body);
        expect(remove).not.toHaveBeenCalled();
        act(() => {
            root.unmount();
        });
        host.remove();
    });
});

/** M4 boundaries: a previous iteration's thread can be read, but cannot send any writes. */
describe('read-only thread', () => {
    it('disables Resolve, draft editing and draft deletion with the same reason', () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const html = renderToStaticMarkup(
            <ReadOnlyIterationProvider readOnly>
                <ThreadList
                    threads={[thread]}
                    store={createThreadStore([thread], FILE_IDS)}
                    actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                />
            </ReadOnlyIterationProvider>,
        );

        expect(html).toContain('title="only in the active iteration"');
        expect(/<button[^>]*disabled[^>]*>Resolve<\/button>/.exec(html)).not.toBeNull();
        expect(html).toContain('class="thread__edit-draft" aria-label="Edit draft draft-reply" title="only in the active iteration" disabled=""');
        expect(html).toContain('class="thread__delete-draft" aria-label="Delete draft draft-reply" title="only in the active iteration" disabled=""');
    });
});

describe('thread pinned to a previous commit', () => {
    const V2 = fixtureIteration('medium', 1);
    const PINNED = (() => {
        const thread = V2.threads.find((candidate) => candidate.outdated && candidate.pinnedTo !== null);
        if (thread?.pinnedTo == null) {
            throw new Error('the medium fixture needs an outdated pinned thread');
        }
        return thread;
    })();
    const ACTIVE_DIFF_ID = V2.diff.diffId;
    const PIN_COMMIT = PINNED.pinnedTo?.commit ?? '';

    function renderPinned(thread: Thread, pin: Partial<ThreadPinContextValue> = {}): string {
        return renderToStaticMarkup(
            <ThreadPinProvider
                value={{
                    activeDiffId: ACTIVE_DIFF_ID,
                    viewingDiffId: ACTIVE_DIFF_ID,
                    openAtPin: () => undefined,
                    ...pin,
                }}
            >
                <ThreadList
                    threads={[thread]}
                    store={createThreadStore([thread], FILE_IDS)}
                    actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                />
            </ThreadPinProvider>,
        );
    }

    it('shows the chip and action when the pin differs from the active iteration', () => {
        const html = renderPinned(PINNED);

        expect(html).toContain(`pinned to ${PIN_COMMIT.slice(0, 7)}`);
        expect(html).toContain(`title="${PIN_COMMIT}"`);
        expect(html).toContain('View at the old commit');
    });

    it('shows neither chip nor action when the pin matches the active iteration', () => {
        const html = renderPinned(PINNED, { activeDiffId: PINNED.pinnedTo?.diffId ?? null });

        expect(html).not.toContain('pinned to');
        expect(html).not.toContain('View at the old commit');
    });

    it('has nothing to show when pinnedTo === null because the host does not know the anchor iteration', () => {
        const html = renderPinned({ ...PINNED, pinnedTo: null });

        expect(html).not.toContain('pinned to');
        expect(html).not.toContain('View at the old commit');
    });

    it('cannot compare when the active iteration is unknown', () => {
        const html = renderPinned(PINNED, { activeDiffId: null });

        expect(html).not.toContain('pinned to');
    });

    it('keeps the chip without navigation when already viewing the pinned iteration', () => {
        const html = renderPinned(PINNED, { viewingDiffId: PINNED.pinnedTo?.diffId ?? null });

        expect(html).toContain('pinned to');
        expect(html).not.toContain('View at the old commit');
    });

    it('opens the thread on its pinned iteration when the action is clicked', () => {
        const openAtPin = vi.fn();
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ThreadPinProvider value={{ activeDiffId: ACTIVE_DIFF_ID, viewingDiffId: ACTIVE_DIFF_ID, openAtPin }}>
                    <ThreadList
                        threads={[PINNED]}
                        store={createThreadStore([PINNED], FILE_IDS)}
                        actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                        now={NOW}
                    />
                </ThreadPinProvider>,
            );
        });

        const action = host.querySelector<HTMLButtonElement>('.thread__pin-action');
        act(() => {
            action?.click();
        });

        expect(openAtPin).toHaveBeenCalledWith(PINNED.pinnedTo?.diffId, PINNED.id);

        act(() => {
            root.unmount();
        });
        host.remove();
    });

    it('names removed files and offers the same action when every thread in the group has an anchor', () => {
        const html = renderToStaticMarkup(
            <ThreadPinProvider
                value={{ activeDiffId: ACTIVE_DIFF_ID, viewingDiffId: ACTIVE_DIFF_ID, openAtPin: () => undefined }}
            >
                <OutsideThreads
                    threads={[PINNED]}
                    store={createThreadStore([PINNED], FILE_IDS)}
                    actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                    defaultOpen
                />
            </ThreadPinProvider>,
        );

        expect(html).toContain('1 thread on files no longer in this PR');
        expect(html).toContain('View at the old commit');
    });

    it('the draft composer in a pinned thread names its commit instead of showing the generic chip', () => {
        const withDraft = {
            ...PINNED,
            root: { ...PINNED.root, replies: [...PINNED.root.replies, DRAFT] },
        };
        const store = createThreadStore([withDraft], FILE_IDS);
        openReply(store, withDraft, DRAFT);

        const html = renderToStaticMarkup(
            <ThreadPinProvider
                value={{ activeDiffId: ACTIVE_DIFF_ID, viewingDiffId: ACTIVE_DIFF_ID, openAtPin: () => undefined }}
            >
                <ThreadList
                    threads={[withDraft]}
                    store={store}
                    actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                    now={NOW}
                />
            </ThreadPinProvider>,
        );

        expect(html).toContain(`draft · pinned to ${PIN_COMMIT.slice(0, 7)}`);
        expect(html).not.toContain('draft · publishes on ship');
    });

    it('keeps the group heading about the diff when it includes a PR-level bot', () => {
        const bot = V2.threads.find((thread) => thread.anchor === null && thread.root.author.bot) ?? {
            ...PINNED,
            anchor: null,
        };
        const html = renderToStaticMarkup(
            <OutsideThreads
                threads={[bot, PINNED]}
                store={createThreadStore([bot, PINNED], FILE_IDS)}
                actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                now={NOW}
            />,
        );

        expect(html).toContain('2 threads outside the diff');
    });
});
