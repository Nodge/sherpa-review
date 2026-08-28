import type { FileAnchor, Thread } from '@sherpa/protocol';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import { updateFragment } from '../fragment.js';
import { Icon } from '../icons/icon.tsx';
import { Markdown } from '../markdown/markdown.tsx';
import { plural } from '../text.js';
import { composerControllerFor } from './composer.js';
import type { ComposerTransport } from './composer.js';
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
}: {
    threads: readonly Thread[];
    store: ThreadStore;
    actions: ThreadActions;
    now: number;
    onFocusThread?: ((threadId: string | null) => void) | undefined;
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
}: {
    thread: Thread;
    store: ThreadStore;
    actions: ThreadActions;
    now: number;
    onFocusThread?: ((threadId: string | null) => void) | undefined;
}) {
    const all = useMemo(() => flattenThread(thread.root), [thread.root]);
    const [repliesOpen, setRepliesOpen] = useState(true);
    const [expanded, setExpanded] = useState(false);
    const collapseBot = repliesOpen && thread.root.author.bot && all.length > 5 && !expanded;
    const shown = !repliesOpen
        ? all.slice(0, 1)
        : collapseBot
          ? [all[0], all[1], ...all.slice(-2)].filter((row) => row !== undefined)
          : all;
    const hidden = Math.max(all.length - shown.length, 0);
    // The third argument is the same snapshot. The store is isomorphic, and tests render the cards statically.
    const undoEntry =
        useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).undo.get(thread.id) ?? null;
    const undo = undoEntry?.resolved ?? null;

    const setResolved = (resolved: boolean): void => {
        const generation = store.startUndo(thread.id, resolved);
        void actions.resolve(thread.id, resolved).then((saved) => {
            if (!saved) {
                store.clearUndo(thread.id, generation);
            }
        });
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
                    className={`thread__row${index > 0 ? ' thread__row--reply' : ''}`}
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
                        {row.comment.draft ? <span className="thread__chip thread__chip--draft">draft · will publish on ship</span> : null}
                        <span className="thread__spacer" />
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
                    <div className="thread__body">
                        <Markdown text={row.comment.body} profile="comment" />
                    </div>
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
                        <button
                            type="button"
                            onClick={() => {
                                openReply(store, thread);
                            }}
                        >
                            Reply
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                void copyThreadLink(thread.id);
                            }}
                        >
                            Copy link
                        </button>
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

            <ComposerForThread thread={thread} store={store} transport={actions.transport} />
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
}: {
    composerKey: string;
    store: ThreadStore;
    transport: ComposerTransport;
}) {
    const composer = useComposerSnapshot(store, composerKey);
    return composer === null ? null : (
        <Composer composer={composer} store={store} transport={transport} thread={null} />
    );
}

function ComposerForThread({
    thread,
    store,
    transport,
}: {
    thread: Thread;
    store: ThreadStore;
    transport: ComposerTransport;
}) {
    const composer = useComposerSnapshot(store, `reply:${thread.id}`);
    return composer === null ? null : (
        <Composer composer={composer} store={store} transport={transport} thread={thread} />
    );
}

function useComposerSnapshot(store: ThreadStore, key: string): ComposerSnapshot | null {
    const subscribe = useCallback((listener: () => void) => store.subscribeComposer(key, listener), [key, store]);
    const getSnapshot = useCallback(() => store.getComposer(key), [key, store]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function Composer({
    composer,
    store,
    transport,
    thread,
}: {
    composer: ComposerSnapshot;
    store: ThreadStore;
    transport: ComposerTransport;
    thread: Thread | null;
}) {
    const controller = useMemo(
        () => composerControllerFor({ store, key: composer.key, transport }),
        [composer.key, store, transport],
    );
    const resolvedWhileTyping = thread !== null && !composer.resolvedAtOpen && thread.resolved;
    const ambiguousFirstSave = composer.status === 'error' && composer.saveUncertain && composer.commentId === null;
    const saveDisabledReason =
        composer.status === 'discarding'
            ? 'The draft is being deleted.'
            : ambiguousFirstSave
              ? 'Use the retry link in the save status.'
              : composer.text.trim() === ''
                ? 'Type the comment text.'
                : null;
    const cancelDisabledReason = composer.status === 'discarding' ? 'The draft is being deleted.' : null;
    return (
        <div className="thread-composer">
            {resolvedWhileTyping ? (
                <p className="thread-composer__notice">
                    resolved by {thread.resolvedBy ?? 'another reviewer'} while you were typing · your reply will reopen the thread
                </p>
            ) : null}
            <textarea
                className="thread-composer__input"
                value={composer.text}
                autoFocus
                disabled={composer.status === 'discarding'}
                aria-label={thread === null ? 'New comment' : 'Thread reply'}
                onChange={(event) => {
                    controller.input(event.target.value);
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void controller.saveNow(true);
                    } else if (event.key === 'Escape') {
                        event.preventDefault();
                        controller.escape();
                    }
                }}
            />
            <div className="thread-composer__actions">
                <button
                    type="button"
                    className="ghost-button"
                    disabled={saveDisabledReason !== null}
                    title={saveDisabledReason ?? undefined}
                    onClick={() => void controller.saveNow(true)}
                >
                    Save draft
                </button>
                <button
                    type="button"
                    className="ghost-button"
                    disabled={cancelDisabledReason !== null}
                    title={cancelDisabledReason ?? undefined}
                    onClick={controller.escape}
                >
                    Cancel
                </button>
            </div>
            {composer.confirmDiscard ? (
                <p className="thread-composer__confirm">
                    Discard this draft?{' '}
                    <button type="button" onClick={() => void controller.confirmDiscard()}>
                        discard
                    </button>{' '}
                    <button type="button" onClick={controller.keepEditing}>
                        continue
                    </button>
                </p>
            ) : (
                <p className={`thread-composer__status${composer.status === 'error' ? ' is-error' : ''}`}>
                    {composer.status === 'discarding' ? (
                        'deleting…'
                    ) : ambiguousFirstSave ? (
                        <>
                            could not confirm the save · retrying may create a duplicate ·{' '}
                            <button type="button" onClick={() => void controller.retry()}>
                                retry anyway
                            </button>
                        </>
                    ) : composer.status === 'error' ? (
                        <>
                            not saved ·{' '}
                            <button type="button" onClick={() => void controller.retry()}>
                                retry
                            </button>
                        </>
                    ) : composer.slow ? (
                        'saving…'
                    ) : composer.commentId !== null || composer.status === 'saved' ? (
                        'saved as draft'
                    ) : (
                        'will save as draft'
                    )}
                </p>
            )}
        </div>
    );
}

export function openPrComposer(store: ThreadStore): void {
    const key = 'new:pr';
    if (store.getComposer(key) !== null) {
        return;
    }
    store.openComposer({
        key,
        threadId: null,
        parentId: null,
        anchor: null,
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
): void {
    if (store.getComposer(key) !== null) {
        return;
    }
    store.openComposer({
        key,
        threadId: null,
        parentId: null,
        anchor,
        text: '',
        commentId: null,
        status: 'idle',
        saveUncertain: false,
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
}

export function openReply(store: ThreadStore, thread: Thread): void {
    const key = `reply:${thread.id}`;
    if (store.getComposer(key) !== null) {
        return;
    }
    store.openComposer({
        key,
        threadId: thread.id,
        parentId: thread.root.id,
        anchor: null,
        text: '',
        commentId: null,
        status: 'idle',
        saveUncertain: false,
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: thread.resolved,
    });
}

function metaOf(thread: Thread, createdAt: string, now: number): string {
    const path = thread.anchor?.path.split('/').at(-1) ?? 'PR';
    const line = thread.anchor?.position?.line;
    return `${path}${line === undefined ? '' : `:${String(line)}`} · ${relativeTime(createdAt, now)}`;
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
