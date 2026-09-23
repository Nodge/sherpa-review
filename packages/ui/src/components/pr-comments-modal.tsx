import type { DraftBufferEntry, PrMeta, Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import type { MessageKey } from '../i18n/index.js';
import { relativeTime, useLocale, useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { Markdown } from '../markdown/markdown.tsx';
import { useEscapeLayer, useShortcutRegistry } from '../shortcuts/context.tsx';
import { composerControllerFor } from '../threads/composer.js';
import type { ComposerTransport } from '../threads/composer.js';
import type { ComposerLayout } from '../threads/composer-markdown.js';
import {
    DraftEditor,
    draftEditComposerKey,
    openDraftEditor,
    useActiveDraftEditor,
} from '../threads/draft-editor.tsx';
import { authorName, prLevelHumanThreads } from '../threads/model.js';
import {
    NewCommentComposer,
    openPrComposer,
    PR_COMPOSER_KEY,
} from '../threads/thread-list.tsx';
import type { ComposerSnapshot, ThreadStore } from '../threads/store.js';
import { discussionStats } from '../views/overview-model.js';
import { useFocusTrap } from './use-focus-trap.js';
import './pr-comments-modal.css';

const EMPTY_DRAFT_BUFFER: readonly DraftBufferEntry[] = [];

export interface PrCommentsModalProps {
    readonly pr: PrMeta;
    readonly store: ThreadStore;
    readonly transport: ComposerTransport;
    /** Draft buffer entries. Only PR-level entries count toward the modal counter. */
    readonly draftBuffer?: readonly DraftBufferEntry[];
    readonly onClose: () => void;
    readonly now?: number;
    readonly initialLayout?: ComposerLayout;
}

/** Human PR-level comments: a list of written comments and a separate composer for a new draft. */
export function PrCommentsModal({
    pr,
    store,
    transport,
    draftBuffer = EMPTY_DRAFT_BUFFER,
    onClose,
    now,
    initialLayout,
}: PrCommentsModalProps) {
    const t = useT();
    const locale = useLocale();
    const shortcutRegistry = useShortcutRegistry();
    const commentIssues = pr.capabilities.commentIssues;
    const [openedAt] = useState(() => now ?? Date.now());
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const prComposer = useComposerSnapshot(store, PR_COMPOSER_KEY);
    const prThreads = useMemo(
        () =>
            prLevelHumanThreads(snapshot.threads).sort(
                (left, right) => Date.parse(right.root.createdAt) - Date.parse(left.root.createdAt),
            ),
        [snapshot.threads],
    );
    const comments = useMemo(
        () => prThreads.filter((thread) => thread.root.id !== prComposer?.commentId),
        [prComposer?.commentId, prThreads],
    );
    const commentIds = useMemo(() => comments.map((thread) => thread.root.id), [comments]);
    const editingId = useActiveDraftEditor(store, commentIds);
    // A buffered PR-level record is a draft in the batch, just one the host has not accepted yet.
    const bufferedPrDrafts = draftBuffer.filter(
        (entry) => entry.commentId === null && entry.draft.parentId === null && entry.draft.anchor === null,
    ).length;
    const drafts = prThreads.filter((thread) => thread.root.draft).length + bufferedPrDrafts;
    const openThreads = discussionStats(snapshot.threads).open;
    const [confirmingId, setConfirmingId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [deleteErrorId, setDeleteErrorId] = useState<string | null>(null);
    const modalRef = useRef<HTMLElement | null>(null);
    const closeRef = useRef<HTMLButtonElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        openPrComposer(store, commentIssues);
    }, [commentIssues, store]);

    useEffect(() => {
        shortcutRegistry?.setModalOpen(true);
        return () => {
            shortcutRegistry?.setModalOpen(false);
        };
    }, [shortcutRegistry]);

    useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        closeRef.current?.focus();
        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, []);

    useEffect(() => {
        if (editingId === null) {
            return;
        }
        const key = draftEditComposerKey(editingId);
        const controller = composerControllerFor({ store, key, transport });
        return () => {
            controller.close();
            store.closeComposer(key);
        };
    }, [editingId, store, transport]);

    useFocusTrap(modalRef);
    useEscapeLayer('modal', onClose);

    const startEditing = (thread: Thread): void => {
        if (editingId !== null) {
            return;
        }
        const comment = thread.root;
        openDraftEditor(store, thread, comment);
        setConfirmingId(null);
    };

    const deleteDraft = async (commentId: string): Promise<void> => {
        setDeletingId(commentId);
        setDeleteErrorId(null);
        try {
            await transport.delete(commentId);
            store.deleteDraft(commentId);
            setConfirmingId(null);
        } catch {
            setDeleteErrorId(commentId);
        } finally {
            setDeletingId(null);
        }
    };

    const savedNewComment = useCallback((): void => {
        openPrComposer(store, commentIssues);
        queueMicrotask(() => {
            if (listRef.current !== null) {
                listRef.current.scrollTop = 0;
            }
        });
    }, [commentIssues, store]);

    const content = (
        <div
            className="pr-comments-modal__overlay"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <section
                ref={modalRef}
                className="pr-comments-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="pr-comments-modal-title"
                tabIndex={-1}
            >
                <header className="pr-comments-modal__header">
                    <h2 id="pr-comments-modal-title">{t('prComments.title')}</h2>
                    <span className="pr-comments-modal__context">{t('prComments.context', pr.id)}</span>
                    <span className="pr-comments-modal__header-spacer" />
                    {openThreads === 0 ? null : (
                        <span className="pr-comments-modal__open-threads">
                            {t('ship.openThreads', openThreads)}
                        </span>
                    )}
                    {drafts === 0 ? null : (
                        <span className="pr-comments-modal__draft-count">
                            {t('prComments.drafts', drafts)}
                            {bufferedPrDrafts === 0 ? null : ` ${t('ship.drafts.buffered', bufferedPrDrafts)}`}
                        </span>
                    )}
                    <button
                        ref={closeRef}
                        type="button"
                        className="ctl ctl--icon pr-comments-modal__icon-button"
                        aria-label={t('prComments.close')}
                        title={t('prComments.close.title')}
                        onClick={onClose}
                    >
                        <Icon name="cross" size={14} />
                    </button>
                </header>

                {draftBuffer.length === 0 ? null : (
                    <BufferedDrafts entries={draftBuffer} transport={transport} />
                )}

                <div className="pr-comments-modal__list-shell">
                    <div ref={listRef} className="pr-comments-modal__list">
                        {comments.length === 0 ? (
                            <div className="pr-comments-modal__empty">
                                {t('prComments.empty')}
                            </div>
                        ) : (
                            comments.map((thread) => {
                                const comment = thread.root;
                                const editing = editingId === comment.id;
                                const confirming = confirmingId === comment.id;
                                return (
                                    <article
                                        key={comment.id}
                                        className={`pr-comments-modal__item${comment.draft ? ' is-draft' : ' is-published'}${editing ? ' is-editing' : ''}`}
                                        data-comment-id={comment.id}
                                    >
                                        <div className="pr-comments-modal__item-header">
                                            <span className="pr-comments-modal__avatar">
                                                {initials(comment.author.displayName ?? comment.author.login)}
                                            </span>
                                            <strong>{authorName(comment)}</strong>
                                            <span className={`pr-comments-modal__chip${editing ? ' is-editing' : comment.draft ? ' is-draft' : ''}`}>
                                                {editing
                                                    ? t('thread.chip.editing')
                                                    : comment.draft
                                                      ? t('thread.chip.draftShort')
                                                      : t('prComments.published')}
                                            </span>
                                            <time dateTime={comment.createdAt}>
                                                {relativeTime(comment.createdAt, openedAt, locale)}
                                            </time>
                                            <span className="pr-comments-modal__item-spacer" />
                                            {comment.draft ? (
                                                <span className="pr-comments-modal__item-actions">
                                                    <button
                                                        type="button"
                                                        className="ctl ctl--icon pr-comments-modal__icon-button"
                                                        aria-label={t('thread.draft.editAria', comment.id)}
                                                        title={t('thread.draft.edit')}
                                                        disabled={editingId !== null}
                                                        onClick={() => {
                                                            startEditing(thread);
                                                        }}
                                                    >
                                                        <Icon name="pencil" size={14} />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="ctl ctl--icon-danger pr-comments-modal__icon-button"
                                                        aria-label={t('thread.draft.deleteAria', comment.id)}
                                                        title={t('thread.draft.delete')}
                                                        disabled={deletingId !== null || editingId !== null}
                                                        onClick={() => {
                                                            setDeleteErrorId(null);
                                                            setConfirmingId(comment.id);
                                                        }}
                                                    >
                                                        <Icon name="trash" size={14} />
                                                    </button>
                                                </span>
                                            ) : null}
                                        </div>

                                        {editing ? (
                                            <DraftEditor
                                                comment={comment}
                                                store={store}
                                                transport={transport}
                                                contextLabel={t('thread.composer.editContext')}
                                                placeholder={t('prComments.placeholder')}
                                                inputLabel={t('thread.composer.editLabel')}
                                                footerHint={<ComposerShortcutHint escapeLabel="prComments.escape.cancel" />}
                                                {...(initialLayout === undefined ? {} : { initialLayout })}
                                            />
                                        ) : (
                                            <div className="pr-comments-modal__body">
                                                <Markdown text={comment.body} profile="comment" />
                                            </div>
                                        )}

                                        {confirming ? (
                                            <div className="pr-comments-modal__delete-confirm">
                                                <span>
                                                    {deleteErrorId === comment.id
                                                        ? t('thread.draft.deleteFailed')
                                                        : t('thread.draft.deleteConfirm')}
                                                </span>
                                                <span className="pr-comments-modal__item-spacer" />
                                                <button
                                                    type="button"
                                                    className="ctl ctl--danger pr-comments-modal__delete-button"
                                                    disabled={deletingId === comment.id}
                                                    onClick={() => void deleteDraft(comment.id)}
                                                >
                                                    {deletingId === comment.id
                                                        ? t('thread.draft.deleting')
                                                        : t('thread.draft.deleteAction')}
                                                </button>
                                                <button
                                                    type="button"
                                                    className="ctl ctl--ghost ctl--compact pr-comments-modal__keep-button"
                                                    disabled={deletingId === comment.id}
                                                    onClick={() => {
                                                        setDeleteErrorId(null);
                                                        setConfirmingId(null);
                                                    }}
                                                >
                                                    {t('thread.draft.keep')}
                                                </button>
                                            </div>
                                        ) : null}
                                    </article>
                                );
                            })
                        )}
                    </div>
                    <div className="pr-comments-modal__list-fade" aria-hidden="true" />
                </div>

                <footer className="pr-comments-modal__composer">
                    {prComposer === null ? (
                        <button
                            type="button"
                            className="pr-comments-modal__composer-entry"
                            onClick={() => {
                                openPrComposer(store, commentIssues);
                            }}
                        >
                            <span>{t('prComments.new')}</span>
                            <Icon name="pencil" size={13} />
                        </button>
                    ) : (
                        <NewCommentComposer
                            composerKey={PR_COMPOSER_KEY}
                            store={store}
                            transport={transport}
                            footerHint={<ComposerShortcutHint escapeLabel="prComments.escape.close" />}
                            {...(initialLayout === undefined ? {} : { initialLayout })}
                            onSaveComplete={savedNewComment}
                        />
                    )}
                    <div className="pr-comments-modal__ship-note">
                        <Icon name="updown" size={13} />
                        {t('prComments.footer')}
                    </div>
                </footer>
            </section>
        </div>
    );

    return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

/**
 * Drafts accepted by the server but not yet by the host. All of them appear here, not just
 * PR-level drafts. While a record exists, ship is unavailable, and its composer may be off screen,
 * for example at a file line in a previous iteration. This is the only place to see such a record
 * and discard it.
 */
function BufferedDrafts({
    entries,
    transport,
}: {
    readonly entries: readonly DraftBufferEntry[];
    readonly transport: ComposerTransport;
}) {
    const t = useT();
    const [busyId, setBusyId] = useState<string | null>(null);
    const act = (id: string, action: ((id: string) => Promise<void>) | undefined): void => {
        if (action === undefined) {
            return;
        }
        setBusyId(id);
        void action(id).finally(() => {
            setBusyId((current) => (current === id ? null : current));
        });
    };
    return (
        <section className="pr-comments-modal__buffered" aria-label={t('prComments.buffered.label')}>
            <h3>{t('prComments.buffered.title', entries.length)}</h3>
            {entries.map((entry) => (
                <div key={entry.id} className="pr-comments-modal__buffered-item">
                    <span
                        className="pr-comments-modal__buffered-text"
                        {...(entry.error === null ? {} : { title: entry.error })}
                    >
                        {entry.draft.body}
                    </span>
                    <span className="pr-comments-modal__item-spacer" />
                    <button
                        type="button"
                        className="ctl ctl--ghost ctl--compact pr-comments-modal__keep-button"
                        disabled={busyId !== null}
                        onClick={() => {
                            act(entry.id, transport.retryBuffered);
                        }}
                    >
                        {t('prComments.buffered.retry')}
                    </button>
                    <button
                        type="button"
                        className="ctl ctl--danger pr-comments-modal__delete-button"
                        disabled={busyId !== null}
                        onClick={() => {
                            act(entry.id, transport.discardBuffered);
                        }}
                    >
                        {t('prComments.buffered.discard')}
                    </button>
                </div>
            ))}
        </section>
    );
}

function ComposerShortcutHint({ escapeLabel }: { escapeLabel: MessageKey }) {
    const t = useT();
    return (
        <span className="pr-comments-modal__shortcuts">
            <kbd>⌘⏎</kbd> {t('prComments.hint.save')} <kbd>Esc</kbd> {t(escapeLabel)}
        </span>
    );
}

function useComposerSnapshot(store: ThreadStore, key: string): ComposerSnapshot | null {
    const subscribe = useCallback((listener: () => void) => store.subscribeComposer(key, listener), [key, store]);
    const getSnapshot = useCallback(() => store.getComposer(key), [key, store]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function initials(name: string): ReactNode {
    return name
        .split(/[\s._-]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('');
}
