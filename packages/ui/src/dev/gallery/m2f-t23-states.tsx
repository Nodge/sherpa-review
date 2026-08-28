import { fixtureData } from '@sherpa/fixtures';
import type { Comment, Thread } from '@sherpa/protocol';
import { useCallback, useState, useSyncExternalStore } from 'react';

import { CommentComposer } from '../../threads/comment-composer.tsx';
import type { ComposerTransport } from '../../threads/composer.js';
import type { ComposerLayout } from '../../threads/composer-markdown.js';
import { ThreadList } from '../../threads/thread-list.tsx';
import type { ComposerSnapshot } from '../../threads/store.js';
import { createThreadStore } from '../../threads/store.js';

const DATA = fixtureData('medium');
const THREAD = firstThread();
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const SAVED_AT = Date.parse('2026-08-28T14:02:00');
const DRAFT: Comment = {
    id: 'gallery-composer-draft',
    author: { login: 'alice', displayName: 'Alice Ingram', bot: false },
    body: 'I will check one more edge case before Ship.',
    draft: true,
    createdAt: '2026-08-28T14:02:00.000Z',
    editedAt: null,
    replies: [],
};
const TRANSPORT: ComposerTransport = {
    save: () => Promise.resolve(DRAFT),
    update: () => Promise.resolve(),
    delete: () => Promise.resolve(),
};

function firstThread(): Thread {
    const thread = DATA.threads[0];
    if (thread === undefined) {
        throw new Error('The composer gallery needs a thread from fixture-medium.');
    }
    return thread;
}

export const M2F_T23_STATES = [
    { id: 'composer-rest', title: 'idle, "Reply…"', render: () => <CollapsedState draft={false} /> },
    { id: 'composer-empty', title: 'open, placeholder', render: () => <OpenState layout="visual" kind="empty" /> },
    { id: 'composer-visual', title: 'text, Visual', render: () => <OpenState layout="visual" kind="saved" /> },
    { id: 'composer-markdown', title: 'text, Markdown', render: () => <OpenState layout="markdown" kind="saved" /> },
    { id: 'composer-error', title: 'autosave error', render: () => <OpenState layout="markdown" kind="error" /> },
    { id: 'composer-confirm', title: 'discard confirmation', render: () => <OpenState layout="visual" kind="confirm" /> },
    { id: 'composer-closed-draft', title: 'field closed, draft exists', render: () => <CollapsedState draft /> },
] as const;

function OpenState({
    layout,
    kind,
}: {
    layout: ComposerLayout;
    kind: 'empty' | 'saved' | 'error' | 'confirm';
}) {
    const [store] = useState(() => {
        const created = createThreadStore([], FILE_IDS);
        const text = kind === 'empty' ? '' : '**Guard** must be built inside the unit of work, otherwise `None` remains reachable.';
        const snapshot: ComposerSnapshot = {
            key: `gallery:${layout}:${kind}`,
            threadId: THREAD.id,
            parentId: THREAD.root.id,
            anchor: null,
            text,
            commentId: kind === 'saved' ? DRAFT.id : null,
            status: kind === 'error' ? 'error' : kind === 'saved' ? 'saved' : 'idle',
            savedAt: kind === 'saved' ? SAVED_AT : null,
            saveUncertain: false,
            slow: false,
            confirmDiscard: kind === 'confirm',
            resolvedAtOpen: false,
        };
        created.openComposer(snapshot);
        return created;
    });
    // Live subscription, as in ThreadList: without it, typing in the gallery updates the store,
    // while the composer keeps receiving a stale snapshot.
    const key = `gallery:${layout}:${kind}`;
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
                contextLabel="reply to ai-review-bot [bot]"
                placeholder="Reply in the thread"
                inputLabel="Thread reply"
                initialLayout={layout}
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
                actions={{ transport: TRANSPORT, resolve: () => Promise.resolve(true) }}
                now={Date.parse('2026-08-28T14:02:00.000Z')}
            />
        </div>
    );
}
