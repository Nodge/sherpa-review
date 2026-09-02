import type { Comment, Thread } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { draftEditComposerKey, openDraftEditor } from './draft-editor.tsx';
import { createThreadStore } from './store.js';

function comment(id: string, issue: boolean | null): Comment {
    return {
        id,
        author: { login: 'alice', displayName: 'Alice Ingram', bot: false },
        body: `text ${id}`,
        draft: true,
        issue,
        createdAt: '2026-08-31T10:00:00.000Z',
        editedAt: null,
        replies: [],
    };
}

function thread(root: Comment): Thread {
    return { id: root.id, anchor: null, resolved: false, resolvedBy: null, outdated: false, pinnedTo: null, root };
}

describe('editing your own draft', () => {
    it('opens the issue toggle in the host state', () => {
        for (const issue of [true, false]) {
            const root = comment('root', issue);
            const store = createThreadStore([thread(root)], new Set());
            openDraftEditor(store, thread(root), root);
            expect(store.getComposer(draftEditComposerKey(root.id))?.issue).toBe(issue);
        }
    });

    it('has no toggle when the host has no issue status', () => {
        const root = comment('root', null);
        const store = createThreadStore([thread(root)], new Set());
        openDraftEditor(store, thread(root), root);
        expect(store.getComposer(draftEditComposerKey(root.id))?.issue).toBeUndefined();
    });

    it('a reply has no toggle even with issue status', () => {
        const reply = comment('reply', true);
        const root = { ...comment('root', true), replies: [reply] };
        const store = createThreadStore([thread(root)], new Set());
        openDraftEditor(store, thread(root), reply);
        expect(store.getComposer(draftEditComposerKey(reply.id))?.issue).toBeUndefined();
    });
});
