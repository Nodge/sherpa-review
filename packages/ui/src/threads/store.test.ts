import { anchor, comment, fixtureIteration, human, thread } from '@sherpa/fixtures';
import type { Comment } from '@sherpa/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createThreadStore } from './store.js';

const DRAFT: Comment = {
    id: 'draft-1',
    author: { login: 'alice', displayName: 'Alice Ingram', bot: false },
    body: 'my draft',
    draft: true,
    issue: null,
    resolved: null,
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

    it('collapses only resolved threads without my draft by default', () => {
        const data = fixtureIteration('large');
        const store = createThreadStore(data.threads, new Set(data.diff.files.map((file) => file.fileId)));
        const resolved = data.threads.find((candidate) => candidate.resolved);
        const open = data.threads.find((candidate) => !candidate.resolved);
        if (resolved === undefined || open === undefined) {
            throw new Error('large fixture needs resolved and open threads');
        }

        expect(store.getSnapshot().openThreads.has(open.id)).toBe(true);
        expect(store.getSnapshot().openThreads.has(resolved.id)).toBe(false);

        // A draft keeps a resolved thread expanded: the reviewer still has unfinished work there.
        const withDraft = createThreadStore(
            [{ ...resolved, root: { ...resolved.root, replies: [DRAFT] } }],
            new Set(),
        );
        expect(withDraft.getSnapshot().openThreads.has(resolved.id)).toBe(true);
    });

    it('gets the reviewer login from PR metadata without needing drafts', () => {
        const where = anchor('d1', 'src/a.ts', { side: 'new', line: 10 });
        const root = comment({
            id: 'c-1',
            author: human('alice', 'Alice Ingram'),
            body: 'my published comment',
            createdAt: '2026-08-24T09:00:00.000Z',
        });
        const store = createThreadStore([thread({ anchor: where, root })], new Set([where.fileId]));
        expect(store.getSnapshot().viewerLogin).toBeNull();

        store.setViewer('alice');
        expect(store.getSnapshot().viewerLogin).toBe('alice');

        // A draft in the threads does not affect identity: only the host knows it.
        store.setServerThreads([thread({ anchor: where, root: { ...root, replies: [DRAFT] } })]);
        expect(store.getSnapshot().viewerLogin).toBe('alice');

        // The host forgot the identity, so comments are no longer treated as mine.
        store.setViewer(null);
        expect(store.getSnapshot().viewerLogin).toBeNull();
    });

    it('lets only the reviewer change expansion: neither Resolve nor a new reply changes it', () => {
        const data = fixtureIteration('medium');
        const thread = data.threads.find((candidate) => !candidate.resolved && candidate.anchor !== null);
        if (thread === undefined) {
            throw new Error('no open anchored thread');
        }
        const store = createThreadStore(data.threads, new Set(data.diff.files.map((file) => file.fileId)));

        store.toggleThreadOpen(thread.id);
        expect(store.isThreadOpen(thread.id)).toBe(false);

        // A new host reply and the reviewer clicking Resolve do not expand a collapsed thread.
        store.setServerThreads(
            data.threads.map((candidate) =>
                candidate.id === thread.id
                    ? { ...candidate, root: { ...candidate.root, replies: [...candidate.root.replies, DRAFT] } }
                    : candidate,
            ),
        );
        store.setResolved(thread.id, true);
        expect(store.getSnapshot().openThreads.has(thread.id)).toBe(false);

        store.toggleThreadOpen(thread.id);
        expect(store.getSnapshot().openThreads.has(thread.id)).toBe(true);
    });

    it('collapses all and expands all in a single update', () => {
        const data = fixtureIteration('medium');
        const store = createThreadStore(data.threads, new Set(data.diff.files.map((file) => file.fileId)));
        const ids = data.threads.map((thread) => thread.id);
        const listener = vi.fn();
        store.subscribe(listener);

        store.setThreadsOpen(ids, false);
        expect(listener).toHaveBeenCalledOnce();
        expect(store.getSnapshot().openThreads.size).toBe(0);

        store.setThreadsOpen(ids, true);
        expect(listener).toHaveBeenCalledTimes(2);
        expect(store.getSnapshot().openThreads.size).toBe(ids.length);

        // Nothing to change, so the snapshot is not rebuilt.
        store.setThreadsOpen(ids, true);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('recomputes the thread by the issue rule on per-comment resolve', () => {
        const open = thread({
            id: 't-issue',
            anchor: anchor('d1', 'a.ts', { side: 'new', line: 1 }),
            root: comment({
                id: 'c-issue',
                author: human('kai', 'Kai Kennedy'),
                body: 'remark',
                createdAt: '2026-08-24T10:00:00.000Z',
                issue: true,
                resolved: false,
            }),
        });
        const store = createThreadStore([open], new Set([open.anchor?.fileId ?? '']));

        store.setCommentResolved('c-issue', true);
        expect(store.getSnapshot().threads[0]?.resolved).toBe(true);
        expect(store.getCommentResolved('c-issue')).toBe(true);

        store.restoreCommentResolved('c-issue', false);
        expect(store.getSnapshot().threads[0]?.resolved).toBe(false);
        expect(store.getServerCommentResolved('c-issue')).toBe(false);
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
