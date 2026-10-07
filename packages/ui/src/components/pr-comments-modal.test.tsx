// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { Comment, DraftBufferEntry, Thread } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ComposerTransport } from '../threads/composer.js';
import { SettingsProvider } from '../settings/context.tsx';
import { createUiSettingsStore } from '../settings/settings-store.js';
import { ShortcutsProvider } from '../shortcuts/context.tsx';
import { attachShortcuts, createShortcutRegistry } from '../shortcuts/registry.js';
import { PR_COMPOSER_KEY, replyComposerKey } from '../threads/thread-list.tsx';
import type { ThreadStore } from '../threads/store.js';
import { createThreadStore } from '../threads/store.js';
import { PrCommentsModal } from './pr-comments-modal.tsx';

/**
 * "PR comments" modal (docs/design/SPEC-changes-2026-09-20.md §4). PR threads
 * as cards, a collapsed row with a preview, and inline replies. Message anatomy and actions
 * are shared with code threads and tested in `threads/thread-list.test.tsx`.
 */

const DATA = fixtureIteration('medium');
const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const HUMAN = { login: 'alice', displayName: 'Alice Ingram', bot: false, avatarUrl: null } as const;
const BOT = { login: 'ai-review-bot', displayName: 'AI Review', bot: true, avatarUrl: null } as const;
const PUBLISHED = thread({
    id: 'pr-published',
    author: HUMAN,
    body: 'Published **PR-level** comment.',
    draft: false,
    createdAt: '2026-08-31T10:00:00.000Z',
    replies: [
        comment({
            id: 'pr-published-reply',
            author: HUMAN,
            body: 'Reply in a published thread.',
            draft: false,
            createdAt: '2026-08-31T10:30:00.000Z',
        }),
    ],
});
const DRAFT = thread({
    id: 'pr-draft',
    author: HUMAN,
    body: 'My PR draft.',
    draft: true,
    createdAt: '2026-08-31T11:00:00.000Z',
});
const BOT_PR = thread({
    id: 'pr-bot',
    author: BOT,
    body: 'PR-level bot thread.',
    draft: false,
    createdAt: '2026-08-31T09:00:00.000Z',
});
const RESOLVED = thread({
    id: 'pr-resolved',
    author: HUMAN,
    body: 'Resolved PR remark.',
    draft: false,
    createdAt: '2026-08-31T08:30:00.000Z',
    resolved: true,
    replies: [
        comment({
            id: 'pr-resolved-reply',
            author: HUMAN,
            body: 'Fixed.',
            draft: false,
            createdAt: '2026-08-31T08:40:00.000Z',
        }),
    ],
});
const DISAPPEARED = thread({
    id: 'disappeared',
    author: HUMAN,
    body: 'Thread for a missing file.',
    draft: false,
    createdAt: '2026-08-31T08:00:00.000Z',
    anchor: { fileId: 'missing-file', path: 'removed.ts', position: null },
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom cannot scroll. The modal scrolls to the discard prompt, its only scrolling call.
const scrollIntoView = vi.fn();
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    document.body.style.overflow = '';
});

const BUFFERED_PR: DraftBufferEntry = {
    id: 'ck-pr',
    draft: { body: 'PR comment waiting for a connection.', parentId: null, anchor: null },
    commentId: null,
    state: 'failed',
    error: 'review host: 502',
    attempts: 1,
    createdAt: '2026-08-31T11:30:00.000Z',
    updatedAt: '2026-08-31T11:30:00.000Z',
};

describe('PR comments modal', () => {
    it('shows all PR-level threads newest first, with replies and without file threads', () => {
        mountModal([PUBLISHED, DRAFT, BOT_PR, DISAPPEARED]);

        expect(threadIds()).toEqual([DRAFT.id, PUBLISHED.id, BOT_PR.id]);
        expect(document.body.textContent).toContain('My PR draft.');
        expect(document.body.textContent).toContain('PR-level bot thread.');
        // Replies are visible without a click. Threads outside the diff are short (§4, checklist §7.9).
        expect(document.body.textContent).toContain('Reply in a published thread.');
        expect(document.body.textContent).not.toContain('Thread for a missing file.');
        expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
        expect(document.body.style.overflow).toBe('hidden');
    });

    // The header gives all its space to the title, with no draft counter or "collapse all" (§6a).
    it('has no draft counter or unresolved summary in the header', () => {
        mountModal([PUBLISHED, DRAFT], {}, () => undefined, [BUFFERED_PR]);

        const header = document.querySelector('.pr-comments-modal__header')?.textContent ?? '';
        expect(header).toBe('Comments on the PRoutside the diff · 4821');
        expect(document.querySelector('.pr-comments-modal__draft-count')).toBeNull();
        expect(document.querySelector('.pr-comments-modal__open-threads')).toBeNull();
    });

    it('expands drafts and bots and collapses resolved threads into a preview row', () => {
        mountModal([PUBLISHED, DRAFT, BOT_PR, RESOLVED]);

        expect(collapsedIds()).toEqual([RESOLVED.id]);
        const row = threadNode(RESOLVED.id);
        expect(row?.querySelector('.thread__preview')?.textContent).toBe('Resolved PR remark.');
        expect(row?.querySelector('.thread__reply-count')?.textContent).toBe('1 reply');
        expect(row?.textContent).not.toContain('Fixed.');
        expect(row?.querySelector('.thread__chevron')?.getAttribute('aria-expanded')).toBe('false');
    });

    it('expands and collapses threads through the chevron or preview click', () => {
        mountModal([RESOLVED, PUBLISHED]);

        act(() => {
            threadNode(RESOLVED.id)?.querySelector<HTMLButtonElement>('.thread__preview')?.click();
        });
        expect(collapsedIds()).toEqual([]);
        expect(threadNode(RESOLVED.id)?.textContent).toContain('Fixed.');

        act(() => {
            threadNode(RESOLVED.id)?.querySelector<HTMLButtonElement>('.thread__chevron')?.click();
        });
        expect(collapsedIds()).toEqual([RESOLVED.id]);
    });

    it('opens a reply composer with the issue switch below its message when "Reply" is clicked', () => {
        mountModal([PUBLISHED]);

        const rows = [...(threadNode(PUBLISHED.id)?.querySelectorAll('.thread__row') ?? [])];
        act(() => {
            action(rows[1], 'Reply')?.click();
        });

        const composer = rows[1]?.querySelector('.thread-composer');
        expect(composer).not.toBeNull();
        expect(rows[0]?.querySelector('.thread-composer')).toBeNull();
        expect(composer?.querySelector('[role="switch"]')?.getAttribute('aria-label')).toBe(
            'Open an issue, on',
        );
        // An inline reply needs no context heading because the message above it is already visible.
        expect(composer?.querySelector('.thread-composer__context')).toBeNull();
    });

    it('closes an empty reply composer on the first chevron click and collapses the thread on the next', async () => {
        mountModal([PUBLISHED]);

        act(() => {
            action(threadNode(PUBLISHED.id)?.querySelector('.thread__row'), 'Reply')?.click();
        });
        await act(async () => {
            threadNode(PUBLISHED.id)?.querySelector<HTMLButtonElement>('.thread__chevron')?.click();
            await Promise.resolve();
        });

        expect(threadNode(PUBLISHED.id)?.querySelector('.thread-composer')).toBeNull();
        expect(collapsedIds()).toEqual([]);

        act(() => {
            threadNode(PUBLISHED.id)?.querySelector<HTMLButtonElement>('.thread__chevron')?.click();
        });
        expect(collapsedIds()).toEqual([PUBLISHED.id]);
    });

    it('asks to discard a typed reply instead of hiding it in a collapsed row on a chevron click', async () => {
        const { store } = mountModal([PUBLISHED]);

        const rows = [...(threadNode(PUBLISHED.id)?.querySelectorAll('.thread__row') ?? [])];
        act(() => {
            action(rows[1], 'Reply')?.click();
        });
        act(() => {
            store.updateComposer(replyComposerKey(PUBLISHED.id), { text: 'Almost finished.' });
        });
        await act(async () => {
            threadNode(PUBLISHED.id)?.querySelector<HTMLButtonElement>('.thread__chevron')?.click();
            await Promise.resolve();
        });

        expect(collapsedIds()).toEqual([]);
        expect(store.getComposer(replyComposerKey(PUBLISHED.id))?.text).toBe('Almost finished.');
        expect(threadNode(PUBLISHED.id)?.textContent).toContain('Delete the draft?');
    });

    it('closes an empty reply composer on unmount', () => {
        const { store } = mountModal([PUBLISHED]);

        act(() => {
            action(threadNode(PUBLISHED.id)?.querySelector('.thread__row'), 'Reply')?.click();
        });
        expect(store.getComposer(replyComposerKey(PUBLISHED.id))).not.toBeNull();

        const unmount = mounted.pop();
        unmount?.();

        expect(store.getComposer(replyComposerKey(PUBLISHED.id))).toBeNull();
    });

    it('preserves a typed reply under its message after closing the modal', () => {
        const { store } = mountModal([RESOLVED]);

        act(() => {
            threadNode(RESOLVED.id)?.querySelector<HTMLButtonElement>('.thread__preview')?.click();
        });
        const rows = [...(threadNode(RESOLVED.id)?.querySelectorAll('.thread__row') ?? [])];
        act(() => {
            action(rows[1], 'Reply')?.click();
        });
        act(() => {
            store.updateComposer(replyComposerKey(RESOLVED.id), { text: 'More to write.' });
        });
        // The thread is marked collapsed (the code chevron), but the composer with text keeps it expanded.
        act(() => {
            store.setThreadsOpen([RESOLVED.id], false);
        });
        expect(collapsedIds()).toEqual([]);

        const unmount = mounted.pop();
        unmount?.();
        expect(store.getComposer(replyComposerKey(RESOLVED.id))?.text).toBe('More to write.');
        expect(store.getComposerGuardSnapshot().pending).toBe(true);

        mountModal([RESOLVED], {}, () => undefined, [], store);

        const reopened = [...(threadNode(RESOLVED.id)?.querySelectorAll('.thread__row') ?? [])];
        expect(collapsedIds()).toEqual([]);
        expect(reopened[0]?.querySelector('.thread-composer')).toBeNull();
        expect(reopened[1]?.querySelector<HTMLTextAreaElement>('.thread-composer textarea')?.value).toBe(
            'More to write.',
        );
    });

    it('closes the open composer on Esc and closes the modal only on the next Esc', async () => {
        const onClose = vi.fn();
        mountModal([PUBLISHED], {}, onClose);

        act(() => {
            action(threadNode(PUBLISHED.id)?.querySelector('.thread__row'), 'Reply')?.click();
        });
        const textarea = threadNode(PUBLISHED.id)?.querySelector<HTMLTextAreaElement>('textarea');
        expect(textarea).not.toBeNull();

        await act(async () => {
            textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await Promise.resolve();
        });
        expect(onClose).not.toHaveBeenCalled();
        expect(threadNode(PUBLISHED.id)?.querySelector('textarea')).toBeNull();
        // Esc does not collapse the thread. Only the chevron does.
        expect(collapsedIds()).toEqual([]);

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('asks to discard a typed reply on ✕ instead of closing the modal silently', async () => {
        const onClose = vi.fn();
        const { store } = mountModal([PUBLISHED], {}, onClose);

        act(() => {
            action(threadNode(PUBLISHED.id)?.querySelector('.thread__row'), 'Reply')?.click();
        });
        act(() => {
            store.updateComposer(replyComposerKey(PUBLISHED.id), { text: 'Still writing.' });
        });

        await act(async () => {
            closeButton()?.click();
            await Promise.resolve();
        });
        expect(onClose).not.toHaveBeenCalled();
        expect(threadNode(PUBLISHED.id)?.textContent).toContain('Delete the draft?');
        expect(store.getComposer(replyComposerKey(PUBLISHED.id))?.text).toBe('Still writing.');
        // The prompt may be below the visible list area, so the modal scrolls to it.
        expect(scrollIntoView).toHaveBeenCalled();

        await act(async () => {
            confirmAction(threadNode(PUBLISHED.id), 'Delete')?.click();
            await Promise.resolve();
        });
        await act(async () => {
            closeButton()?.click();
            await Promise.resolve();
        });
        expect(onClose).toHaveBeenCalledOnce();
        expect(store.getComposerGuardSnapshot().pending).toBe(false);
    });

    it('keeps typed text visible to the publication guard on Esc outside the editor or a backdrop click', async () => {
        const onClose = vi.fn();
        const { store } = mountModal([PUBLISHED], {}, onClose);
        act(() => {
            store.updateComposer(PR_COMPOSER_KEY, { text: 'New PR comment.' });
        });

        // Focus is on ✕, so Esc reaches the modal layer directly instead of passing through the editor.
        await act(async () => {
            document.body.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
            );
            await Promise.resolve();
        });
        expect(onClose).not.toHaveBeenCalled();
        expect(document.querySelector('.pr-comments-modal__composer')?.textContent).toContain(
            'Delete the draft?',
        );

        await act(async () => {
            confirmAction(document.querySelector('.pr-comments-modal__composer'), 'Cancel')?.click();
            await Promise.resolve();
        });
        await act(async () => {
            document
                .querySelector<HTMLElement>('.pr-comments-modal__overlay')
                ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            await Promise.resolve();
        });
        expect(onClose).not.toHaveBeenCalled();
        expect(store.getComposer(PR_COMPOSER_KEY)?.text).toBe('New PR comment.');
    });

    it('closes the modal on the second Esc after dismissing the empty bottom composer', async () => {
        const onClose = vi.fn();
        mountModal([], {}, onClose);
        const textarea = document.querySelector<HTMLTextAreaElement>('.pr-comments-modal__composer textarea');

        await act(async () => {
            textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await Promise.resolve();
        });
        expect(onClose).not.toHaveBeenCalled();

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it('omits the context heading for a new comment composer', () => {
        mountModal([]);

        const composer = document.querySelector('.pr-comments-modal__composer .thread-composer');
        expect(composer).not.toBeNull();
        expect(composer?.querySelector('.thread-composer__context')).toBeNull();
    });

    it('edits and deletes drafts through links below the text without a pencil in the header', async () => {
        const deleteDraft = vi.fn(() => Promise.resolve());
        const { store } = mountModal([DRAFT, PUBLISHED], { delete: deleteDraft });

        const draftRow = threadNode(DRAFT.id)?.querySelector('.thread__row');
        expect(draftRow?.querySelector('[data-icon="pencil"]')).toBeNull();
        expect(draftRow?.querySelector('[data-icon="trash"]')).toBeNull();

        act(() => {
            action(draftRow, 'Edit')?.click();
        });
        expect(store.getComposer(`edit:${DRAFT.root.id}`)).not.toBeNull();
        act(() => {
            store.closeComposer(`edit:${DRAFT.root.id}`);
        });

        act(() => {
            action(draftRow, 'Delete')?.click();
        });
        expect(document.body.textContent).toContain('Delete the draft? It will not be published');
        await act(async () => {
            draftRow?.querySelector<HTMLButtonElement>('.thread__delete-confirm-button')?.click();
            await Promise.resolve();
        });

        expect(deleteDraft).toHaveBeenCalledWith(DRAFT.root.id);
        expect(threadNode(DRAFT.id)).toBeNull();
    });

    it('hides the draft card while its draft is open in the bottom composer', () => {
        const { store } = mountModal([DRAFT, PUBLISHED]);

        act(() => {
            store.updateComposer(PR_COMPOSER_KEY, {
                text: DRAFT.root.body,
                commentId: DRAFT.root.id,
                status: 'saved',
            });
        });

        expect(threadNode(DRAFT.id)).toBeNull();
        expect(threadNode(PUBLISHED.id)).not.toBeNull();
    });

    it('closes an invisible edit composer with an error on unmount', () => {
        const { store } = mountModal([DRAFT]);
        act(() => {
            action(threadNode(DRAFT.id)?.querySelector('.thread__row'), 'Edit')?.click();
            store.updateComposer(`edit:${DRAFT.root.id}`, { text: 'Unsaved.', status: 'error' });
        });
        expect(store.getComposerGuardSnapshot().pending).toBe(true);

        const unmount = mounted.pop();
        unmount?.();

        expect(store.getComposer(`edit:${DRAFT.root.id}`)).toBeNull();
        expect(store.getComposerGuardSnapshot().pending).toBe(false);
    });

    // A record may have no composer at all (the draft was edited at a line in a previous iteration),
    // yet it blocks ship. This list is the only place to see and discard it.
    it('shows buffered records with discard and retry actions, including edits', async () => {
        const discardBuffered = vi.fn(() => Promise.resolve());
        const retryBuffered = vi.fn(() => Promise.resolve());
        mountModal([PUBLISHED, DRAFT], { discardBuffered, retryBuffered }, () => undefined, [
            BUFFERED_PR,
            { ...BUFFERED_PR, id: 'ck-edit', commentId: 'draft-9' },
        ]);

        const section = document.querySelector('.pr-comments-modal__buffered');
        expect(section?.textContent).toContain('2 drafts are waiting for the connection');
        expect(section?.querySelectorAll('.pr-comments-modal__buffered-item')).toHaveLength(2);

        await act(async () => {
            section?.querySelector<HTMLButtonElement>('.pr-comments-modal__delete-button')?.click();
            await Promise.resolve();
        });
        expect(discardBuffered).toHaveBeenCalledWith('ck-pr');

        await act(async () => {
            section?.querySelector<HTMLButtonElement>('.pr-comments-modal__keep-button')?.click();
            await Promise.resolve();
        });
        expect(retryBuffered).toHaveBeenCalledWith('ck-pr');
    });

    it('returns focus inside the modal on Tab when body is active', () => {
        mountModal([]);
        const close = document.querySelector<HTMLButtonElement>('[aria-label="Close the PR comments"]');
        document.body.tabIndex = -1;
        document.body.focus();

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));

        expect(document.activeElement).toBe(close);
        document.body.removeAttribute('tabindex');
    });
});

function threadIds(): string[] {
    return [...document.querySelectorAll<HTMLElement>('[data-thread-id]')].map(
        (node) => node.dataset.threadId ?? '',
    );
}

function collapsedIds(): string[] {
    return [...document.querySelectorAll<HTMLElement>('[data-thread-id].is-collapsed')].map(
        (node) => node.dataset.threadId ?? '',
    );
}

function threadNode(threadId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-thread-id="${threadId}"]`);
}

/** Action link below the message text, "Reply", "Edit", "Delete". */
function action(row: Element | null | undefined, label: string): HTMLButtonElement | null {
    return (
        [...(row?.querySelectorAll<HTMLButtonElement>('.thread__row-actions button') ?? [])].find(
            (button) => button.textContent === label,
        ) ?? null
    );
}

/** "Discard" / "Continue" button in the composer draft discard prompt. */
function confirmAction(scope: Element | null | undefined, label: string): HTMLButtonElement | null {
    return (
        [...(scope?.querySelectorAll<HTMLButtonElement>('.thread-composer .thread__delete-confirm button') ?? [])].find(
            (button) => button.textContent === label,
        ) ?? null
    );
}

function closeButton(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>('[aria-label="Close the PR comments"]');
}

function mountModal(
    threads: readonly Thread[],
    transportOverrides: Partial<ComposerTransport> = {},
    onClose: () => void = () => undefined,
    draftBuffer: readonly DraftBufferEntry[] = [],
    /** Store from the previous opening. The modal closes and reopens while the store survives. */
    reuse: ThreadStore | null = null,
): { readonly store: ThreadStore } {
    // Deterministic markdown layout, a plain textarea instead of ProseMirror.
    const settings = createUiSettingsStore({ initial: { composerLayout: 'markdown' } });
    const host = document.createElement('div');
    document.body.append(host);
    const store = reuse ?? createThreadStore(threads, new Set(DATA.diff.files.map((file) => file.fileId)));
    const transport: ComposerTransport = {
        save: () => Promise.reject(new Error('test does not save a new draft')),
        update: () => Promise.resolve({ outcome: 'saved' as const }),
        delete: () => Promise.resolve(),
        ...transportOverrides,
    };
    // The modal handles Esc through the registry stack. Without a provider, nothing can close it.
    const registry = createShortcutRegistry();
    const detach = attachShortcuts(window, registry);
    const root = createRoot(host);
    act(() => {
        root.render(
            <ShortcutsProvider registry={registry}>
                <SettingsProvider store={settings}>
                    <PrCommentsModal
                        pr={DATA.pr}
                        store={store}
                        transport={transport}
                        draftBuffer={draftBuffer}
                        now={NOW}
                        onClose={onClose}
                    />
                </SettingsProvider>
            </ShortcutsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        detach();
        host.remove();
    });
    return { store };
}

function comment({
    id,
    author,
    body,
    draft,
    createdAt,
    replies = [],
}: {
    id: string;
    author: Comment['author'];
    body: string;
    draft: boolean;
    createdAt: string;
    replies?: Comment['replies'];
}): Comment {
    return {
        id,
        author,
        body,
        draft,
        issue: null,
        resolved: null,
        createdAt,
        editedAt: null,
        replies,
    };
}

function thread({
    id,
    author,
    body,
    draft,
    createdAt,
    replies = [],
    anchor = null,
    resolved = false,
}: {
    id: string;
    author: Comment['author'];
    body: string;
    draft: boolean;
    createdAt: string;
    replies?: Comment['replies'];
    anchor?: Thread['anchor'];
    resolved?: boolean;
}): Thread {
    return {
        id,
        anchor,
        resolved,
        resolvedBy: null,
        outdated: false,
        pinnedTo: null,
        root: comment({ id: `${id}-comment`, author, body, draft, createdAt, replies }),
    };
}
