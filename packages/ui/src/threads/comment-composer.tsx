import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../icons/icon.tsx';
import { useReadOnlyIteration, useReadOnlyReason } from '../iterations/read-only.tsx';
import { useUiSettings, useUiSettingsStore } from '../settings/context.tsx';
import { shortCommit } from '../text.js';
import { composerControllerFor } from './composer.js';
import type { ComposerTransport } from './composer.js';
import { editMarkdown } from './composer-markdown.js';
import type { ComposerLayout, ComposerTool } from './composer-markdown.js';
import type { ComposerSnapshot, ThreadStore } from './store.js';
import type { VisualEditorHandle } from './visual-editor.js';

const TOOLS: readonly {
    tool: ComposerTool;
    icon: 'bold' | 'italic' | 'link' | 'code' | 'codeblock' | 'list';
    title: string;
}[] = [
    { tool: 'bold', icon: 'bold', title: 'Bold · ⌘B' },
    { tool: 'italic', icon: 'italic', title: 'Italic · ⌘I' },
    { tool: 'link', icon: 'link', title: 'Link · ⌘K' },
    { tool: 'code', icon: 'code', title: 'Inline code' },
    { tool: 'codeblock', icon: 'codeblock', title: 'Code block' },
    { tool: 'list', icon: 'list', title: 'List' },
];

export interface CommentComposerProps {
    readonly composer: ComposerSnapshot;
    readonly store: ThreadStore;
    readonly transport: ComposerTransport;
    readonly contextLabel: string;
    readonly placeholder: string;
    readonly inputLabel: string;
    readonly saveLabel?: 'Save draft' | 'Save changes';
    readonly notice?: ReactNode;
    readonly footerHint?: ReactNode;
    readonly initialLayout?: ComposerLayout;
    readonly onSaveComplete?: (() => void) | undefined;
    readonly closeOnSave?: boolean;
    readonly showDraftChip?: boolean;
    /** The thread pin commit: the draft was written before the push and will go to this commit (SPEC §4.5). */
    readonly pinnedCommit?: string | null;
    readonly restoreOnCancel?: string;
    readonly onCancel?: (() => void) | undefined;
}

/** Shared composer for replies, PR comments and line comments. */
export function CommentComposer({
    composer,
    store,
    transport,
    contextLabel,
    placeholder,
    inputLabel,
    saveLabel,
    notice,
    footerHint,
    initialLayout,
    onSaveComplete,
    closeOnSave = true,
    showDraftChip = false,
    pinnedCommit = null,
    restoreOnCancel,
    onCancel,
}: CommentComposerProps) {
    const controller = useMemo(
        () => composerControllerFor({ store, key: composer.key, transport }),
        [composer.key, store, transport],
    );
    const settings = useUiSettingsStore();
    // Composer layout is global (SPEC §2.8). Until the reviewer switches it in this composer,
    // it follows the settings, including those that arrive from the server after mounting.
    const [chosenLayout, setChosenLayout] = useState<ComposerLayout | null>(initialLayout ?? null);
    const settingsLayout = useUiSettings().composerLayout;
    const layout = chosenLayout ?? settingsLayout;
    const [visualReady, setVisualReady] = useState(false);
    const resolvedSaveLabel = saveLabel ?? 'Save draft';
    const resolvedRestoreOnCancel =
        restoreOnCancel ?? (composer.commentId === null ? undefined : (composer.originalText ?? composer.text));
    const resolvedWhileTyping = notice !== undefined;
    // Drafts from a previous iteration are visible but cannot be edited (M4 boundaries). The composer can
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
          ? 'The draft is being deleted.'
          : composer.text.trim() === ''
            ? 'Type the comment text.'
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
    }, [composer.key, controller, inputLabel, layout]);

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
        const edit = editMarkdown(composer.text, textarea.selectionStart, textarea.selectionEnd, tool);
        controller.input(edit.text);
        queueMicrotask(() => {
            textarea.focus();
            textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
        });
    };

    return (
        <div className="thread-composer" data-composer-key={composer.key}>
            {resolvedWhileTyping ? <div className="thread-composer__notice">{notice}</div> : null}
            <div className="thread-composer__context">
                <span>{contextLabel}</span>
                {showDraftChip || composer.commentId !== null ? (
                    <span className="thread__chip thread__chip--draft" {...(pinnedCommit === null ? {} : { title: pinnedCommit })}>
                        {pinnedCommit === null
                            ? 'draft · publishes on ship'
                            : `draft · pinned to ${shortCommit(pinnedCommit)}`}
                    </span>
                ) : null}
            </div>
            <div className="thread-composer__editor">
                <div className="thread-composer__toolbar" role="toolbar" aria-label="Comment formatting">
                    {TOOLS.map((item) => (
                        <button
                            key={item.tool}
                            type="button"
                            className="thread-composer__tool"
                            title={item.title}
                            aria-label={item.title}
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
                    <div className="thread-composer__layout" aria-label="Editor layout">
                        <button
                            type="button"
                            className={layout === 'visual' ? 'is-active' : ''}
                            aria-pressed={layout === 'visual'}
                            onClick={() => {
                                selectLayout('visual');
                            }}
                        >
                            Visual
                        </button>
                        <button
                            type="button"
                            className={layout === 'markdown' ? 'is-active' : ''}
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
            <div className="thread-composer__actions">
                <button
                    type="button"
                    className="ghost-button thread-composer__save"
                    disabled={saveDisabledReason !== null}
                    title={saveDisabledReason ?? undefined}
                    onClick={() => void save()}
                >
                    {resolvedSaveLabel}
                </button>
                <button
                    type="button"
                    className="ghost-button"
                    disabled={disabled}
                    title={disabled ? 'The draft is being deleted.' : undefined}
                    onClick={cancel}
                >
                    Cancel
                </button>
                {composer.issue === undefined ? null : (
                    <button
                        type="button"
                        className={`thread-composer__issue${composer.issue ? ' is-active' : ''}`}
                        aria-pressed={composer.issue}
                        disabled={editingDisabled}
                        onClick={() => {
                            controller.setIssue(!composer.issue);
                        }}
                    >
                        <span className="thread-composer__issue-box" aria-hidden="true">
                            {composer.issue ? <Icon name="check" size={9} /> : null}
                        </span>
                        Open an issue
                    </button>
                )}
                <span className="thread-composer__actions-spacer" />
                {footerHint}
                {composer.confirmDiscard ? (
                    <span className="thread-composer__confirm">
                        Discard this draft?{' '}
                        <button type="button" onClick={() => void controller.confirmDiscard()}>
                            discard
                        </button>{' '}
                        <button type="button" onClick={controller.keepEditing}>
                            continue
                        </button>
                    </span>
                ) : (
                    <ComposerStatus
                        composer={composer}
                        readOnly={readOnly}
                        // Retrying a buffered write is the same explicit save. On success,
                        // the draft has reached the host and the composer has nothing left to hold.
                        onRetry={composer.status === 'buffered' ? save : controller.retry}
                    />
                )}
            </div>
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
    const readOnlyReason = useReadOnlyReason();
    if (composer.status === 'discarding') {
        return <span className="thread-composer__status">deleting…</span>;
    }
    // The text is already on the server. The host has not accepted it, but it can no longer be lost (M5-T15).
    if (composer.status === 'buffered') {
        const error = composer.bufferEntry?.error ?? null;
        return (
            <span className="thread-composer__status" {...(error === null ? {} : { title: error })}>
                we will save it once the connection is back ·{' '}
                <button
                    type="button"
                    disabled={readOnly}
                    {...(readOnly ? { title: readOnlyReason } : {})}
                    onClick={() => void onRetry()}
                >
                    retry
                </button>
            </span>
        );
    }
    if (composer.status === 'error') {
        return (
            <span className="thread-composer__status is-error">
                not saved — the draft stays in the field ·{' '}
                <button
                    type="button"
                    disabled={readOnly}
                    {...(readOnly ? { title: readOnlyReason } : {})}
                    onClick={() => void onRetry()}
                >
                    retry
                </button>
            </span>
        );
    }
    if (composer.status === 'saving') {
        return <span className="thread-composer__status">saving…</span>;
    }
    if (composer.status === 'saved') {
        return (
            <span className="thread-composer__status is-saved">
                <Icon name="check" size={13} /> saved as a draft
                {composer.savedAt == null ? null : <> · {formatTime(composer.savedAt)}</>}
            </span>
        );
    }
    if (composer.text !== '' || composer.commentId !== null) {
        return <span className="thread-composer__status">not saved — ⌘⏎ or the button</span>;
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
