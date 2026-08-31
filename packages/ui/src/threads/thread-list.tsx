import type { Comment, FileAnchor, Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import { updateFragment } from '../fragment.js';
import { Icon } from '../icons/icon.tsx';
import { Markdown } from '../markdown/markdown.tsx';
import { plural } from '../text.js';
import { closeCommentComposers } from './composer.js';
import type { ComposerTransport } from './composer.js';
import { CommentComposer } from './comment-composer.tsx';
import type { ComposerLayout } from './composer-markdown.js';
import { draftEditComposerKey, DraftEditor, openDraftEditor, useActiveDraftEditor } from './draft-editor.tsx';
import { authorName, flattenThread } from './model.js';
import { relativeTime } from './relative-time.js';
import type { ComposerSnapshot, ThreadStore } from './store.js';
import './threads.css';

export interface ThreadActions {
    readonly transport: ComposerTransport;
    readonly resolve: (threadId: string, resolved: boolean) => Promise<boolean>;
}

export function ThreadList({
    threads,
    store,
    actions,
    now,
    onFocusThread,
    inlineDraftEditing = false,
    initialLayout,
}: {
    threads: readonly Thread[];
    store: ThreadStore;
    actions: ThreadActions;
    now: number;
    onFocusThread?: ((threadId: string | null) => void) | undefined;
    inlineDraftEditing?: boolean;
    initialLayout?: ComposerLayout;
}) {
    return (
        <div className="thread-list">
            {threads.map((thread) => (
                <ThreadBlock
                    key={thread.id}
                    thread={thread}
                    store={store}
                    actions={actions}
                    now={now}
                    onFocusThread={onFocusThread}
                    inlineDraftEditing={inlineDraftEditing}
                    {...(initialLayout === undefined ? {} : { initialLayout })}
                />
            ))}
        </div>
    );
}

function ThreadBlock({
    thread,
    store,
    actions,
    now,
    onFocusThread,
    inlineDraftEditing,
    initialLayout,
}: {
    thread: Thread;
    store: ThreadStore;
    actions: ThreadActions;
    now: number;
    onFocusThread?: ((threadId: string | null) => void) | undefined;
    inlineDraftEditing: boolean;
    initialLayout?: ComposerLayout;
}) {
    const all = useMemo(() => flattenThread(thread.root), [thread.root]);
    const commentIds = useMemo(() => all.map((row) => row.comment.id), [all]);
    const editingId = useActiveDraftEditor(store, commentIds);
    const [repliesOpen, setRepliesOpen] = useState(true);
    const [expanded, setExpanded] = useState(false);
    const [confirmingId, setConfirmingId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [deleteErrorId, setDeleteErrorId] = useState<string | null>(null);
    const collapseBot = repliesOpen && thread.root.author.bot && all.length > 5 && !expanded;
    const shown = !repliesOpen
        ? all.slice(0, 1)
        : collapseBot
          ? [all[0], all[1], ...all.slice(-2)].filter((row) => row !== undefined)
          : all;
    const hidden = Math.max(all.length - shown.length, 0);
    const draftReply = replyDraft(thread);
    const replyComposer = useComposerSnapshot(store, `reply:${thread.id}`);
    // OutsideThreads also edits drafts inline: the row sets availability, not the list container.
    const draftEditorAvailable =
        draftReply !== null &&
        (editingId === draftReply.id || shown.some((row) => row.comment.id === draftReply.id));
    // The third argument is the same snapshot. The store is isomorphic, and tests render the cards statically.
    const undoEntry =
        useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).undo.get(thread.id) ?? null;
    const undo = undoEntry?.resolved ?? null;
    const hideActions = thread.root.draft;

    const setResolved = (resolved: boolean): void => {
        const generation = store.startUndo(thread.id, resolved);
        void actions.resolve(thread.id, resolved).then((saved) => {
            if (!saved) {
                store.clearUndo(thread.id, generation);
            }
        });
    };

    const deleteDraft = async (commentId: string): Promise<void> => {
        setDeletingId(commentId);
        setDeleteErrorId(null);
        store.beginDraftDeletion(commentId);
        try {
            await actions.transport.delete(commentId);
            closeCommentComposers(store, [commentId]);
            store.deleteDraft(commentId);
            setConfirmingId(null);
        } catch {
            setDeleteErrorId(commentId);
        } finally {
            store.endDraftDeletion(commentId);
            setDeletingId(null);
        }
    };

    return (
        <section
            className={`thread thread-fade${thread.root.author.bot ? ' thread--bot' : ''}${thread.resolved ? ' thread--resolved' : ''}`}
            id={`thread-${thread.id}`}
            data-thread-id={thread.id}
            tabIndex={0}
            onFocus={() => {
                onFocusThread?.(thread.id);
            }}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                    onFocusThread?.(null);
                }
            }}
        >
            {shown.map((row, index) => (
                <div
                    key={row.comment.id}
                    className={`thread__row${index > 0 ? ' thread__row--reply' : ''}${editingId === row.comment.id ? ' is-editing' : ''}`}
                    style={{ marginLeft: `${String(row.indent)}px` }}
                >
                    {row.replyHint === null ? null : (
                        <div className="thread__reply-hint">
                            <Icon name="reply" size={13} />
                            {row.replyHint}
                        </div>
                    )}
                    <div className="thread__author-line">
                        <span className={`thread__avatar${row.comment.author.bot ? ' thread__avatar--bot' : ''}`}>
                            {initials(row.comment.author.displayName ?? row.comment.author.login)}
                        </span>
                        <strong className="thread__author">
                            {row.comment.author.bot ? row.comment.author.login : authorName(row.comment)}
                        </strong>
                        <span className="thread__meta">{metaOf(thread, row.comment.createdAt, now)}</span>
                        {row.comment.author.bot ? (
                            <span className="thread__chip">{row.comment.author.displayName ?? row.comment.author.login}</span>
                        ) : null}
                        {thread.resolved && index === 0 ? <span className="thread__chip">resolved</span> : null}
                        {thread.outdated && index === 0 ? <span className="thread__chip">outdated</span> : null}
                        {editingId === row.comment.id ? (
                            <span className="thread__chip thread__chip--editing">editing</span>
                        ) : row.comment.draft ? (
                            <span className="thread__chip thread__chip--draft">draft · publishes on ship</span>
                        ) : null}
                        <span className="thread__spacer" />
                        {row.comment.draft &&
                        editingId !== row.comment.id &&
                        replyComposer?.commentId !== row.comment.id ? (
                            <span className="thread__draft-actions">
                                <button
                                    type="button"
                                    className="thread__edit-draft"
                                    aria-label={`Edit draft ${row.comment.id}`}
                                    title="Edit the draft"
                                    disabled={editingId !== null || deletingId !== null}
                                    onClick={() => {
                                        setConfirmingId(null);
                                        openDraftEditor(store, thread, row.comment);
                                    }}
                                >
                                    <Icon name="pencil" size={14} />
                                </button>
                                <button
                                    type="button"
                                    className="thread__delete-draft"
                                    aria-label={`Delete draft ${row.comment.id}`}
                                    title="Delete the draft"
                                    disabled={editingId !== null || deletingId !== null}
                                    onClick={() => {
                                        setDeleteErrorId(null);
                                        setConfirmingId(row.comment.id);
                                    }}
                                >
                                    <Icon name="trash" size={14} />
                                </button>
                            </span>
                        ) : null}
                        {row.subtreeReplies > 0 ? (
                            index === 0 ? (
                                <button
                                    type="button"
                                    className="thread__reply-count thread__reply-toggle"
                                    aria-expanded={repliesOpen}
                                    onClick={() => {
                                        setRepliesOpen((value) => !value);
                                    }}
                                >
                                    {row.subtreeReplies}{' '}{plural(row.subtreeReplies, 'reply', 'replies', 'replies')}
                                    <Icon name={repliesOpen ? 'chev-down' : 'chev-right'} size={13} />
                                </button>
                            ) : (
                                <span className="thread__reply-count">
                                    {row.subtreeReplies}{' '}{plural(row.subtreeReplies, 'reply', 'replies', 'replies')}
                                    <Icon name="chev-right" size={13} />
                                </span>
                            )
                        ) : null}
                    </div>
                    {editingId === row.comment.id ? (
                        <DraftEditor
                            comment={row.comment}
                            store={store}
                            transport={actions.transport}
                            contextLabel="draft editing"
                            placeholder="Comment on the line"
                            inputLabel="Draft editing"
                            {...(initialLayout === undefined ? {} : { initialLayout })}
                        />
                    ) : (
                        <div className="thread__body">
                            <Markdown text={row.comment.body} profile="comment" />
                        </div>
                    )}
                    {confirmingId === row.comment.id ? (
                        <div className="thread__delete-confirm">
                            <span>
                                {deleteErrorId === row.comment.id
                                    ? 'Could not delete the draft. Retry?'
                                    : 'Delete the draft? It will not be published'}
                            </span>
                            <span className="thread__spacer" />
                            <button
                                type="button"
                                className="thread__delete-confirm-button"
                                disabled={deletingId === row.comment.id}
                                onClick={() => void deleteDraft(row.comment.id)}
                            >
                                {deletingId === row.comment.id ? 'Deleting…' : 'Delete'}
                            </button>
                            <button
                                type="button"
                                className="thread__keep-draft"
                                disabled={deletingId === row.comment.id}
                                onClick={() => {
                                    setDeleteErrorId(null);
                                    setConfirmingId(null);
                                }}
                            >
                                Keep
                            </button>
                        </div>
                    ) : null}
                </div>
            ))}

            {collapseBot ? (
                <button
                    type="button"
                    className="thread__more"
                    onClick={() => {
                        setExpanded(true);
                    }}
                >
                    {hidden} more
                </button>
            ) : null}

            {hideActions ? null : (
                <>
                    <div className={`thread__actions${undo === null ? '' : ' thread__actions--undo'}`}>
                        {undo === null ? (
                            <>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setResolved(!thread.resolved);
                                    }}
                                >
                                    {thread.resolved ? 'Reopen' : 'Resolve'}
                                </button>
                                {inlineDraftEditing ? null : (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            void copyThreadLink(thread.id);
                                        }}
                                    >
                                        Copy link
                                    </button>
                                )}
                            </>
                        ) : (
                            <span className="thread__undo">
                                {undo ? 'resolved' : 'reopened'} ·{' '}
                                <button
                                    type="button"
                                    onClick={() => {
                                        setResolved(!undo);
                                    }}
                                >
                                    undo
                                </button>
                            </span>
                        )}
                    </div>

                    <ComposerForThread
                        thread={thread}
                        store={store}
                        transport={actions.transport}
                        draft={draftReply}
                        draftEditorAvailable={draftEditorAvailable}
                        composer={replyComposer}
                    />
                </>
            )}
        </section>
    );
}

export function OutsideThreads({
    threads,
    store,
    actions,
    now,
    initialThreadId = null,
    defaultOpen = false,
    onFocusThread,
}: {
    threads: readonly Thread[];
    store: ThreadStore;
    actions: ThreadActions;
    now: number;
    initialThreadId?: string | null;
    defaultOpen?: boolean;
    onFocusThread?: ((threadId: string | null) => void) | undefined;
}) {
    const [opened, setOpened] = useState(defaultOpen);
    const open = opened || threads.some((thread) => thread.id === initialThreadId);
    if (threads.length === 0) {
        return null;
    }
    return (
        <section className="thread-outside">
            <button
                type="button"
                className="thread-outside__toggle"
                aria-expanded={open}
                onClick={() => {
                    setOpened(!open);
                }}
            >
                {threads.length}{' '}{plural(threads.length, 'thread', 'threads', 'threads')} outside the diff
                <Icon name={open ? 'chev-down' : 'chev-right'} size={13} />
            </button>
            {open ? (
                <ThreadList threads={threads} store={store} actions={actions} now={now} onFocusThread={onFocusThread} />
            ) : null}
        </section>
    );
}

export function NewCommentComposer({
    composerKey,
    store,
    transport,
    contextLabel,
    placeholder,
    saveLabel,
    footerHint,
    initialLayout,
    onSaveComplete,
    showDraftChip = false,
}: {
    composerKey: string;
    store: ThreadStore;
    transport: ComposerTransport;
    contextLabel?: string;
    placeholder?: string;
    saveLabel?: 'Save draft' | 'Save changes';
    footerHint?: ReactNode;
    initialLayout?: ComposerLayout;
    onSaveComplete?: (() => void) | undefined;
    showDraftChip?: boolean;
}) {
    const composer = useComposerSnapshot(store, composerKey);
    if (composer === null) {
        return null;
    }
    const position = composer.anchor?.position;
    return (
        <CommentComposer
            composer={composer}
            store={store}
            transport={transport}
            contextLabel={contextLabel ?? (position == null ? 'PR comment' : `new comment · ${lineRangeLabel(position)}`)}
            placeholder={placeholder ?? (position == null ? 'A general remark on the PR — not tied to a line' : 'Comment on the code line')}
            inputLabel="New comment"
            saveLabel={saveLabel ?? (composer.commentId === null ? 'Save draft' : 'Save changes')}
            closeOnSave
            showDraftChip={showDraftChip}
            {...(composer.commentId === null
                ? {}
                : { restoreOnCancel: composer.originalText ?? composer.text })}
            {...(footerHint === undefined ? {} : { footerHint })}
            {...(initialLayout === undefined ? {} : { initialLayout })}
            {...(onSaveComplete === undefined ? {} : { onSaveComplete })}
        />
    );
}

function ComposerForThread({
    thread,
    store,
    transport,
    draft,
    draftEditorAvailable,
    composer,
}: {
    thread: Thread;
    store: ThreadStore;
    transport: ComposerTransport;
    draft: Comment | null;
    draftEditorAvailable: boolean;
    composer: ComposerSnapshot | null;
}) {
    if (composer === null) {
        if (draft !== null && draftEditorAvailable) {
            return null;
        }
        if (draft !== null) {
            return (
                <button
                    type="button"
                    className="thread-composer-draft-preview"
                    aria-label="Continue draft"
                    onClick={() => {
                        openReply(store, thread, draft);
                    }}
                >
                    <span className="thread-composer-draft-preview__meta">
                        <span className="thread__chip thread__chip--draft">draft · publishes on ship</span>
                    </span>
                    <span className="thread-composer-draft-preview__body">{draft.body}</span>
                </button>
            );
        }
        return (
            <button
                type="button"
                className="thread-composer-entry"
                onClick={() => {
                    openReply(store, thread, null);
                }}
            >
                <span>Reply…</span>
                <Icon name="pencil" size={13} />
            </button>
        );
    }
    const resolvedWhileTyping = !composer.resolvedAtOpen && thread.resolved;
    return (
        <CommentComposer
            composer={composer}
            store={store}
            transport={transport}
            contextLabel={`reply to ${authorName(thread.root)}`}
            placeholder="Reply in the thread"
            inputLabel="Thread reply"
            saveLabel={composer.commentId === null ? 'Save draft' : 'Save changes'}
            closeOnSave
            {...(composer.commentId === null
                ? {}
                : { restoreOnCancel: composer.originalText ?? draft?.body ?? composer.text })}
            notice={
                resolvedWhileTyping
                    ? `resolved by ${thread.resolvedBy ?? 'another reviewer'} while you were writing · your reply will reopen it`
                    : undefined
            }
        />
    );
}

function useComposerSnapshot(store: ThreadStore, key: string): ComposerSnapshot | null {
    const subscribe = useCallback((listener: () => void) => store.subscribeComposer(key, listener), [key, store]);
    const getSnapshot = useCallback(() => store.getComposer(key), [key, store]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function replyDraft(thread: Thread): Comment | null {
    let draft: Comment | null = null;
    for (const row of flattenThread(thread.root)) {
        if (row.comment.id !== thread.root.id && row.comment.draft) {
            draft = row.comment;
        }
    }
    return draft;
}

export const PR_COMPOSER_KEY = 'new:pr';

export function openPrComposer(store: ThreadStore, commentIssues: boolean): void {
    const key = PR_COMPOSER_KEY;
    if (store.getComposer(key) !== null) {
        return;
    }
    store.openComposer({
        key,
        threadId: null,
        parentId: null,
        anchor: null,
        ...(commentIssues ? { issue: true } : {}),
        text: '',
        commentId: null,
        status: 'idle',
        saveUncertain: false,
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
}

export function openNewComposer(
    store: ThreadStore,
    key: string,
    anchor: FileAnchor,
    commentIssues: boolean,
): void {
    if (store.getComposer(key) !== null) {
        return;
    }
    store.openComposer({
        key,
        threadId: null,
        parentId: null,
        anchor,
        ...(commentIssues ? { issue: true } : {}),
        text: '',
        commentId: null,
        status: 'idle',
        saveUncertain: false,
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
}

export function openReply(store: ThreadStore, thread: Thread, draft: Comment | null = replyDraft(thread)): void {
    const key = `reply:${thread.id}`;
    if (
        store.getComposer(key) !== null ||
        (draft !== null && store.getComposer(draftEditComposerKey(draft.id)) !== null)
    ) {
        return;
    }
    store.openComposer({
        key,
        threadId: thread.id,
        parentId: thread.root.id,
        anchor: null,
        text: draft?.body ?? '',
        ...(draft === null ? {} : { originalText: draft.body }),
        commentId: draft?.id ?? null,
        status: draft === null ? 'idle' : 'saved',
        savedAt: draft === null ? null : Date.parse(draft.editedAt ?? draft.createdAt),
        saveUncertain: false,
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: thread.resolved,
    });
}

function metaOf(thread: Thread, createdAt: string, now: number): string {
    const path = thread.anchor?.path.split('/').at(-1) ?? 'PR';
    const position = thread.anchor?.position;
    return `${path}${position == null ? '' : `:${lineRange(position)}`} · ${relativeTime(createdAt, now)}`;
}

function lineRangeLabel(position: { readonly line: number; readonly size: number }): string {
    return position.size > 1 ? `lines ${lineRange(position)}` : `line ${String(position.line)}`;
}

function lineRange(position: { readonly line: number; readonly size: number }): string {
    const last = position.line + Math.max(position.size, 1) - 1;
    return last === position.line ? String(position.line) : `${String(position.line)}–${String(last)}`;
}

function initials(name: string): string {
    return name
        .split(/[\s._-]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('');
}

async function copyThreadLink(threadId: string): Promise<void> {
    const url = new URL(window.location.href);
    url.hash = updateFragment(window.location.hash, { thread: threadId, file: null });
    await navigator.clipboard.writeText(url.toString());
}
