import { fixtureIteration } from '@sherpa/fixtures';
import type { Comment, Thread } from '@sherpa/protocol';
import { useCallback, useState, useSyncExternalStore } from 'react';

import { CommentComposer } from '../../threads/comment-composer.tsx';
import type { ComposerTransport } from '../../threads/composer.js';
import type { ComposerLayout } from '../../threads/composer-markdown.js';
import { ThreadList } from '../../threads/thread-list.tsx';
import type { ComposerSnapshot } from '../../threads/store.js';
import { createThreadStore } from '../../threads/store.js';

const DATA = fixtureIteration('medium');
const THREAD = firstThread();
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const SAVED_AT = Date.parse('2026-08-28T14:02:00');
const DRAFT: Comment = {
    id: 'gallery-composer-draft',
    author: { login: 'alice', displayName: 'Alice Ingram', bot: false, avatarUrl: null },
    body: 'I will check one more edge case before Ship.',
    draft: true,
    issue: true,
    resolved: null,
    createdAt: '2026-08-28T14:02:00.000Z',
    editedAt: null,
    replies: [],
};
const TRANSPORT: ComposerTransport = {
    save: () => Promise.resolve({ outcome: 'saved', comment: DRAFT }),
    update: () => Promise.resolve({ outcome: 'saved' }),
    delete: () => Promise.resolve(),
};

function firstThread(): Thread {
    const thread = DATA.threads[0];
    if (thread === undefined) {
        throw new Error('The composer gallery needs a thread from fixture-medium.');
    }
    return thread;
}

export const COMMENT_COMPOSER_STATES = [
    { id: 'composer-rest', title: 'rest, thread without a composer, enter via "Reply"', render: () => <CollapsedState draft={false} /> },
    { id: 'composer-empty', title: 'open, placeholder', render: () => <OpenState layout="visual" kind="empty" /> },
    { id: 'composer-visual', title: 'text, Visual', render: () => <OpenState layout="visual" kind="saved" /> },
    { id: 'composer-markdown', title: 'text, Markdown', render: () => <OpenState layout="markdown" kind="saved" /> },
    { id: 'composer-error', title: 'autosave error', render: () => <OpenState layout="markdown" kind="error" /> },
    { id: 'composer-confirm', title: 'confirm draft deletion', render: () => <OpenState layout="visual" kind="confirm" /> },
    { id: 'composer-issue-open', title: 'new comment · issue open', render: () => <IssueState issue /> },
    { id: 'composer-issue-off', title: 'new comment · issue off', render: () => <IssueState issue={false} /> },
    { id: 'composer-no-issue', title: 'new comment · host without issues', render: () => <IssueState /> },
    { id: 'composer-reply-issue', title: 'thread reply · issue switch', render: () => <OpenState layout="visual" kind="saved" issue /> },
    { id: 'composer-closed-draft', title: 'draft saved, field closed · draft and issue chips', render: () => <CollapsedState draft /> },
] as const;

function OpenState({
    layout,
    kind,
    issue = false,
}: {
    layout: ComposerLayout;
    kind: 'empty' | 'saved' | 'error' | 'confirm';
    /** Reply on a host with `commentIssues`: the same switch as for a new comment. */
    issue?: boolean;
}) {
    const [store] = useState(() => {
        const created = createThreadStore([], FILE_IDS);
        const text = kind === 'empty' ? '' : '**Guard** must be built inside the unit of work, otherwise `None` remains reachable.';
        const snapshot: ComposerSnapshot = {
            key: composerKey(layout, kind, issue),
            threadId: THREAD.id,
            parentId: THREAD.root.id,
            anchor: null,
            ...(issue ? { issue: true } : {}),
            text,
            commentId: kind === 'saved' ? DRAFT.id : null,
            status: kind === 'error' ? 'error' : kind === 'saved' ? 'saved' : 'idle',
            savedAt: kind === 'saved' ? SAVED_AT : null,
            slow: false,
            confirmDiscard: kind === 'confirm',
            resolvedAtOpen: false,
        };
        created.openComposer(snapshot);
        return created;
    });
    // Live subscription, as in ThreadList: without it, typing in the gallery updates the store,
    // while the composer keeps receiving a stale snapshot.
    const key = composerKey(layout, kind, issue);
    const subscribe = useCallback((listener: () => void) => store.subscribeComposer(key, listener), [key, store]);
    const getSnapshot = useCallback(() => store.getComposer(key), [key, store]);
    const composer = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    if (composer === null) {
        return null;
    }
    return (
        <div className="gallery-composer">
            <CommentComposer
                composer={composer}
                store={store}
                transport={TRANSPORT}
                placeholder="Reply in the thread"
                inputLabel="Thread reply"
                initialLayout={layout}
            />
        </div>
    );
}

function composerKey(layout: ComposerLayout, kind: string, issue: boolean): string {
    return `gallery:${layout}:${kind}${issue ? ':issue' : ''}`;
}

function IssueState({ issue }: { issue?: boolean }) {
    const [store] = useState(() => {
        const created = createThreadStore([], FILE_IDS);
        created.openComposer({
            key: `gallery:issue:${issue === undefined ? 'unsupported' : String(issue)}`,
            threadId: null,
            parentId: null,
            anchor: null,
            ...(issue === undefined ? {} : { issue }),
            text: 'Check zero width before Ship.',
            commentId: null,
            status: 'idle',
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        return created;
    });
    const key = `gallery:issue:${issue === undefined ? 'unsupported' : String(issue)}`;
    const subscribe = useCallback((listener: () => void) => store.subscribeComposer(key, listener), [key, store]);
    const getSnapshot = useCallback(() => store.getComposer(key), [key, store]);
    const composer = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    if (composer === null) {
        return null;
    }
    return (
        <div className="gallery-composer">
            <CommentComposer
                composer={composer}
                store={store}
                transport={TRANSPORT}
                placeholder="A general remark on the PR — not tied to a line"
                inputLabel="New comment"
                initialLayout="markdown"
            />
        </div>
    );
}

function CollapsedState({ draft }: { draft: boolean }) {
    const [store] = useState(() => createThreadStore([], FILE_IDS));
    const thread: Thread = draft
        ? { ...THREAD, root: { ...THREAD.root, replies: [...THREAD.root.replies, DRAFT] } }
        : THREAD;
    return (
        <div className="gallery-composer">
            <ThreadList
                threads={[thread]}
                store={store}
                actions={{ transport: TRANSPORT, commentIssues: true, resolve: () => Promise.resolve(true) }}
                now={Date.parse('2026-08-28T14:02:00.000Z')}
            />
        </div>
    );
}
