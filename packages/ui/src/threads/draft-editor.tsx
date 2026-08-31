import type { Comment, Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import type { ComposerTransport } from './composer.js';
import { CommentComposer } from './comment-composer.tsx';
import type { ComposerLayout } from './composer-markdown.js';
import type { ComposerSnapshot, ThreadStore } from './store.js';

export function draftEditComposerKey(commentId: string): string {
    return `edit:${commentId}`;
}

/** Opens an existing draft for editing independently of the bottom line composer. */
export function openDraftEditor(store: ThreadStore, thread: Thread, comment: Comment): void {
    const key = draftEditComposerKey(comment.id);
    if (store.getComposer(key) !== null) {
        return;
    }
    store.openComposer({
        key,
        threadId: thread.id,
        parentId: null,
        anchor: null,
        text: comment.body,
        originalText: comment.body,
        commentId: comment.id,
        status: 'saved',
        savedAt: Date.parse(comment.editedAt ?? comment.createdAt),
        saveUncertain: false,
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: thread.resolved,
    });
}

/** Active edit from the store, retained across virtualization and closed with the composer. */
export function useActiveDraftEditor(store: ThreadStore, commentIds: readonly string[]): string | null {
    const keys = useMemo(() => commentIds.map(draftEditComposerKey), [commentIds]);
    const subscribe = useCallback(
        (listener: () => void) => {
            const unsubscribes = keys.map((key) => store.subscribeComposer(key, listener));
            return () => {
                for (const unsubscribe of unsubscribes) {
                    unsubscribe();
                }
            };
        },
        [keys, store],
    );
    const getSnapshot = useCallback(
        () => commentIds.find((commentId) => store.getComposer(draftEditComposerKey(commentId)) !== null) ?? null,
        [commentIds, store],
    );
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function DraftEditor({
    comment,
    store,
    transport,
    contextLabel,
    placeholder,
    inputLabel,
    footerHint,
    initialLayout,
}: {
    comment: Comment;
    store: ThreadStore;
    transport: ComposerTransport;
    contextLabel: string;
    placeholder: string;
    inputLabel: string;
    footerHint?: ReactNode;
    initialLayout?: ComposerLayout;
}) {
    const key = draftEditComposerKey(comment.id);
    const composer = useComposerSnapshot(store, key);
    if (composer === null) {
        return null;
    }
    return (
        <CommentComposer
            composer={composer}
            store={store}
            transport={transport}
            contextLabel={contextLabel}
            placeholder={placeholder}
            inputLabel={inputLabel}
            saveLabel="Save changes"
            {...(footerHint === undefined ? {} : { footerHint })}
            {...(initialLayout === undefined ? {} : { initialLayout })}
            restoreOnCancel={composer.originalText ?? comment.body}
        />
    );
}

function useComposerSnapshot(store: ThreadStore, key: string): ComposerSnapshot | null {
    const subscribe = useCallback((listener: () => void) => store.subscribeComposer(key, listener), [key, store]);
    const getSnapshot = useCallback(() => store.getComposer(key), [key, store]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
