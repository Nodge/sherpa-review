import type { PrMeta, Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { formatCount, plural, relativeTime } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { Markdown } from '../markdown/markdown.tsx';
import { useShortcutRegistry } from '../shortcuts/context.tsx';
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
import './pr-comments-modal.css';

export interface PrCommentsModalProps {
    readonly pr: PrMeta;
    readonly store: ThreadStore;
    readonly transport: ComposerTransport;
    readonly onClose: () => void;
    readonly now?: number;
    readonly initialLayout?: ComposerLayout;
}

/** Human PR-level comments: a list of written comments and a separate composer for a new draft. */
export function PrCommentsModal({ pr, store, transport, onClose, now, initialLayout }: PrCommentsModalProps) {
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
    const drafts = prThreads.filter((thread) => thread.root.draft).length;
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

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.defaultPrevented) {
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
                return;
            }
            if (event.key !== 'Tab') {
                return;
            }
            const focusable = focusableElements(modalRef.current);
            if (focusable.length === 0) {
                event.preventDefault();
                modalRef.current?.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable.at(-1);
            const active = document.activeElement;
            if (!modalRef.current?.contains(active)) {
                event.preventDefault();
                (event.shiftKey ? last : first)?.focus();
            } else if (event.shiftKey && active === first) {
                event.preventDefault();
                last?.focus();
            } else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first?.focus();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [onClose]);

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
                    <h2 id="pr-comments-modal-title">Comments on the PR</h2>
                    <span className="pr-comments-modal__context">outside the diff · {pr.id}</span>
                    <span className="pr-comments-modal__header-spacer" />
                    {drafts === 0 ? null : (
                        <span className="pr-comments-modal__draft-count">
                            {formatCount(drafts, 'ru')} {plural(drafts, { one: 'draft', few: 'drafts', many: 'drafts', other: 'drafts' }, 'ru')} · published on Ship
                        </span>
                    )}
                    <button
                        ref={closeRef}
                        type="button"
                        className="pr-comments-modal__icon-button"
                        aria-label="Close the PR comments"
                        title="Close · Esc"
                        onClick={onClose}
                    >
                        <Icon name="cross" size={14} />
                    </button>
                </header>

                <div className="pr-comments-modal__list-shell">
                    <div ref={listRef} className="pr-comments-modal__list">
                        {comments.length === 0 ? (
                            <div className="pr-comments-modal__empty">
                                No comments on the PR yet. What you write here goes out with the review when you Ship.
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
                                                {editing ? 'editing' : comment.draft ? 'draft · publishes on ship' : 'published'}
                                            </span>
                                            <time dateTime={comment.createdAt}>{relativeTime(comment.createdAt, openedAt, 'ru')}</time>
                                            <span className="pr-comments-modal__item-spacer" />
                                            {comment.draft ? (
                                                <span className="pr-comments-modal__item-actions">
                                                    <button
                                                        type="button"
                                                        className="pr-comments-modal__icon-button"
                                                        aria-label={`Edit draft ${comment.id}`}
                                                        title="Edit the draft"
                                                        disabled={editingId !== null}
                                                        onClick={() => {
                                                            startEditing(thread);
                                                        }}
                                                    >
                                                        <Icon name="pencil" size={14} />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="pr-comments-modal__icon-button is-delete"
                                                        aria-label={`Delete draft ${comment.id}`}
                                                        title="Delete the draft"
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
                                                contextLabel="draft editing"
                                                placeholder="Comment on the PR"
                                                inputLabel="Draft editing"
                                                footerHint={<ComposerShortcutHint escapeLabel="cancel" />}
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
                                                        ? 'Could not delete the draft. Retry?'
                                                        : 'Delete the draft? It will not be published'}
                                                </span>
                                                <span className="pr-comments-modal__item-spacer" />
                                                <button
                                                    type="button"
                                                    className="pr-comments-modal__delete-button"
                                                    disabled={deletingId === comment.id}
                                                    onClick={() => void deleteDraft(comment.id)}
                                                >
                                                    {deletingId === comment.id ? 'Deleting…' : 'Delete'}
                                                </button>
                                                <button
                                                    type="button"
                                                    className="pr-comments-modal__keep-button"
                                                    disabled={deletingId === comment.id}
                                                    onClick={() => {
                                                        setDeleteErrorId(null);
                                                        setConfirmingId(null);
                                                    }}
                                                >
                                                    Keep
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
                            <span>Write a comment on the PR…</span>
                            <Icon name="pencil" size={13} />
                        </button>
                    ) : (
                        <NewCommentComposer
                            composerKey={PR_COMPOSER_KEY}
                            store={store}
                            transport={transport}
                            footerHint={<ComposerShortcutHint escapeLabel="close" />}
                            {...(initialLayout === undefined ? {} : { initialLayout })}
                            onSaveComplete={savedNewComment}
                        />
                    )}
                    <div className="pr-comments-modal__ship-note">
                        <Icon name="updown" size={13} />
                        Drafts are published as one batch on Ship, together with the line comments
                    </div>
                </footer>
            </section>
        </div>
    );

    return typeof document === 'undefined' ? content : createPortal(content, document.body);
}

function ComposerShortcutHint({ escapeLabel }: { escapeLabel: string }) {
    return (
        <span className="pr-comments-modal__shortcuts">
            <kbd>⌘⏎</kbd> save <kbd>Esc</kbd> {escapeLabel}
        </span>
    );
}

function useComposerSnapshot(store: ThreadStore, key: string): ComposerSnapshot | null {
    const subscribe = useCallback((listener: () => void) => store.subscribeComposer(key, listener), [key, store]);
    const getSnapshot = useCallback(() => store.getComposer(key), [key, store]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function focusableElements(root: HTMLElement | null): HTMLElement[] {
    if (root === null) {
        return [];
    }
    const selector = [
        'button:not(:disabled)',
        '[href]',
        'input:not(:disabled)',
        'textarea:not(:disabled)',
        '[contenteditable="true"]',
        '[tabindex]:not([tabindex="-1"])',
    ].join(', ');
    return [...root.querySelectorAll<HTMLElement>(selector)].filter((element) => !element.hasAttribute('hidden'));
}

function initials(name: string): ReactNode {
    return name
        .split(/[\s._-]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('');
}
