import { fixtureIteration } from '@sherpa/fixtures';
import type { Comment } from '@sherpa/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createThreadStore } from './store.js';

const DRAFT: Comment = {
    id: 'draft-1',
    author: { login: 'alice', displayName: 'Alice Ingram', bot: false },
    body: 'my draft',
    draft: true,
    issue: null,
    createdAt: '2026-08-24T10:00:00.000Z',
    editedAt: null,
    replies: [],
};

describe('thread store', () => {
    it('applies resolve and my draft over a fresh snapshot', () => {
        const data = fixtureIteration('medium');
        const store = createThreadStore(data.threads, new Set(data.diff.files.map((file) => file.fileId)));
        const thread = data.threads.find((candidate) => !candidate.resolved);
        if (thread === undefined) {
            throw new Error('no open thread');
        }

        store.setResolved(thread.id, true);
        store.addDraft({ body: DRAFT.body, parentId: thread.root.id, anchor: null }, DRAFT);
        store.setServerThreads(data.threads);

        const optimistic = store.getSnapshot().threads.find((candidate) => candidate.id === thread.id);
        expect(optimistic?.resolved).toBe(true);
        expect(optimistic?.root.replies.some((reply) => reply.id === DRAFT.id)).toBe(true);
    });

    it('does not duplicate a draft when it arrives from the server with the same id', () => {
        const data = fixtureIteration('medium');
        const store = createThreadStore(data.threads, new Set(data.diff.files.map((file) => file.fileId)));
        const parent = data.threads[0];
        if (parent === undefined) {
            throw new Error('no thread');
        }
        store.addDraft({ body: DRAFT.body, parentId: parent.root.id, anchor: null }, DRAFT);
        store.setServerThreads([
            ...data.threads.slice(1),
            { ...parent, root: { ...parent.root, replies: [...parent.root.replies, DRAFT] } },
        ]);

        const ids: string[] = [];
        const visit = (comment: Comment): void => {
            ids.push(comment.id);
            comment.replies.forEach((reply) => {
                visit(reply);
            });
        };
        store.getSnapshot().threads.forEach((thread) => {
            visit(thread.root);
        });
        expect(ids.filter((id) => id === DRAFT.id)).toHaveLength(1);
    });

    it('notifies only its own composer on input, leaving the thread list subscription untouched', () => {
        const store = createThreadStore([], new Set(['f1']));
        const external = vi.fn();
        const local = vi.fn();
        const layout = vi.fn();
        store.subscribe(external);
        store.subscribeComposer('new:f1:new:10', local);
        store.subscribeComposers(layout);
        store.openComposer({
            key: 'new:f1:new:10',
            threadId: null,
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            text: '',
            commentId: null,
            status: 'idle',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        external.mockClear();
        local.mockClear();
        layout.mockClear();

        store.updateComposer('new:f1:new:10', { text: 'character' });

        expect(local).toHaveBeenCalledTimes(1);
        expect(external).not.toHaveBeenCalled();
        expect(layout).not.toHaveBeenCalled();
    });

    it('changes the publication guard only between saved and unsaved states', () => {
        const store = createThreadStore([], new Set());
        const listener = vi.fn();
        store.subscribeComposerGuard(listener);
        store.openComposer({
            key: 'new:pr',
            threadId: null,
            parentId: null,
            anchor: null,
            text: '',
            commentId: null,
            status: 'idle',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        expect(store.getComposerGuardSnapshot().pending).toBe(false);

        store.updateComposer('new:pr', { text: 'comment' });
        expect(store.getComposerGuardSnapshot().pending).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);

        store.updateComposer('new:pr', { status: 'saving' });
        expect(listener).toHaveBeenCalledTimes(1);
        store.updateComposer('new:pr', { commentId: 'draft-1', status: 'saved' });
        expect(store.getComposerGuardSnapshot().pending).toBe(false);
        expect(listener).toHaveBeenCalledTimes(2);

        store.updateComposer('new:pr', { text: 'edited comment', status: 'idle' });
        expect(store.getComposerGuardSnapshot().pending).toBe(true);
        expect(listener).toHaveBeenCalledTimes(3);

        store.updateComposer('new:pr', { text: '', status: 'idle' });
        expect(store.getComposerGuardSnapshot().pending).toBe(true);
        expect(listener).toHaveBeenCalledTimes(3);
    });

    it('keeps the publication guard active until a confirmed card deletion completes', () => {
        const store = createThreadStore([], new Set());

        store.beginDraftDeletion('draft-1');
        store.beginDraftDeletion('draft-1');
        expect(store.getComposerGuardSnapshot().pending).toBe(true);

        store.endDraftDeletion('draft-1');
        expect(store.getComposerGuardSnapshot().pending).toBe(true);

        store.endDraftDeletion('draft-1');
        expect(store.getComposerGuardSnapshot().pending).toBe(false);
    });

    it('clears a temporary resolve rollback on a server snapshot even if the value differs', () => {
        const data = fixtureIteration('medium');
        const thread = data.threads.find((candidate) => !candidate.resolved);
        if (thread === undefined) {
            throw new Error('no open thread');
        }
        const store = createThreadStore(data.threads, new Set(data.diff.files.map((file) => file.fileId)));
        store.restoreResolved(thread.id, false);

        store.setServerThreads(
            data.threads.map((candidate) =>
                candidate.id === thread.id ? { ...candidate, resolved: true } : candidate,
            ),
        );

        expect(store.getSnapshot().threads.find((candidate) => candidate.id === thread.id)?.resolved).toBe(true);
        expect(store.hasResolvedOverride(thread.id)).toBe(false);
    });

    it('the undo window survives without a React component and closes after 5s', () => {
        vi.useFakeTimers();
        try {
            const data = fixtureIteration('medium');
            const thread = data.threads.find((candidate) => candidate.anchor !== null);
            if (thread === undefined) {
                throw new Error('no file thread');
            }
            const store = createThreadStore(data.threads, new Set(data.diff.files.map((file) => file.fileId)));

            store.startUndo(thread.id, true);
            expect(store.getSnapshot().undo.get(thread.id)?.resolved).toBe(true);
            expect(store.getSnapshot().keptVisible.has(thread.id)).toBe(true);

            vi.advanceTimersByTime(5000);
            expect(store.getSnapshot().undo.has(thread.id)).toBe(false);
            expect(store.getSnapshot().keptVisible.has(thread.id)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('stores kept-in-view separately by file', () => {
        const data = fixtureIteration('medium');
        const thread = data.threads.find((candidate) => candidate.anchor !== null);
        if (thread?.anchor === null || thread === undefined) {
            throw new Error('no file thread');
        }
        const store = createThreadStore(data.threads, new Set(data.diff.files.map((file) => file.fileId)));

        store.keepVisible(thread.id);
        expect(store.getSnapshot().keptVisible.has(thread.id)).toBe(true);
        expect(store.getSnapshot().keptByFile.get(thread.anchor.fileId)?.has(thread.id)).toBe(true);

        store.releaseVisible(thread.id);
        expect(store.getSnapshot().keptVisible.has(thread.id)).toBe(false);
    });
});
