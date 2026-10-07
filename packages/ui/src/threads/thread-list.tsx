import type { Comment, FileAnchor, Locale, Thread } from '@sherpa/protocol';
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import { Avatar } from '../components/avatar.tsx';
import type { Translate } from '../i18n/index.js';
import { relativeTime, shortCommit, useLocale, useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { useReadOnlyIteration, useReadOnlyReason } from '../iterations/read-only.tsx';
import { useThreadPin } from '../iterations/thread-pin.tsx';
import type { ThreadPinState } from '../iterations/thread-pin.tsx';
import { Markdown } from '../markdown/markdown.tsx';
import { closeCommentComposers, composerControllerFor } from './composer.js';
import type { ComposerTransport } from './composer.js';
import { CommentComposer } from './comment-composer.tsx';
import type { ComposerSaveLabel } from './comment-composer.tsx';
import type { ComposerLayout } from './composer-markdown.js';
import { DeleteConfirm } from './delete-confirm.tsx';
import { draftEditComposerKey, DraftEditor, openDraftEditor, useActiveDraftEditor } from './draft-editor.tsx';
import { authorName, commentFirstLine, flattenThread } from './model.js';
import type { ComposerSnapshot, ThreadStore } from './store.js';
import type { PublishedCommentTransport } from './transport.js';
import { publishedCommentComposerTransport } from './transport.js';
import './threads.css';

export interface ThreadActions {
    readonly transport: ComposerTransport;
    /** The host's `capabilities.commentIssues`. Without it, replies have no issue switch. */
    readonly commentIssues?: boolean;
    readonly resolve: (threadId: string, resolved: boolean) => Promise<boolean>;
    /**
     * Resolves a single issue comment. `null`/absent means the host lacks `capabilities.commentResolve`,
     * so the only button stays at the thread root.
     */
    readonly resolveComment?: ((commentId: string, resolved: boolean) => Promise<boolean>) | null;
    /** Editing and deleting your published comments. `null` means the host lacks `capabilities.editPublished`. */
    readonly published?: PublishedCommentTransport | null;
}

/** Thread presentation: a strip under a code line or a card in the "PR comments" modal (§4). */
export type ThreadVariant = 'line' | 'card';

/**
 * Collapsing a whole thread into a preview row is limited to the PR modal. Beside code,
 * a marker on the card border plays the same role (docs/design/SPEC-changes-2026-09-20.md §3, §4).
 * The thread store keeps one expansion state per thread, shared by both locations.
 */
export interface ThreadCollapse {
    readonly openThreads: ReadonlySet<string>;
    readonly onToggle: (threadId: string) => void;
}

export function ThreadList({
    threads,
    store,
    actions,
    now,
    onFocusThread,
    initialLayout,
    variant = 'line',
    collapse,
}: {
    threads: readonly Thread[];
    store: ThreadStore;
    actions: ThreadActions;
    now: number;
    onFocusThread?: ((threadId: string | null) => void) | undefined;
    initialLayout?: ComposerLayout;
    variant?: ThreadVariant;
    collapse?: ThreadCollapse;
}) {
    return (
        <div className={`thread-list${variant === 'card' ? ' thread-list--card' : ''}`}>
            {threads.map((thread) => (
                <ThreadBlock
                    key={thread.id}
                    thread={thread}
                    store={store}
                    actions={actions}
                    now={now}
                    onFocusThread={onFocusThread}
                    variant={variant}
                    {...(collapse === undefined ? {} : { collapse })}
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
    initialLayout,
    variant = 'line',
    collapse,
}: {
    thread: Thread;
    store: ThreadStore;
    actions: ThreadActions;
    now: number;
    onFocusThread?: ((threadId: string | null) => void) | undefined;
    initialLayout?: ComposerLayout;
    variant?: ThreadVariant;
    collapse?: ThreadCollapse;
}) {
    const t = useT();
    const locale = useLocale();
    // A thread from a previous iteration is read-only: no replies, resolution or draft editing.
    const readOnly = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();
    // Pin to the commit where the thread was written: a chip and "Show on old commit" link.
    const pinned = useThreadPin(thread);
    const all = useMemo(() => flattenThread(thread.root), [thread.root]);
    const commentIds = useMemo(() => all.map((row) => row.comment.id), [all]);
    const editingId = useActiveDraftEditor(store, commentIds);
    const [confirmingId, setConfirmingId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [deleteErrorId, setDeleteErrorId] = useState<string | null>(null);
    const draftReply = replyDraft(thread);
    const replyComposer = useComposerSnapshot(store, replyComposerKey(thread.id));
    // The composer expands under the message where the reviewer clicked Reply,
    // instead of at the end of the thread (§3, §4). The thread has one composer key. Only its location changes.
    const replyUnder = replyComposer?.replyUnder ?? null;
    // The third argument is the same snapshot. The store is isomorphic, and tests render the cards statically.
    const viewerLogin = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).viewerLogin;
    const publishedTransport = actions.published ?? null;
    const editorTransport = useMemo(
        () => (publishedTransport === null ? null : publishedCommentComposerTransport(publishedTransport)),
        [publishedTransport],
    );
    const hideReplyComposer = thread.root.draft;
    const card = variant === 'card';
    const editingComment = all.find((row) => row.comment.id === editingId)?.comment ?? null;
    /**
     * An open composer (reply or edit) and deletion confirmation keep the thread expanded.
     * A collapsed row would hide the entered text, while the publishing guard would still
     * count it. So collapsing goes through `toggleCollapsed`, instead of directly through `collapse.onToggle`.
     */
    const busy = replyComposer !== null || editingComment !== null || confirmingId !== null;
    // A collapsed thread leaves one visible row: chevron, root header and first-line preview.
    const collapsed = collapse !== undefined && !collapse.openThreads.has(thread.id) && !busy;
    const rows = collapsed ? all.slice(0, 1) : all;
    const replies = all.length - 1;
    // The reply composer stays under its message only while it is open and the message is visible.
    const inlineReplyId =
        replyComposer !== null && replyUnder !== null && rows.some((row) => row.comment.id === replyUnder)
            ? replyUnder
            : null;

    const setThreadResolved = (resolved: boolean): void => {
        void actions.resolve(thread.id, resolved);
    };

    /**
     * The chevron and preview collapse and expand the thread after clearing what keeps it
     * expanded. An empty composer closes on its own. If it has text, it asks to discard it.
     * Deletion confirmation is cancelled. The next click collapses the thread.
     */
    const toggleCollapsed = (): void => {
        if (collapse === undefined) {
            return;
        }
        if (!busy) {
            collapse.onToggle(thread.id);
            return;
        }
        setDeleteErrorId(null);
        setConfirmingId(null);
        if (replyComposer !== null) {
            composerControllerFor({ store, key: replyComposer.key, transport: actions.transport }).escape();
        }
        if (editingComment !== null) {
            composerControllerFor({
                store,
                key: draftEditComposerKey(editingComment.id),
                transport: editingComment.draft ? actions.transport : (editorTransport ?? actions.transport),
            }).escape();
        }
    };

    const remove = async (comment: Comment): Promise<void> => {
        setDeletingId(comment.id);
        setDeleteErrorId(null);
        store.beginDraftDeletion(comment.id);
        try {
            if (comment.draft) {
                await actions.transport.delete(comment.id);
            } else {
                await publishedTransport?.delete(comment.id);
            }
            closeCommentComposers(store, [comment.id]);
            // Remove the comment optimistically. The next host snapshot will confirm it.
            store.deleteDraft(comment.id);
            setConfirmingId(null);
        } catch {
            setDeleteErrorId(comment.id);
        } finally {
            store.endDraftDeletion(comment.id);
            setDeletingId(null);
        }
    };

    const composer = hideReplyComposer ? null : (
        <ComposerForThread
            thread={thread}
            store={store}
            transport={actions.transport}
            draft={draftReply}
            composer={replyComposer}
        />
    );

    return (
        <section
            className={`thread thread-fade${thread.root.author.bot ? ' thread--bot' : ''}${thread.resolved ? ' thread--resolved' : ''}${card ? ' thread--card' : ''}${card && thread.root.draft ? ' thread--draft' : ''}${collapsed ? ' is-collapsed' : ''}`}
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
            {rows.map((row, index) => {
                const comment = row.comment;
                const editing = editingId === comment.id;
                const mine = comment.draft || (viewerLogin !== null && comment.author.login === viewerLogin);
                // A draft already open in the reply composer is edited there. No second pair of links is needed.
                const editable =
                    replyComposer?.commentId !== comment.id &&
                    (comment.draft || (mine && editorTransport !== null));
                // No host allows deleting a message with replies, because the replies would lose their
                // parent. It has no Delete link at all, even a disabled one.
                const deletable = editable && comment.replies.length === 0;
                const resolve = resolveControl(thread, comment, index, actions);
                return (
                    <div
                        key={comment.id}
                        className={`thread__row${index > 0 ? ' thread__row--reply' : ''}${editing ? ' is-editing' : ''}`}
                        data-comment-id={comment.id}
                        style={replyIndentStyle(row.indent)}
                    >
                        <div className="thread__author-line">
                            {collapse === undefined || index !== 0 ? null : (
                                <button
                                    type="button"
                                    className="ctl ctl--chevron thread__chevron"
                                    aria-expanded={!collapsed}
                                    aria-label={t(
                                        collapsed ? 'thread.marker.expand' : 'thread.marker.collapse',
                                        authorName(thread.root),
                                        commentFirstLine(thread.root.body, 60),
                                    )}
                                    onClick={toggleCollapsed}
                                >
                                    <Icon name={collapsed ? 'chev-right' : 'chev-down'} size={13} />
                                </button>
                            )}
                            <Avatar
                                className="thread__avatar"
                                name={comment.author.displayName ?? comment.author.login}
                                url={comment.author.avatarUrl}
                            />
                            <strong className="thread__author">
                                {comment.author.bot ? comment.author.login : authorName(comment)}
                            </strong>
                            {/* Indentation stops growing after level 4, and the label names the recipient. */}
                            {row.replyHintAuthor === null ? null : (
                                <span className="thread__reply-hint">↳ {row.replyHintAuthor}</span>
                            )}
                            {comment.issue === true ? (
                                <span className="thread__chip thread__chip--issue">issue</span>
                            ) : null}
                            {comment.author.bot ? (
                                <span className="thread__chip">
                                    {comment.author.displayName ?? comment.author.login}
                                </span>
                            ) : null}
                            {thread.outdated && index === 0 ? <span className="thread__chip">outdated</span> : null}
                            {pinned === null || index !== 0 ? null : <ThreadPinChip pinned={pinned} />}
                            {editing ? (
                                <span className="thread__chip thread__chip--editing">{t('thread.chip.editing')}</span>
                            ) : comment.draft ? (
                                <span className="thread__chip thread__chip--draft">{t('thread.chip.draft')}</span>
                            ) : null}
                            <span className="thread__meta">{metaOf(thread, comment.createdAt, now, t, locale)}</span>
                            {collapsed ? (
                                <>
                                    {/* The preview has the same click target as the chevron. The keyboard only needs the chevron. */}
                                    <button
                                        type="button"
                                        className="thread__preview"
                                        tabIndex={-1}
                                        aria-hidden="true"
                                        onClick={toggleCollapsed}
                                    >
                                        {commentFirstLine(comment.body)}
                                    </button>
                                    {replies === 0 ? null : (
                                        <span className="thread__reply-count">{t('thread.replies', replies)}</span>
                                    )}
                                </>
                            ) : (
                                <span className="thread__spacer" />
                            )}
                            {resolve === null ? null : (
                                <button
                                    type="button"
                                    className={`ctl ctl--toggle ctl--toggle-compact thread__resolve${resolve.on ? ' is-on' : ''}`}
                                    aria-pressed={resolve.on}
                                    disabled={readOnly}
                                    title={readOnly ? readOnlyReason : resolve.on ? t('thread.reopen') : undefined}
                                    onClick={() => {
                                        if (resolve.kind === 'thread') {
                                            setThreadResolved(!resolve.on);
                                        } else {
                                            void actions.resolveComment?.(comment.id, !resolve.on);
                                        }
                                    }}
                                >
                                    {resolve.on ? (
                                        <Icon name="check" size={11} />
                                    ) : (
                                        <Icon name="dot" size={11} className="ctl__dot" />
                                    )}
                                    {resolve.on ? t('thread.resolved') : t('thread.resolve')}
                                </button>
                            )}
                        </div>
                        {collapsed ? null : editing ? (
                            <DraftEditor
                                comment={comment}
                                store={store}
                                transport={comment.draft ? actions.transport : (editorTransport ?? actions.transport)}
                                placeholder={t('thread.composer.linePlaceholder')}
                                inputLabel={t(comment.draft ? 'thread.composer.editLabel' : 'thread.composer.editPublishedLabel')}
                                {...(initialLayout === undefined ? {} : { initialLayout })}
                            />
                        ) : (
                            <div className="thread__body">
                                <Markdown text={comment.body} profile="comment" />
                            </div>
                        )}
                        {collapsed ? null : confirmingId === comment.id ? (
                            <DeleteConfirm
                                question={
                                    deleteErrorId === comment.id
                                        ? t(comment.draft ? 'thread.draft.deleteFailed' : 'thread.comment.deleteFailed')
                                        : t(comment.draft ? 'thread.draft.deleteConfirm' : 'thread.comment.deleteConfirm')
                                }
                                confirmLabel={
                                    deletingId === comment.id
                                        ? t('thread.draft.deleting')
                                        : t('thread.draft.deleteAction')
                                }
                                busy={deletingId === comment.id}
                                onConfirm={() => void remove(comment)}
                                onCancel={() => {
                                    setDeleteErrorId(null);
                                    setConfirmingId(null);
                                }}
                            />
                        ) : editing ? null : (
                            <div className="thread__row-actions">
                                {comment.draft ? null : (
                                    <button
                                        type="button"
                                        className="ctl ctl--link thread__action"
                                        disabled={readOnly}
                                        title={readOnly ? readOnlyReason : undefined}
                                        onClick={() => {
                                            openReply(store, thread, actions.commentIssues === true, undefined, comment.id);
                                        }}
                                    >
                                        {t('thread.reply.action')}
                                    </button>
                                )}
                                {editable ? (
                                    <>
                                        <button
                                            type="button"
                                            className="ctl ctl--link-muted thread__action"
                                            aria-label={t(
                                                comment.draft ? 'thread.draft.editAria' : 'thread.comment.editAria',
                                                comment.id,
                                            )}
                                            disabled={readOnly || editingId !== null || deletingId !== null}
                                            title={readOnly ? readOnlyReason : undefined}
                                            onClick={() => {
                                                setConfirmingId(null);
                                                openDraftEditor(store, thread, comment);
                                            }}
                                        >
                                            {t('thread.comment.edit')}
                                        </button>
                                        {deletable ? (
                                            <button
                                                type="button"
                                                className="ctl ctl--link-danger thread__action thread__action--delete"
                                                aria-label={t(
                                                    comment.draft ? 'thread.draft.deleteAria' : 'thread.comment.deleteAria',
                                                    comment.id,
                                                )}
                                                disabled={readOnly || editingId !== null || deletingId !== null}
                                                title={readOnly ? readOnlyReason : undefined}
                                                onClick={() => {
                                                    setDeleteErrorId(null);
                                                    setConfirmingId(comment.id);
                                                }}
                                            >
                                                {t('thread.comment.delete')}
                                            </button>
                                        ) : null}
                                    </>
                                ) : null}
                            </div>
                        )}
                        {inlineReplyId === comment.id ? composer : null}
                    </div>
                );
            })}

            {collapsed || inlineReplyId !== null ? null : composer}
        </section>
    );
}

/**
 * Left reply indentation, 27px per level up to level 4 (`FlatComment.indent`). The reply avatar
 * sits under the parent text column. The root has no indentation and needs no variable.
 */
function replyIndentStyle(indent: number): CSSProperties | undefined {
    return indent === 0 ? undefined : ({ '--reply-indent': `${String(indent)}px` } as CSSProperties);
}

interface ResolveControl {
    readonly kind: 'thread' | 'comment';
    readonly on: boolean;
}

/**
 * Resolve button location (docs/design/SPEC-changes-2026-09-20.md §3, §5). On hosts with comment-level
 * resolution, every comment with an issue has a button. Without an issue, there is nothing to resolve. Other
 * hosts have one button at the thread root. Drafts have no button because unpublished comments have nothing to resolve.
 */
function resolveControl(
    thread: Thread,
    comment: Comment,
    index: number,
    actions: ThreadActions,
): ResolveControl | null {
    if (comment.draft) {
        return null;
    }
    if (actions.resolveComment != null) {
        return comment.issue === true ? { kind: 'comment', on: comment.resolved === true } : null;
    }
    return index === 0 ? { kind: 'thread', on: thread.resolved } : null;
}


/** Pin chip and navigation: short commit in the label, full commit in the tooltip (docs/design/README.md §13). */
export function ThreadPinChip({ pinned }: { pinned: ThreadPinState }) {
    const t = useT();
    return (
        <>
            <span className="thread__chip thread__chip--pinned" title={pinned.pin.commit}>
                {t('thread.pin.chip', shortCommit(pinned.pin.commit))}
            </span>
            {pinned.open === null ? null : (
                <button type="button" className="ctl ctl--link-muted thread__pin-action" onClick={pinned.open}>
                    {t('thread.pin.open')}
                </button>
            )}
        </>
    );
}

/**
 * Threads absent from every rendered diff line: the file left the PR (docs/design/SPEC-elements.md §2.17)
 * or the thread belongs to a PR-level bot. The heading names the reason only when all threads share it.
 */
function outsideTitle(threads: readonly Thread[], t: Translate): string {
    const count = threads.length;
    return threads.every((thread) => thread.anchor !== null)
        ? t('thread.outside.gone', count)
        : t('thread.outside.offDiff', count);
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
    const t = useT();
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
                {outsideTitle(threads, t)}
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
    placeholder,
    saveLabel,
    footerHint,
    initialLayout,
    onSaveComplete,
}: {
    composerKey: string;
    store: ThreadStore;
    transport: ComposerTransport;
    placeholder?: string;
    saveLabel?: ComposerSaveLabel;
    footerHint?: ReactNode;
    initialLayout?: ComposerLayout;
    onSaveComplete?: (() => void) | undefined;
}) {
    const t = useT();
    const composer = useComposerSnapshot(store, composerKey);
    if (composer === null) {
        return null;
    }
    // Three cases: no anchor means a PR comment, an anchor without a line means the whole file
    // (an image), and an anchor with a line means a code range.
    const anchor = composer.anchor;
    const position = anchor?.position ?? null;
    return (
        <CommentComposer
            composer={composer}
            store={store}
            transport={transport}
            placeholder={
                placeholder ??
                (anchor === null
                    ? t('thread.composer.prPlaceholder')
                    : position === null
                      ? t('thread.composer.filePlaceholder')
                      : t('thread.composer.codePlaceholder'))
            }
            inputLabel={t('thread.composer.newLabel')}
            saveLabel={
                saveLabel ??
                (composer.commentId === null ? 'thread.composer.saveDraft' : 'thread.composer.saveChanges')
            }
            closeOnSave
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
    composer,
}: {
    thread: Thread;
    store: ThreadStore;
    transport: ComposerTransport;
    draft: Comment | null;
    composer: ComposerSnapshot | null;
}) {
    const t = useT();
    if (composer === null) {
        // Each message has a Reply link (§3), with no separate strip.
        // A saved reply draft is a regular thread row, edited by `DraftEditor`.
        return null;
    }
    const resolvedWhileTyping = !composer.resolvedAtOpen && thread.resolved;
    return (
        <CommentComposer
            composer={composer}
            store={store}
            transport={transport}
            placeholder={t('thread.reply.placeholder')}
            inputLabel={t('thread.reply.label')}
            saveLabel={composer.commentId === null ? 'thread.composer.saveDraft' : 'thread.composer.saveChanges'}
            closeOnSave
            {...(composer.commentId === null
                ? {}
                : { restoreOnCancel: composer.originalText ?? draft?.body ?? composer.text })}
            notice={
                resolvedWhileTyping
                    ? t('thread.resolvedWhileTyping', thread.resolvedBy ?? t('thread.otherReviewer'))
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

/** Parent of a saved reply draft. The composer opens under the same message. */
function draftParentId(thread: Thread, draft: Comment | null): string | null {
    if (draft === null) {
        return null;
    }
    return flattenThread(thread.root).find((row) => row.comment.id === draft.id)?.parent?.id ?? null;
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
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
}

/**
 * `initialText` seeds the composer text (a quote from an agent note). Seeding leaves an open composer
 * with entered text alone, because that is the reviewer's work and must not be overwritten.
 */
export function openNewComposer(
    store: ThreadStore,
    key: string,
    anchor: FileAnchor,
    commentIssues: boolean,
    initialText = '',
): void {
    const open = store.getComposer(key);
    if (open !== null) {
        // The composer key uses the first line without the range size. The pencil composer on
        // line 148 and a note on 148–151 get the same key. When seeding, use the note anchor,
        // or the draft will be saved to a range that does not match the quote.
        if (initialText !== '' && open.text.trim() === '') {
            store.updateComposer(key, { text: initialText, anchor });
        }
        return;
    }
    store.openComposer({
        key,
        threadId: null,
        parentId: null,
        anchor,
        ...(commentIssues ? { issue: true } : {}),
        text: initialText,
        commentId: null,
        status: 'idle',
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
}

/**
 * Composer for a file comment without a line. An anchor with `position: null` places it under
 * the card header, alongside threads that lost their line.
 */
export function openFileComposer(store: ThreadStore, fileId: string, path: string, commentIssues: boolean): void {
    openNewComposer(store, `new:${fileId}:file`, { fileId, path, position: null }, commentIssues);
}

export function replyComposerKey(threadId: string): string {
    return `reply:${threadId}`;
}

/**
 * `replyUnder` is the message under which the composer expands and to which the draft will
 * reply (§3, §4). It defaults to the thread root. An already open composer moves there
 * with its entered text and changes parent. A thread has only one reply composer.
 *
 * A composer whose text has already been sent for saving cannot move. Its parent was either saved with the
 * draft (`commentId !== null`) or is being saved now (`clientKey` exists from
 * the first save until it succeeds). Changing it requires deleting the draft. For such a
 * composer, Reply under another message simply returns to the draft location. For the same
 * reason, the saved draft parent takes precedence over `replyUnder` when opening the composer too.
 */
export function openReply(
    store: ThreadStore,
    thread: Thread,
    commentIssues: boolean,
    draft: Comment | null = replyDraft(thread),
    replyUnder: string | null = null,
): void {
    const key = replyComposerKey(thread.id);
    const target = draftParentId(thread, draft) ?? replyUnder ?? thread.root.id;
    const open = store.getComposer(key);
    if (open !== null) {
        const written = open.commentId !== null || open.clientKey !== undefined;
        if (!written && open.replyUnder !== target) {
            store.updateComposer(key, { replyUnder: target, parentId: target });
        }
        return;
    }
    if (draft !== null && store.getComposer(draftEditComposerKey(draft.id)) !== null) {
        return;
    }
    store.openComposer({
        key,
        threadId: thread.id,
        parentId: target,
        anchor: null,
        replyUnder: target,
        // A reply can also raise an issue. It has its own issue, enabled by default as in a new thread.
        ...(commentIssues ? { issue: draft?.issue ?? true } : {}),
        text: draft?.body ?? '',
        ...(draft === null ? {} : { originalText: draft.body }),
        commentId: draft?.id ?? null,
        status: draft === null ? 'idle' : 'saved',
        savedAt: draft === null ? null : Date.parse(draft.editedAt ?? draft.createdAt),
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: thread.resolved,
    });
}

function metaOf(thread: Thread, createdAt: string, now: number, t: Translate, locale: Locale): string {
    const path = thread.anchor?.path.split('/').at(-1) ?? 'PR';
    const position = thread.anchor?.position;
    const when = relativeTime(createdAt, now, locale);
    return position == null ? t('thread.meta', path, when) : t('thread.meta.line', path, lineRange(position), when);
}

function lineRange(position: { readonly line: number; readonly size: number }): string {
    const last = position.line + Math.max(position.size, 1) - 1;
    return last === position.line ? String(position.line) : `${String(position.line)}–${String(last)}`;
}

