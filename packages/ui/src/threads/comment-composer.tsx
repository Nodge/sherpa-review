import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MessageKey } from '../i18n/index.js';
import { useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { useReadOnlyIteration, useReadOnlyReason } from '../iterations/read-only.tsx';
import { useUiSettings, useUiSettingsStore } from '../settings/context.tsx';
import { composerControllerFor } from './composer.js';
import { DeleteConfirm } from './delete-confirm.tsx';
import type { ComposerTransport } from './composer.js';
import { editMarkdown } from './composer-markdown.js';
import type { ComposerLayout, ComposerTool, EditorPlaceholders } from './composer-markdown.js';
import type { ComposerSnapshot, ThreadStore } from './store.js';
import type { VisualEditorHandle } from './visual-editor.js';

const TOOLS: readonly {
    tool: ComposerTool;
    icon: 'bold' | 'italic' | 'link' | 'code' | 'codeblock' | 'list';
    title: MessageKey;
}[] = [
    { tool: 'bold', icon: 'bold', title: 'thread.tool.bold' },
    { tool: 'italic', icon: 'italic', title: 'thread.tool.italic' },
    { tool: 'link', icon: 'link', title: 'thread.tool.link' },
    { tool: 'code', icon: 'code', title: 'thread.tool.code' },
    { tool: 'codeblock', icon: 'codeblock', title: 'thread.tool.codeblock' },
    { tool: 'list', icon: 'list', title: 'thread.tool.list' },
];

/** Save button label: creating or editing a draft. */
export type ComposerSaveLabel = Extract<MessageKey, 'thread.composer.saveDraft' | 'thread.composer.saveChanges'>;

export interface CommentComposerProps {
    readonly composer: ComposerSnapshot;
    readonly store: ThreadStore;
    readonly transport: ComposerTransport;
    readonly placeholder: string;
    readonly inputLabel: string;
    readonly saveLabel?: ComposerSaveLabel;
    readonly notice?: ReactNode;
    readonly footerHint?: ReactNode;
    readonly initialLayout?: ComposerLayout;
    readonly onSaveComplete?: (() => void) | undefined;
    readonly closeOnSave?: boolean;
    readonly restoreOnCancel?: string;
    readonly onCancel?: (() => void) | undefined;
}

/**
 * Shared composer for replies, PR comments and line comments. The first row is the
 * "Open issue" switch. There is no context heading above the field, since the composer is already in place,
 * below a code line, below a thread message or in the modal footer.
 */
export function CommentComposer({
    composer,
    store,
    transport,
    placeholder,
    inputLabel,
    saveLabel,
    notice,
    footerHint,
    initialLayout,
    onSaveComplete,
    closeOnSave = true,
    restoreOnCancel,
    onCancel,
}: CommentComposerProps) {
    const controller = useMemo(
        () => composerControllerFor({ store, key: composer.key, transport }),
        [composer.key, store, transport],
    );
    const t = useT();
    // Toolbar placeholders are part of the interface, not the markup. Their language changes with the UI.
    const placeholders = useMemo<EditorPlaceholders>(
        () => ({ text: t('thread.placeholder.text'), code: t('thread.placeholder.code') }),
        [t],
    );
    const settings = useUiSettingsStore();
    // Composer layout is global (docs/design/SPEC-elements.md §2.8). Until the reviewer
    // changes it in this composer, it follows settings, including settings received from the server after mounting.
    const [chosenLayout, setChosenLayout] = useState<ComposerLayout | null>(initialLayout ?? null);
    const settingsLayout = useUiSettings().composerLayout;
    const layout = chosenLayout ?? settingsLayout;
    const [visualReady, setVisualReady] = useState(false);
    const resolvedSaveLabel = t(saveLabel ?? 'thread.composer.saveDraft');
    const resolvedRestoreOnCancel =
        restoreOnCancel ?? (composer.commentId === null ? undefined : (composer.originalText ?? composer.text));
    const resolvedWhileTyping = notice !== undefined;
    // Previous iteration drafts are visible but cannot be edited. The composer can still
    // be closed because closing is not a write.
    const readOnly = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();
    const disabled = composer.status === 'discarding';
    const editingDisabled = disabled || readOnly;
    const markdownRef = useRef<HTMLTextAreaElement>(null);
    const visualHostRef = useRef<HTMLDivElement>(null);
    const visualRef = useRef<VisualEditorHandle | null>(null);
    const currentTextRef = useRef(composer.text);
    const disabledRef = useRef(editingDisabled);
    const saveDisabledReason = readOnly
        ? readOnlyReason
        : disabled
          ? t('thread.composer.deleting')
          : composer.text.trim() === ''
            ? t('thread.composer.emptyHint')
            : null;
    const save = useCallback(async (): Promise<void> => {
        if (await controller.saveNow(closeOnSave)) {
            onSaveComplete?.();
        }
    }, [closeOnSave, controller, onSaveComplete]);
    const cancel = useCallback((): void => {
        if (resolvedRestoreOnCancel !== undefined) {
            if (composer.text !== resolvedRestoreOnCancel) {
                controller.escape();
                return;
            }
            void controller.restore(resolvedRestoreOnCancel).then((restored) => {
                if (restored) {
                    onCancel?.();
                }
            });
            return;
        }
        if (onCancel === undefined) {
            controller.escape();
            return;
        }
        controller.close();
        store.closeComposer(composer.key);
        onCancel();
    }, [composer.key, composer.text, controller, onCancel, resolvedRestoreOnCancel, store]);

    // A ref, not an effect dependency: `save`/`cancel` are recreated on every letter, and
    // mounting ProseMirror on them would recreate the editor with the cursor at the start of the document.
    const handlersRef = useRef({ save, cancel });

    useEffect(() => {
        currentTextRef.current = composer.text;
        disabledRef.current = editingDisabled;
        handlersRef.current = { save, cancel };
    }, [cancel, composer.text, editingDisabled, save]);

    useEffect(() => {
        if (layout !== 'visual' || visualHostRef.current === null) {
            setVisualReady(false);
            visualRef.current?.destroy();
            visualRef.current = null;
            return;
        }
        let cancelled = false;
        setVisualReady(false);
        void import('./visual-editor.js').then(({ createVisualEditor }) => {
            if (cancelled || visualHostRef.current === null) {
                return;
            }
            const handle = createVisualEditor(visualHostRef.current, {
                markdown: currentTextRef.current,
                disabled: disabledRef.current,
                ariaLabel: inputLabel,
                placeholders,
                onChange: controller.input,
                onSave: () => {
                    void handlersRef.current.save();
                },
                onCancel: () => {
                    handlersRef.current.cancel();
                },
            });
            visualRef.current = handle;
            setVisualReady(true);
            handle.focus();
        });
        return () => {
            cancelled = true;
            visualRef.current?.destroy();
            visualRef.current = null;
        };
    }, [composer.key, controller, inputLabel, layout, placeholders]);

    useEffect(() => {
        visualRef.current?.setMarkdown(composer.text);
    }, [composer.text]);

    useEffect(() => {
        visualRef.current?.setDisabled(editingDisabled);
    }, [editingDisabled]);

    const selectLayout = (next: ComposerLayout): void => {
        setChosenLayout(next);
        settings.update({ composerLayout: next });
    };

    const format = (tool: ComposerTool): void => {
        if (layout === 'visual') {
            visualRef.current?.format(tool);
            return;
        }
        const textarea = markdownRef.current;
        if (textarea === null) {
            return;
        }
        const edit = editMarkdown(composer.text, textarea.selectionStart, textarea.selectionEnd, tool, placeholders);
        controller.input(edit.text);
        queueMicrotask(() => {
            textarea.focus();
            textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
        });
    };

    return (
        <div className="thread-composer" data-composer-key={composer.key}>
            {resolvedWhileTyping ? <div className="thread-composer__notice">{notice}</div> : null}
            {composer.issue === undefined ? null : (
                <div className="thread-composer__issue-row">
                    <button
                        type="button"
                        role="switch"
                        className={`ctl-switch thread-composer__issue${composer.issue ? ' is-on' : ''}`}
                        aria-checked={composer.issue}
                        aria-label={t(composer.issue ? 'thread.composer.openIssue.on' : 'thread.composer.openIssue.off')}
                        disabled={editingDisabled}
                        onClick={() => {
                            controller.setIssue(composer.issue !== true);
                        }}
                    >
                        <span className="ctl-switch__track" aria-hidden="true">
                            <span className="ctl-switch__knob" />
                        </span>
                        {t('thread.composer.openIssue')}
                    </button>
                </div>
            )}
            <div className="thread-composer__editor">
                <div className="thread-composer__toolbar" role="toolbar" aria-label={t('thread.composer.toolbarAria')}>
                    {TOOLS.map((item) => (
                        <button
                            key={item.tool}
                            type="button"
                            className="ctl ctl--toolbar-icon thread-composer__tool"
                            title={t(item.title)}
                            aria-label={t(item.title)}
                            disabled={editingDisabled || (layout === 'visual' && !visualReady)}
                            onMouseDown={(event) => {
                                event.preventDefault();
                            }}
                            onClick={() => {
                                format(item.tool);
                            }}
                        >
                            <Icon name={item.icon} size={14} />
                        </button>
                    ))}
                    <span className="thread-composer__toolbar-spacer" />
                    <div className="thread-composer__layout ctl-tabs ctl-tabs--small" aria-label={t('thread.composer.layoutAria')}>
                        <button
                            type="button"
                            className={`ctl ctl--tab${layout === 'visual' ? ' is-active' : ''}`}
                            aria-pressed={layout === 'visual'}
                            onClick={() => {
                                selectLayout('visual');
                            }}
                        >
                            {t('thread.composer.visual')}
                        </button>
                        <button
                            type="button"
                            className={`ctl ctl--tab thread-composer__layout-markdown${layout === 'markdown' ? ' is-active' : ''}`}
                            aria-pressed={layout === 'markdown'}
                            onClick={() => {
                                selectLayout('markdown');
                            }}
                        >
                            Markdown
                        </button>
                    </div>
                </div>
                {layout === 'markdown' ? (
                    <textarea
                        ref={markdownRef}
                        className="thread-composer__markdown"
                        value={composer.text}
                        autoFocus
                        disabled={editingDisabled}
                        aria-label={inputLabel}
                        placeholder={placeholder}
                        onChange={(event) => {
                            controller.input(event.target.value);
                        }}
                        onKeyDown={(event) => {
                            if (isComposerInputCode(event.code)) {
                                event.stopPropagation();
                            }
                            const shortcut =
                                event.code === 'KeyB' ? 'bold' : event.code === 'KeyI' ? 'italic' : event.code === 'KeyK' ? 'link' : null;
                            if ((event.metaKey || event.ctrlKey) && shortcut !== null) {
                                event.preventDefault();
                                event.stopPropagation();
                                format(shortcut);
                            } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                                event.preventDefault();
                                event.stopPropagation();
                                void save();
                            } else if (event.key === 'Escape') {
                                event.preventDefault();
                                event.stopPropagation();
                                cancel();
                            }
                        }}
                    />
                ) : (
                    <div className="thread-composer__visual-wrap" aria-busy={!visualReady}>
                        {composer.text === '' ? <div className="thread-composer__placeholder">{placeholder}</div> : null}
                        {!visualReady && composer.text !== '' ? (
                            <div className="thread-composer__visual-fallback" aria-hidden="true">
                                {composer.text}
                            </div>
                        ) : null}
                        <div ref={visualHostRef} className="thread-composer__visual" />
                    </div>
                )}
            </div>
            {/* Autosave status sits below the field (docs/design/SPEC-changes-2026-09-20.md §4b). While
                the composer asks about deletion, the "⌘⏎ or button" hint is unnecessary without buttons. */}
            <div className="thread-composer__status-line">
                {composer.confirmDiscard ? null : (
                    <ComposerStatus
                        composer={composer}
                        readOnly={readOnly}
                        // Retrying a buffered write is the same explicit save. On success,
                        // the draft has reached the host and the composer has nothing left to hold.
                        onRetry={composer.status === 'buffered' ? save : controller.retry}
                    />
                )}
            </div>
            {/* Delete confirmation replaces the buttons, just as it replaces the action row in a thread (§3). */}
            {composer.confirmDiscard ? (
                <DeleteConfirm
                    question={t('thread.draft.deleteConfirm')}
                    confirmLabel={t('thread.draft.deleteAction')}
                    onConfirm={() => void controller.confirmDiscard()}
                    onCancel={controller.keepEditing}
                />
            ) : (
                <div className="thread-composer__actions">
                    <button
                        type="button"
                        className="ctl ctl--secondary thread-composer__save"
                        disabled={saveDisabledReason !== null}
                        title={saveDisabledReason ?? undefined}
                        onClick={() => void save()}
                    >
                        {resolvedSaveLabel}
                    </button>
                    <button
                        type="button"
                        className="ctl ctl--ghost"
                        disabled={disabled}
                        title={disabled ? t('thread.composer.deleting') : undefined}
                        onClick={cancel}
                    >
                        {t('thread.composer.cancel')}
                    </button>
                    <span className="thread-composer__actions-spacer" />
                    {footerHint}
                </div>
            )}
        </div>
    );
}

function ComposerStatus({
    composer,
    readOnly,
    onRetry,
}: {
    composer: ComposerSnapshot;
    /** A retry is a write just like the first attempt, so it is unavailable in a previous iteration. */
    readOnly: boolean;
    onRetry: () => Promise<unknown>;
}) {
    const t = useT();
    const readOnlyReason = useReadOnlyReason();
    if (composer.status === 'discarding') {
        return <span className="thread-composer__status">{t('thread.composer.status.discarding')}</span>;
    }
    // The text is already on the server. The host has not accepted it yet, but it can no longer be lost.
    if (composer.status === 'buffered') {
        const error = composer.bufferEntry?.error ?? null;
        return (
            <span className="thread-composer__status" {...(error === null ? {} : { title: error })}>
                {t('thread.composer.status.buffered')}{' '}
                <button
                    type="button"
                    className="ctl ctl--link-muted"
                    disabled={readOnly}
                    {...(readOnly ? { title: readOnlyReason } : {})}
                    onClick={() => void onRetry()}
                >
                    {t('thread.composer.status.bufferedRetry')}
                </button>
            </span>
        );
    }
    if (composer.status === 'error') {
        return (
            <span className="thread-composer__status is-error">
                {t('thread.composer.status.error')}
                <button
                    type="button"
                    className="ctl ctl--link-muted"
                    disabled={readOnly}
                    {...(readOnly ? { title: readOnlyReason } : {})}
                    onClick={() => void onRetry()}
                >
                    {t('thread.composer.status.retry')}
                </button>
            </span>
        );
    }
    if (composer.status === 'saving') {
        return <span className="thread-composer__status">{t('thread.composer.status.saving')}</span>;
    }
    if (composer.status === 'saved') {
        return (
            <span className="thread-composer__status is-saved">
                <Icon name="check" size={13} />{' '}
                {t(composer.published === true ? 'thread.composer.status.savedPublished' : 'thread.composer.status.saved')}
                {composer.savedAt == null ? null : <> · {formatTime(composer.savedAt)}</>}
            </span>
        );
    }
    if (composer.text !== '' || composer.commentId !== null) {
        return <span className="thread-composer__status">{t('thread.composer.status.unsaved')}</span>;
    }
    return null;
}

function isComposerInputCode(code: string): boolean {
    return code.startsWith('Key') || code.startsWith('Digit') || code === 'Space';
}

function formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
