import type { DraftBufferEntry, Thread } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import {
    composerKeyOfBufferEntry,
    restoreBufferedComposers,
    staleBufferedComposers,
    syncBufferedComposers,
} from './draft-buffer.js';
import { createThreadStore } from './store.js';

/** Restores the draft buffer into composers: key, anchor, text, status. */

function entry(patch: Partial<DraftBufferEntry> & Pick<DraftBufferEntry, 'id'>): DraftBufferEntry {
    return {
        draft: { body: 'draft text', parentId: null, anchor: null },
        commentId: null,
        state: 'failed',
        error: 'host is down',
        attempts: 1,
        createdAt: '2026-09-03T10:00:00.000Z',
        updatedAt: '2026-09-03T10:00:00.000Z',
        ...patch,
    };
}

const LINE_ANCHOR = { fileId: 'f1', path: 'app.ts', position: { side: 'new' as const, line: 42, size: 3 } };

const REPLY_THREAD = replyThread();

describe('composer key for a buffered entry', () => {
    it('uses the first line as the key for a line comment', () => {
        expect(
            composerKeyOfBufferEntry(entry({ id: 'ck-1', draft: { body: 'x', parentId: null, anchor: LINE_ANCHOR } }), []),
        ).toBe('new:f1:new:42');
    });

    it('uses the thread key for a reply and a separate key for a PR comment', () => {
        expect(
            composerKeyOfBufferEntry(entry({ id: 'ck-2', draft: { body: 'x', parentId: 'root-1', anchor: null } }), [
                REPLY_THREAD,
            ]),
        ).toBe('reply:root-1');
        expect(composerKeyOfBufferEntry(entry({ id: 'ck-3' }), [])).toBe('new:pr');
    });

    // A reply can be nested: there is no composer with a nested message id, only one composer per thread.
    it('uses the same thread key for a reply to a nested message', () => {
        expect(
            composerKeyOfBufferEntry(entry({ id: 'ck-2', draft: { body: 'x', parentId: 'reply-2', anchor: null } }), [
                REPLY_THREAD,
            ]),
        ).toBe('reply:root-1');
    });

    it('has no composer location for a reply to a thread missing from the snapshot', () => {
        expect(
            composerKeyOfBufferEntry(entry({ id: 'ck-2', draft: { body: 'x', parentId: 'reply-2', anchor: null } }), []),
        ).toBeNull();
    });

    it('uses the draft editor key when editing a draft owned by the reviewer', () => {
        expect(composerKeyOfBufferEntry(entry({ id: 'ck-4', commentId: 'draft-9' }), [])).toBe('edit:draft-9');
    });
});

describe('restoring composers from the buffer', () => {
    it('opens a composer with text, anchor and buffered status', () => {
        const store = createThreadStore([], new Set(['f1']));
        const record = entry({ id: 'ck-1', draft: { body: 'not lost', parentId: null, anchor: LINE_ANCHOR } });

        expect(restoreBufferedComposers(store, [record])).toEqual(['new:f1:new:42']);

        expect(store.getComposer('new:f1:new:42')).toMatchObject({
            text: 'not lost',
            status: 'buffered',
            clientKey: 'ck-1',
            // The selection range survives restoration: the composer key only knows the first line.
            anchor: LINE_ANCHOR,
        });
    });

    it('does not overwrite a composer the reviewer is typing in', () => {
        const store = createThreadStore([], new Set(['f1']));
        const record = entry({ id: 'ck-1', draft: { body: 'old', parentId: null, anchor: LINE_ANCHOR } });
        restoreBufferedComposers(store, [record]);
        store.updateComposer('new:f1:new:42', { text: 'already added more' });

        restoreBufferedComposers(store, [record]);

        expect(store.getComposer('new:f1:new:42')?.text).toBe('already added more');
    });

    it('closes an untouched composer once the server delivers its entry', () => {
        const store = createThreadStore([], new Set(['f1']));
        const record = entry({ id: 'ck-1', draft: { body: 'delivered', parentId: null, anchor: LINE_ANCHOR } });
        restoreBufferedComposers(store, [record]);

        expect(staleBufferedComposers(store, []).close).toEqual(['new:f1:new:42']);
        syncBufferedComposers(store, []);

        expect(store.getComposer('new:f1:new:42')).toBeNull();
    });

    it('keeps added text after entry delivery by leaving the composer open with unsaved text', () => {
        const store = createThreadStore([], new Set(['f1']));
        restoreBufferedComposers(store, [
            entry({ id: 'ck-1', draft: { body: 'delivered', parentId: null, anchor: LINE_ANCHOR } }),
        ]);
        store.updateComposer('new:f1:new:42', { text: 'delivered plus another paragraph' });

        syncBufferedComposers(store, []);

        expect(store.getComposer('new:f1:new:42')).toMatchObject({
            text: 'delivered plus another paragraph',
            status: 'idle',
            bufferEntry: null,
            // The entry key stays: the server turns a save with the same key into an edit to the draft
            // it already created, without creating a second draft with almost the same text.
            clientKey: 'ck-1',
        });
    });

    // Without the original text, "Discard" on a restored edit would mean deleting the draft
    // on the host: the edit composer would not know what to restore.
    it('restores an edit together with the original draft text', () => {
        const store = createThreadStore([draftThread('draft-9', 'this is on the host')], new Set(['f1']));
        const record = entry({
            id: 'ck-edit',
            commentId: 'draft-9',
            draft: { body: 'edit that was not delivered', parentId: null, anchor: null },
        });

        expect(restoreBufferedComposers(store, [record])).toEqual(['edit:draft-9']);

        expect(store.getComposer('edit:draft-9')).toMatchObject({
            text: 'edit that was not delivered',
            originalText: 'this is on the host',
            threadId: 'thread-draft-9',
            commentId: 'draft-9',
            status: 'buffered',
        });
    });

    // The entry holds the issue flag that has not reached the host yet. The toggle must restore its state.
    it('restores the issue toggle state in the composer', () => {
        const store = createThreadStore([REPLY_THREAD], new Set(['f1']));
        const record = entry({
            id: 'ck-issue',
            draft: { body: 'remark', parentId: 'root-1', anchor: null, issue: false },
        });

        restoreBufferedComposers(store, [record]);

        expect(store.getComposer('reply:root-1')?.issue).toBe(false);
    });

    // A thread has one reply composer. A buffered reply to a nested message must return
    // to that composer, or nothing on screen will render it.
    it('restores a reply to a nested message in the thread composer under that message', () => {
        const store = createThreadStore([REPLY_THREAD], new Set(['f1']));
        const record = entry({
            id: 'ck-nested',
            draft: { body: 'reply to nested message', parentId: 'reply-2', anchor: null },
        });

        expect(restoreBufferedComposers(store, [record])).toEqual(['reply:root-1']);

        expect(store.getComposer('reply:root-1')).toMatchObject({
            text: 'reply to nested message',
            threadId: 'root-1',
            parentId: 'reply-2',
            replyUnder: 'reply-2',
            status: 'buffered',
        });
    });

    it('does not restore an edit when its comment is missing from threads', () => {
        const store = createThreadStore([], new Set(['f1']));

        expect(restoreBufferedComposers(store, [entry({ id: 'ck-edit', commentId: 'draft-9' })])).toEqual([]);
        expect(store.getComposer('edit:draft-9')).toBeNull();
    });
});

/** A thread with one reply. Its ID equals the root ID, as on a host where the root represents the thread. */
function replyThread(): Thread {
    const base = draftThread('root-1', 'thread root');
    const root = { ...base.root, draft: false };
    return {
        ...base,
        id: 'root-1',
        root: { ...root, replies: [{ ...root, id: 'reply-2', body: 'thread reply' }] },
    };
}

/** A thread with a single draft: the minimum needed to restore an edit. */
function draftThread(commentId: string, body: string): Thread {
    return {
        id: `thread-${commentId}`,
        anchor: null,
        resolved: false,
        resolvedBy: null,
        outdated: false,
        pinnedTo: null,
        root: {
            id: commentId,
            author: { login: 'alice', displayName: null, bot: false, avatarUrl: null },
            body,
            createdAt: '2026-09-03T09:00:00.000Z',
            editedAt: null,
            draft: true,
            issue: null,
            resolved: null,
            replies: [],
        },
    };
}
