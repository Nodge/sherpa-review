// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { DraftBufferEntry, Thread } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ComposerTransport } from '../threads/composer.js';
import { SettingsProvider } from '../settings/context.tsx';
import { createUiSettingsStore } from '../settings/settings-store.js';
import { ShortcutsProvider } from '../shortcuts/context.tsx';
import { attachShortcuts, createShortcutRegistry } from '../shortcuts/registry.js';
import { PR_COMPOSER_KEY } from '../threads/thread-list.tsx';
import type { ThreadStore } from '../threads/store.js';
import { createThreadStore } from '../threads/store.js';
import { PrCommentsModal } from './pr-comments-modal.tsx';

const DATA = fixtureIteration('medium');
const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const HUMAN = { login: 'alice', displayName: 'Alice Ingram', bot: false } as const;
const BOT = { login: 'ai-review-bot', displayName: 'AI Review', bot: true } as const;
const PUBLISHED = thread({
    id: 'pr-published',
    author: HUMAN,
    body: 'Published **PR-level** comment.',
    draft: false,
    createdAt: '2026-08-31T10:00:00.000Z',
});
const DRAFT = thread({
    id: 'pr-draft',
    author: HUMAN,
    body: 'My PR draft.',
    draft: true,
    createdAt: '2026-08-31T11:00:00.000Z',
    replies: [
        {
            id: 'pr-draft-reply',
            author: HUMAN,
            body: 'The reply must not appear in the modal.',
            draft: true,
            issue: null,
            createdAt: '2026-08-31T11:10:00.000Z',
            editedAt: null,
            replies: [],
        },
    ],
});
const BOT_PR = thread({
    id: 'pr-bot',
    author: BOT,
    body: 'PR-level bot thread.',
    draft: false,
    createdAt: '2026-08-31T09:00:00.000Z',
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
    // Draft buffer and ship summary (docs/design/SPEC-elements.md §4.5) in the modal header.
    it('counts PR-level buffer records as drafts and shows unresolved threads', () => {
        mountModal([PUBLISHED, DRAFT], {}, () => undefined, [BUFFERED_PR]);

        const header = document.querySelector('.pr-comments-modal__header')?.textContent ?? '';
        expect(header).toContain('2 drafts · will be sent on Ship');
        expect(header).toContain('1 not yet saved to the host');
        expect(document.querySelector('.pr-comments-modal__open-threads')?.textContent).toContain('unresolved');
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
        expect(section?.textContent).toContain('2 drafts wait for a host connection');
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

    it('shows only roots of human PR-level threads: drafts and published comments', () => {
        mountModal([PUBLISHED, DRAFT, BOT_PR, DISAPPEARED]);

        const items = [...document.querySelectorAll<HTMLElement>('[data-comment-id]')];
        expect(items.map((item) => item.dataset.commentId)).toEqual([DRAFT.root.id, PUBLISHED.root.id]);
        expect(document.body.textContent).toContain('My PR draft.');
        expect(document.body.textContent).toContain('Published PR-level comment.');
        expect(document.body.textContent).not.toContain('PR-level bot thread.');
        expect(document.body.textContent).not.toContain('Thread for a missing file.');
        expect(document.body.textContent).not.toContain('The reply must not appear in the modal.');
        expect(items[0]?.querySelector('[data-icon="pencil"]')).not.toBeNull();
        expect(items[1]?.querySelector('[data-icon="pencil"]')).toBeNull();
        expect(document.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
        expect(document.body.style.overflow).toBe('hidden');
    });

    it('keeps text independent between item editing and the bottom composer', () => {
        const { store } = mountModal([DRAFT, PUBLISHED]);
        act(() => {
            store.updateComposer(PR_COMPOSER_KEY, { text: 'A new separate comment.' });
        });
        const editButton = document.querySelector<HTMLButtonElement>(`[aria-label="Edit draft ${DRAFT.root.id}"]`);
        act(() => {
            editButton?.click();
        });

        const item = document.querySelector<HTMLElement>(`[data-comment-id="${DRAFT.root.id}"]`);
        const lowerInput = document.querySelector<HTMLTextAreaElement>('.pr-comments-modal__composer textarea');
        const editInput = item?.querySelector<HTMLTextAreaElement>('textarea') ?? null;
        expect(lowerInput?.value).toBe('A new separate comment.');
        expect(editInput?.value).toBe('My PR draft.');

        act(() => {
            store.updateComposer(`edit:${DRAFT.root.id}`, { text: 'Updated draft text.' });
        });
        expect(editInput?.value).toBe('Updated draft text.');
        expect(lowerInput?.value).toBe('A new separate comment.');

        act(() => {
            store.updateComposer(PR_COMPOSER_KEY, { text: 'Another new comment.' });
        });
        expect(lowerInput?.value).toBe('Another new comment.');
        expect(editInput?.value).toBe('Updated draft text.');
    });

    it('closing the edit composer restores the body and clears the editing state', () => {
        const { store } = mountModal([DRAFT]);
        act(() => {
            document.querySelector<HTMLButtonElement>(`[aria-label="Edit draft ${DRAFT.root.id}"]`)?.click();
        });
        const item = document.querySelector<HTMLElement>(`[data-comment-id="${DRAFT.root.id}"]`);
        expect(item?.classList.contains('is-editing')).toBe(true);

        act(() => {
            store.closeComposer(`edit:${DRAFT.root.id}`);
        });

        expect(item?.classList.contains('is-editing')).toBe(false);
        expect(item?.querySelector('.pr-comments-modal__chip')?.textContent).toBe('draft · publishes on ship');
        expect(item?.querySelector('.pr-comments-modal__body')?.textContent).toContain(DRAFT.root.body);
    });

    it('deletes only after inline confirmation, and Keep cancels', async () => {
        const deleteDraft = vi.fn(() => Promise.resolve());
        mountModal([DRAFT, PUBLISHED], { delete: deleteDraft });
        const trash = document.querySelector<HTMLButtonElement>(`[aria-label="Delete draft ${DRAFT.root.id}"]`);

        act(() => {
            trash?.click();
        });
        expect(document.body.textContent).toContain('Delete the draft? It will not be published');
        const keep = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
            (button) => button.textContent === 'Keep',
        );
        act(() => {
            keep?.click();
        });
        expect(document.body.textContent).not.toContain('Delete the draft? It will not be published');
        expect(deleteDraft).not.toHaveBeenCalled();

        act(() => {
            trash?.click();
        });
        const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
            (button) => button.textContent === 'Delete',
        );
        await act(async () => {
            confirm?.click();
            await Promise.resolve();
        });

        expect(deleteDraft).toHaveBeenCalledOnce();
        expect(deleteDraft).toHaveBeenCalledWith(DRAFT.root.id);
        expect(document.querySelector(`[data-comment-id="${DRAFT.root.id}"]`)).toBeNull();
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

        expect(document.querySelector(`[data-comment-id="${DRAFT.root.id}"]`)).toBeNull();
        expect(document.querySelector(`[data-comment-id="${PUBLISHED.root.id}"]`)).not.toBeNull();
        expect(document.querySelector('.pr-comments-modal__draft-count')?.textContent).toContain('1 draft');
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

    it('returns focus inside the modal on Tab when body is active', () => {
        mountModal([]);
        const close = document.querySelector<HTMLButtonElement>('[aria-label="Close the PR comments"]');
        document.body.tabIndex = -1;
        document.body.focus();

        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));

        expect(document.activeElement).toBe(close);
        document.body.removeAttribute('tabindex');
    });

    it('restores the original text through transport.update when editing is cancelled', async () => {
        const update = vi.fn(() => Promise.resolve({ outcome: 'saved' as const }));
        const { store } = mountModal([DRAFT], { update });
        act(() => {
            document.querySelector<HTMLButtonElement>(`[aria-label="Edit draft ${DRAFT.root.id}"]`)?.click();
            store.updateComposer(`edit:${DRAFT.root.id}`, { text: 'Corrupted text.' });
        });
        const item = document.querySelector<HTMLElement>(`[data-comment-id="${DRAFT.root.id}"]`);
        const cancel = [...(item?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
            (button) => button.textContent === 'Cancel',
        );

        act(() => {
            cancel?.click();
        });
        const confirm = item?.querySelector('.thread-composer__confirm');
        expect(confirm?.textContent).toContain('Discard this draft?');
        expect(update).not.toHaveBeenCalled();

        await act(async () => {
            [...(confirm?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
                .find((button) => button.textContent === 'discard')
                ?.click();
            await vi.waitFor(() => {
                expect(update).toHaveBeenCalledWith(DRAFT.root.id, DRAFT.root.body, undefined, expect.any(String));
            });
        });

        expect(store.getComposer(`edit:${DRAFT.root.id}`)).toBeNull();
        expect(item?.textContent).toContain(DRAFT.root.body);
    });

    it('closes an invisible edit composer with an error on unmount', () => {
        const { store } = mountModal([DRAFT]);
        act(() => {
            document.querySelector<HTMLButtonElement>(`[aria-label="Edit draft ${DRAFT.root.id}"]`)?.click();
            store.updateComposer(`edit:${DRAFT.root.id}`, { text: 'Unsaved.', status: 'error' });
        });
        expect(store.getComposerGuardSnapshot().pending).toBe(true);

        const unmount = mounted.pop();
        unmount?.();

        expect(store.getComposer(`edit:${DRAFT.root.id}`)).toBeNull();
        expect(store.getComposerGuardSnapshot().pending).toBe(false);
    });
});

function mountModal(
    threads: readonly Thread[],
    transportOverrides: Partial<ComposerTransport> = {},
    onClose: () => void = () => undefined,
    draftBuffer: readonly DraftBufferEntry[] = [],
): { readonly store: ThreadStore } {
    // Deterministic markdown layout, a plain textarea instead of ProseMirror.
    const settings = createUiSettingsStore({ initial: { composerLayout: 'markdown' } });
    const host = document.createElement('div');
    document.body.append(host);
    const store = createThreadStore(threads, new Set(DATA.diff.files.map((file) => file.fileId)));
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

function thread({
    id,
    author,
    body,
    draft,
    createdAt,
    replies = [],
    anchor = null,
}: {
    id: string;
    author: Thread['root']['author'];
    body: string;
    draft: boolean;
    createdAt: string;
    replies?: Thread['root']['replies'];
    anchor?: Thread['anchor'];
}): Thread {
    return {
        id,
        anchor,
        resolved: false,
        resolvedBy: null,
        outdated: false,
        pinnedTo: null,
        root: {
            id: `${id}-comment`,
            author,
            body,
            draft,
            issue: null,
            createdAt,
            editedAt: null,
            replies,
        },
    };
}
