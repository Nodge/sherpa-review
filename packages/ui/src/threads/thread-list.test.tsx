// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { Comment, CommentDraft, Thread } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ReadOnlyIterationProvider } from '../iterations/read-only.tsx';
import { ThreadPinProvider } from '../iterations/thread-pin.tsx';
import type { ThreadPinContextValue } from '../iterations/thread-pin.tsx';
import { composerControllerFor } from './composer.js';
import { openDraftEditor } from './draft-editor.tsx';
import { flattenThread } from './model.js';
import { createThreadStore } from './store.js';
import type { ThreadStore } from './store.js';
import { openReply, OutsideThreads, ThreadList } from './thread-list.tsx';

/**
 * Comment bodies render as Markdown. Bots write headings, lists,
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

const PUBLISHED = {
    setResolved: () => Promise.resolve(),
    update: () => Promise.resolve(),
    delete: () => Promise.resolve(),
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
    author: { login: 'alice', displayName: 'Alice Ingram', bot: false, avatarUrl: null },
    body: 'I will check the race again before Ship.',
    draft: true,
    issue: null,
    resolved: null,
    createdAt: '2026-08-24T10:00:00.000Z',
    editedAt: null,
    replies: [],
};

function render(threads: readonly Thread[], store = createThreadStore(threads, FILE_IDS)): string {
    return renderWithStore(threads, store);
}

function renderWithStore(threads: readonly Thread[], store: ThreadStore): string {
    return renderToStaticMarkup(
        <ThreadList
            threads={threads}
            store={store}
            actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
            now={NOW}
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

        expect(body).toContain('<h5 class="md-heading md-h5">PCI: unmasked PAN in retained logs</h5>');
        expect(body).toContain('<ul class="md-list">');
        expect(body).toContain('<strong class="md-strong">Severity:</strong>');
        expect(body).toContain('<code class="md-code">logs/checkout-*.jsonl</code>');
        expect(body).toContain('<pre class="md-pre" data-lang="ts">');
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
    it('offers no edit or delete action for a published comment by another author', () => {
        const thread = threadOf('kai');
        const html = renderWithStore([thread], createThreadStore([thread], FILE_IDS));

        expect(html).not.toContain('Edit');
        expect(html).not.toContain('Delete');
        expect(html).toContain('Reply');
        expect(html).toContain('Resolve');
    });

    it('allows editing and deleting your published comment only with editPublished', () => {
        const source = threadOf('kai');
        // The reviewer identity in PR metadata identifies your comments. The thread has no drafts.
        const mine: Thread = {
            ...source,
            root: { ...source.root, author: DRAFT.author, replies: [] },
        };
        const store = createThreadStore([mine], FILE_IDS);
        store.setViewer(DRAFT.author.login);
        const withEdit = renderToStaticMarkup(
            <ThreadList
                threads={[mine]}
                store={store}
                actions={{
                    transport: TRANSPORT,
                    resolve: () => Promise.resolve(true),
                    published: PUBLISHED,
                }}
                now={NOW}
            />,
        );
        expect(withEdit).toContain(`Edit comment ${mine.root.id}`);
        expect(withEdit).toContain(`Delete comment ${mine.root.id}`);

        expect(renderWithStore([mine], store)).not.toContain(`Edit comment ${mine.root.id}`);
    });

    it('keeps Edit but omits Delete for a message with replies', () => {
        const source = threadOf('kai');
        const reply = { ...source.root, id: 'reply-of-mine', author: source.root.author, replies: [] };
        const mine: Thread = {
            ...source,
            root: { ...source.root, author: DRAFT.author, replies: [reply] },
        };
        const store = createThreadStore([mine], FILE_IDS);
        store.setViewer(DRAFT.author.login);
        const html = renderToStaticMarkup(
            <ThreadList
                threads={[mine]}
                store={store}
                actions={{
                    transport: TRANSPORT,
                    resolve: () => Promise.resolve(true),
                    published: PUBLISHED,
                }}
                now={NOW}
            />,
        );
        expect(html).toContain(`Edit comment ${mine.root.id}`);
        expect(html).not.toContain(`Delete comment ${mine.root.id}`);
    });

    it('does not allow editing a published comment by another author', () => {
        const foreign = threadOf('kai');
        const store = createThreadStore([foreign], FILE_IDS);
        store.setViewer(DRAFT.author.login);

        const html = renderToStaticMarkup(
            <ThreadList
                threads={[foreign]}
                store={store}
                actions={{
                    transport: TRANSPORT,
                    resolve: () => Promise.resolve(true),
                    published: PUBLISHED,
                }}
                now={NOW}
            />,
        );

        expect(html).not.toContain(`Edit comment ${foreign.root.id}`);
        expect(html).not.toContain(`Delete comment ${foreign.root.id}`);
    });

    it('shows Resolve on every issue comment when the host supports comment-level resolution', () => {
        const source = threadOf('kai');
        const withIssue: Thread = {
            ...source,
            root: {
                ...source.root,
                issue: true,
                resolved: false,
                replies: [{ ...DRAFT, id: 'reply-issue', draft: false, issue: true, resolved: true }],
            },
        };
        const store = createThreadStore([withIssue], FILE_IDS);
        const html = renderToStaticMarkup(
            <ThreadList
                threads={[withIssue]}
                store={store}
                actions={{
                    transport: TRANSPORT,
                    resolve: () => Promise.resolve(true),
                    resolveComment: () => Promise.resolve(true),
                    published: PUBLISHED,
                }}
                now={NOW}
            />,
        );

        expect([...html.matchAll(/thread__resolve(?:"| is-on")/g)]).toHaveLength(2);
        expect(html).toContain('Resolved');
        // Without the capability, only the thread root has a button, which resolves the whole thread.
        const single = renderWithStore([withIssue], store);
        expect([...single.matchAll(/thread__resolve(?:"| is-on")/g)]).toHaveLength(1);
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
                    initialLayout="markdown"
                />,
            );
        });

        const edit = host.querySelector<HTMLButtonElement>('[aria-label="Edit draft line-draft"]');
        expect(host.querySelector('[aria-label="Delete draft line-draft"]')).not.toBeNull();
        expect(host.textContent).not.toContain('Resolve');
        expect(host.textContent).not.toContain('Copy link');
        act(() => {
            edit?.click();
        });

        const row = host.querySelector('.thread__row.is-editing');
        expect(row).not.toBeNull();
        expect(row?.querySelector('.thread__chip--editing')?.textContent).toBe('editing');
        expect(row?.querySelector('.thread-composer__markdown')).not.toBeNull();
        expect(host.querySelectorAll('.thread-composer')).toHaveLength(1);

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

    it('gives your draft edit and delete actions without published-comment actions', () => {
        const source = threadOf('kai');
        const draft: Thread = {
            ...source,
            root: { ...source.root, id: 'outside-draft', body: DRAFT.body, draft: true, replies: [] },
        };
        const html = renderWithStore([draft], createThreadStore([draft], FILE_IDS));

        expect(html).toContain('Edit draft outside-draft');
        expect(html).toContain('Delete draft outside-draft');
        expect(html).not.toContain('Resolve');
        expect(html).not.toContain('Reply<');
    });

    it('keeps resolve and reply actions for a published outside thread', () => {
        const thread = threadOf('kai');
        const html = renderWithStore([thread], createThreadStore([thread], FILE_IDS));

        expect(html).toContain('Resolve');
        expect(html).toContain('Reply');
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

    it('treats Esc in the confirmation as Cancel, keeps the thread expanded and deletes nothing', () => {
        const source = threadOf('kai');
        const draft: Thread = {
            ...source,
            root: { ...source.root, id: 'esc-draft', body: DRAFT.body, draft: true, replies: [] },
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
                    actions={{
                        transport: { ...TRANSPORT, delete: remove },
                        resolve: () => Promise.resolve(true),
                    }}
                    now={NOW}
                />,
            );
        });

        act(() => {
            host.querySelector<HTMLButtonElement>('[aria-label="Delete draft esc-draft"]')?.click();
        });
        expect(host.querySelector('.thread__delete-confirm')).not.toBeNull();

        act(() => {
            host.querySelector('.thread__delete-confirm')?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
            );
        });

        expect(host.querySelector('.thread__delete-confirm')).toBeNull();
        expect(host.querySelector('.thread')).not.toBeNull();
        expect(remove).not.toHaveBeenCalled();

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
    it('shows a reply draft in the outside context as a regular row with a pencil', () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const html = render([thread]);

        expect(html).toContain(`Edit draft ${DRAFT.id}`);
        expect(html).toContain(`Delete draft ${DRAFT.id}`);
        expect(html).toContain(DRAFT.body);
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
        expect(store.getComposer(`edit:${DRAFT.id}`)).not.toBeNull();
        expect(store.getComposer(`reply:${thread.id}`)).toBeNull();

        act(() => {
            openReply(store, thread, false, DRAFT);
        });
        expect(host.querySelectorAll('.thread-composer')).toHaveLength(1);
        expect(store.getComposer(`reply:${thread.id}`)).toBeNull();

        act(() => {
            root.unmount();
        });
        host.remove();
    });

    it('expands the composer under the message beside code and nests the reply when Reply is clicked', () => {
        const thread = threadOf('kai');
        const rows = flattenThread(thread.root);
        const first = rows[0]?.comment.id;
        const second = rows[1]?.comment.id;
        if (first === undefined || second === undefined) {
            throw new Error('the fixture thread needs a root and a reply');
        }
        const store = createThreadStore([thread], FILE_IDS);
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        const draw = (): void => {
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
        };
        draw();

        const replyUnder = (commentId: string): void => {
            act(() => {
                const row = host.querySelector(`.thread__row[data-comment-id="${commentId}"]`);
                [...(row?.querySelectorAll<HTMLButtonElement>('.thread__row-actions button') ?? [])]
                    .find((button) => button.textContent === 'Reply')
                    ?.click();
            });
            draw();
        };
        const composerRowId = (): string | null =>
            host.querySelector('.thread-composer')?.closest('.thread__row')?.getAttribute('data-comment-id') ?? null;

        replyUnder(first);
        expect(store.getComposer(`reply:${thread.id}`)?.parentId).toBe(first);
        expect(composerRowId()).toBe(first);

        // The same composer moves under another message along with the reply parent.
        replyUnder(second);
        expect(store.getComposer(`reply:${thread.id}`)?.parentId).toBe(second);
        expect(composerRowId()).toBe(second);
        expect(host.querySelectorAll('.thread-composer')).toHaveLength(1);

        act(() => {
            root.unmount();
        });
        host.remove();
    });

    it('does not move a saved reply draft to another parent', () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const store = createThreadStore([thread], FILE_IDS);

        openReply(store, thread, false, DRAFT);
        const before = store.getComposer(`reply:${thread.id}`);
        expect(before?.commentId).toBe(DRAFT.id);
        expect(before?.parentId).toBe(thread.root.id);

        openReply(store, thread, false, DRAFT, 'other-comment');

        expect(store.getComposer(`reply:${thread.id}`)?.parentId).toBe(thread.root.id);
        expect(store.getComposer(`reply:${thread.id}`)?.replyUnder).toBe(thread.root.id);
    });

    // The closed composer behaves the same. Reply under another message returns the draft
    // to its own location without attaching it to another parent.
    it('opens the saved draft in its own location when Reply is clicked under another message', () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const other = flattenThread(thread.root)[1]?.comment.id;
        if (other === undefined || other === DRAFT.id) {
            throw new Error('the fixture thread needs a reply besides the draft');
        }
        const store = createThreadStore([thread], FILE_IDS);

        openReply(store, thread, false, undefined, other);

        expect(store.getComposer(`reply:${thread.id}`)).toMatchObject({
            commentId: DRAFT.id,
            parentId: thread.root.id,
            replyUnder: thread.root.id,
        });
    });

    // The first save sends the parent to the host, and it cannot change later, so the composer
    // stays where it was saved from that point on.
    it('does not move the composer while the first reply save is in flight', async () => {
        const thread = threadOf('kai');
        const rows = flattenThread(thread.root);
        const first = rows[0]?.comment.id;
        const second = rows[1]?.comment.id;
        if (first === undefined || second === undefined) {
            throw new Error('the fixture thread needs a root and a reply');
        }
        const store = createThreadStore([thread], FILE_IDS);
        const key = `reply:${thread.id}`;
        const pending = deferred<{ outcome: 'saved'; comment: Comment }>();
        const save = vi.fn((_draft: CommentDraft, _clientKey: string) => pending.promise);

        openReply(store, thread, false, null, first);
        store.updateComposer(key, { text: 'Reply to the root.' });
        const saving = composerControllerFor({
            store,
            key,
            transport: { save, update: TRANSPORT.update, delete: TRANSPORT.delete },
        }).saveNow();

        openReply(store, thread, false, null, second);

        expect(store.getComposer(key)?.parentId).toBe(first);
        expect(store.getComposer(key)?.replyUnder).toBe(first);
        pending.resolve({ outcome: 'saved', comment: { ...DRAFT, id: 'saved-reply', body: 'Reply to the root.' } });
        await saving;
        expect(save.mock.calls[0]?.[0].parentId).toBe(first);
        expect(store.getComposer(key)?.parentId).toBe(first);
    });

    it('offers to save changes after opening', () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const store = createThreadStore([thread], FILE_IDS);
        openReply(store, thread, false, DRAFT);

        const html = renderWithStore([thread], store);

        expect(html).toContain('Save changes');
        expect(html).not.toContain(`Edit draft ${DRAFT.id}`);

        openDraftEditor(store, thread, DRAFT);
        expect(store.getComposer(`reply:${thread.id}`)).not.toBeNull();
        expect(store.getComposer(`edit:${DRAFT.id}`)).toBeNull();
    });

    it('closes the field after the first reply save and leaves a single draft card', async () => {
        const thread = threadOf('kai');
        const store = createThreadStore([thread], FILE_IDS);
        openReply(store, thread, false, null);
        store.updateComposer(`reply:${thread.id}`, { text: 'New reply.' });
        const save = vi.fn(() =>
            Promise.resolve({ outcome: 'saved' as const, comment: { ...DRAFT, id: 'new-draft-reply', body: 'New reply.' } }),
        );
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

        act(() => {
            root.unmount();
        });
        host.remove();
    });

    it('restores the original text on Cancel while editing a reply and does not delete the Comment', async () => {
        const source = threadOf('kai');
        const thread = { ...source, root: { ...source.root, replies: [...source.root.replies, DRAFT] } };
        const store = createThreadStore([thread], FILE_IDS);
        openReply(store, thread, false, DRAFT);
        store.updateComposer(`reply:${thread.id}`, { text: 'broken', status: 'idle' });
        const update = vi.fn(() => Promise.resolve({ outcome: 'saved' as const }));
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
        expect(host.querySelector('.thread__delete-confirm')?.textContent).toContain('Delete the draft?');
        expect(update).not.toHaveBeenCalled();

        await act(async () => {
            host.querySelector<HTMLButtonElement>('.thread-composer .thread__delete-confirm-button')?.click();
            await vi.waitFor(() => {
                expect(store.getComposer(`reply:${thread.id}`)).toBeNull();
            });
        });

        expect(update).toHaveBeenCalledWith(DRAFT.id, DRAFT.body, undefined, expect.any(String));
        expect(remove).not.toHaveBeenCalled();
        act(() => {
            root.unmount();
        });
        host.remove();
    });
});

/** Threads in a previous iteration are readable, but cannot send any writes. */
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
        expect(/<button[^>]*thread__resolve[^>]*disabled/.exec(html)).not.toBeNull();
        expect(html).toContain('aria-label="Edit draft draft-reply" disabled="" title="only in the active iteration"');
        expect(html).toContain('aria-label="Delete draft draft-reply" disabled="" title="only in the active iteration"');
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

    it('shows the pinned commit in the thread chip because the composer no longer has its own header', () => {
        const withDraft = {
            ...PINNED,
            root: { ...PINNED.root, replies: [...PINNED.root.replies, DRAFT] },
        };
        const store = createThreadStore([withDraft], FILE_IDS);
        openReply(store, withDraft, false, DRAFT);

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

        expect(html).toContain(`pinned to ${PIN_COMMIT.slice(0, 7)}`);
        expect(html).not.toContain('thread-composer__context');
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
