import type { FileContent, FileDiff } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { memo, useCallback, useMemo, useState } from 'react';

import type { DiffFileModel } from '../diff/model.js';
import type { FileReadState } from '../progress/read-state.js';
import { formatCount, plural } from '../text.js';
import { DiffRows } from './diff-rows.tsx';
import type { ExpandAmount } from './expand.js';
import { expandFileContext, remainingHiddenLines } from './expand.js';
import type { LineKey, LineSelection } from './selection.js';
import { parseLineKey } from './selection.js';
import type { DiffMode } from './store.js';

/**
 * File card (README §1 "Right column: one card per hunk", §10): sticky header with the name,
 * path, counters, entity header and actions, followed by diff rows or a single-line notice.
 *
 * The card loads nothing itself. It receives model, content and state as props and emits
 * intents (`FileCardActions`). The same card can therefore work with live endpoints
 * and fixtures in the state gallery.
 */

/** Above this threshold, the file starts collapsed (SPEC §2.13). */
export const COLLAPSE_THRESHOLD = 2000;

/**
 * Inline hint below the header (SPEC §1.2: no modals). null means there is nothing to say.
 * `retry` renders "retry" alongside it and updates the hint with its own result.
 */
export interface FeedbackHint {
    readonly text: string;
    readonly retry?: () => Promise<Feedback>;
}
export type Feedback = string | FeedbackHint | null;

export interface FileCardActions {
    /** Optimistic viewed mark. The response reports a failed write. */
    readonly onViewed: (fileId: string, viewed: boolean) => Promise<Feedback>;
    /** Without `amount`, the next step is +20 lines. Returned text describes a failed load. */
    readonly onExpand: (fileId: string, amount?: ExpandAmount) => Promise<Feedback>;
    /** Retry patch parsing after a worker failure. */
    readonly onRetryParse: (fileId: string) => void;
    readonly onOpenFile: (fileId: string) => void;
    readonly onShowWhitespace: (fileId: string) => void;
    readonly onSelectStart: (fileId: string, key: LineKey, extend: boolean) => void;
    readonly onSelectExtend: (fileId: string, key: LineKey) => void;
    readonly onOpenInEditor: (path: string) => Promise<Feedback>;
    readonly onCopyLink: (fileId: string) => Promise<Feedback>;
    readonly onCommentLine?: ((fileId: string, side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineFocus?: ((fileId: string, side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineBlur?: (() => void) | undefined;
}

export interface FileCardProps {
    readonly file: FileDiff;
    /** null means the worker is still parsing the file diff. */
    readonly model: DiffFileModel | null;
    /** Patch parsing failed. The text gives the reason and appears instead of diff rows. */
    readonly parseError?: string | null;
    readonly mode: DiffMode;
    /** `undefined` means content has not been requested yet. `null` means the file has none. */
    readonly content: FileContent | null | undefined;
    /** The host can supply file contents (`capabilities.fileContent`). */
    readonly contentAvailable: boolean;
    readonly expansion: ExpandAmount;
    /** File reading progress (SPEC §2.12): box state and tooltip counts. */
    readonly read: FileReadState;
    /** The reviewer opened the file by hand despite size-based collapse. */
    readonly opened: boolean;
    readonly showWhitespace: boolean;
    /** Card kept on screen despite the filter (SPEC §2.7). */
    readonly keptInView?: boolean;
    /** Initial hint lets the gallery show a failed write without a click. */
    readonly initialHint?: Feedback;
    readonly selection: LineSelection | null;
    readonly threadsUnderHeader?: ReactNode;
    readonly renderAfterLine?: ((side: 'old' | 'new', line: number) => ReactNode) | undefined;
    readonly actions: FileCardActions;
}

export const FileCard = memo(function FileCard(props: FileCardProps) {
    const {
        file,
        model,
        parseError = null,
        mode,
        content,
        contentAvailable,
        expansion,
        read,
        opened,
        showWhitespace,
        keptInView = false,
        initialHint = null,
        selection,
        threadsUnderHeader = null,
        renderAfterLine,
        actions,
    } = props;
    const [hint, setHint] = useState<Feedback>(initialHint);

    // Model with context already expanded. Expansion is a pure function of the original model.
    const shown = useMemo(
        () => (model === null ? null : expandFileContext(model, content ?? null, expansion)),
        [model, content, expansion],
    );

    const changed = (model?.additions ?? file.additions) + (model?.deletions ?? file.deletions);
    const collapsed = !opened && changed > COLLAPSE_THRESHOLD;

    const run = (action: Promise<Feedback>): void => {
        void action.then(setHint, (error: unknown) => {
            setHint(error instanceof Error ? error.message : String(error));
        });
    };
    const onShowWhitespace = useCallback(() => {
        actions.onShowWhitespace(file.fileId);
    }, [actions, file.fileId]);
    const onSelectStart = useCallback(
        (key: LineKey, extend: boolean) => {
            actions.onSelectStart(file.fileId, key, extend);
        },
        [actions, file.fileId],
    );
    const onSelectExtend = useCallback(
        (key: LineKey) => {
            actions.onSelectExtend(file.fileId, key);
        },
        [actions, file.fileId],
    );
    const onCommentLine = useCallback(
        (side: 'old' | 'new', line: number) => {
            actions.onCommentLine?.(file.fileId, side, line);
        },
        [actions, file.fileId],
    );
    const onLineFocus = useCallback(
        (side: 'old' | 'new', line: number) => {
            actions.onLineFocus?.(file.fileId, side, line);
        },
        [actions, file.fileId],
    );

    return (
        <article
            className={`file-card${file.generated ? ' file-card--generated' : ''}`}
            id={`file-${file.fileId}`}
            data-file={file.fileId}
        >
            <header className="file-card__header">
                <FileName file={file} />
                <span className="file-card__counts">
                    <span className="file-card__add">+{formatCount(model?.additions ?? file.additions)}</span>
                    <span className="file-card__del">−{formatCount(model?.deletions ?? file.deletions)}</span>
                </span>
                <span className="file-card__entity">{entityText(shown)}</span>

                <span className="file-card__actions">
                    <button
                        type="button"
                        className="file-card__action"
                        onClick={() => {
                            run(actions.onCopyLink(file.fileId));
                        }}
                    >
                        Copy link
                    </button>
                    <button
                        type="button"
                        className="file-card__action"
                        onClick={() => {
                            run(actions.onOpenInEditor(file.path));
                        }}
                    >
                        Open in editor
                    </button>
                    {file.blameUrl === null ? null : (
                        <a
                            className="file-card__action"
                            href={file.blameUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                        >
                            Blame
                        </a>
                    )}
                </span>

                <ExpandButtons
                    model={shown}
                    content={content}
                    contentAvailable={contentAvailable}
                    expanded={expansion !== 0}
                    onExpand={(amount) => {
                        run(actions.onExpand(file.fileId, amount));
                    }}
                />

                {/* A toggle, not a checkbox. `aria-pressed` announces the state (SPEC §2.10),
                    and the tooltip always carries progress counts (SPEC §2.12). */}
                <button
                    type="button"
                    className={`file-card__viewed${read.state === 'read' ? ' is-viewed' : ''}`}
                    aria-pressed={read.state === 'read'}
                    title={read.tooltip}
                    onClick={() => {
                        run(actions.onViewed(file.fileId, read.state !== 'read'));
                    }}
                >
                    <span className={`file-card__viewed-box file-card__viewed-box--${read.state}`} aria-hidden="true">
                        ✓
                    </span>
                    {read.state === 'read' ? 'Viewed' : 'Mark viewed'}
                </button>
            </header>

            {threadsUnderHeader}

            {keptInView ? (
                <p className="file-card__kept">kept on screen, outside current filter</p>
            ) : null}

            {hint === null ? null : (
                <p className="file-card__hint" role="status">
                    {typeof hint === 'string' ? hint : hint.text}
                    {typeof hint !== 'string' && hint.retry !== undefined ? (
                        <>
                            {' · '}
                            <button
                                type="button"
                                className="file-card__action"
                                onClick={() => {
                                    const retry = hint.retry;
                                    if (retry !== undefined) {
                                        setHint(null);
                                        run(retry());
                                    }
                                }}
                            >
                                retry
                            </button>
                        </>
                    ) : null}
                </p>
            )}

            <Notices
                model={shown}
                file={file}
                onOpenInEditor={() => {
                    run(actions.onOpenInEditor(file.path));
                }}
            />

            {parseError !== null && model === null ? (
                <p className="file-card__notice">
                    diff failed to parse: {parseError}
                    <button
                        type="button"
                        className="file-card__action"
                        onClick={() => {
                            actions.onRetryParse(file.fileId);
                        }}
                    >
                        Retry
                    </button>
                </p>
            ) : collapsed ? (
                <button
                    type="button"
                    className="file-card__collapsed"
                    onClick={() => {
                        actions.onOpenFile(file.fileId);
                    }}
                >
                    {formatCount(changed)} {plural(changed, 'changed line', 'changed lines', 'changed lines')}{' '}
                    — open file
                </button>
            ) : (
                <Body
                    model={shown}
                    mode={mode}
                    content={content ?? null}
                    selection={selection}
                    expansion={expansion}
                    showWhitespace={showWhitespace}
                    onShowWhitespace={onShowWhitespace}
                    onSelectStart={onSelectStart}
                    onSelectExtend={onSelectExtend}
                    renderAfterLine={renderAfterLine}
                    onCommentLine={onCommentLine}
                    onLineFocus={onLineFocus}
                    onLineBlur={actions.onLineBlur}
                />
            )}
        </article>
    );
});

function FileName({ file }: { file: FileDiff }) {
    const cut = file.path.lastIndexOf('/');
    const name = cut === -1 ? file.path : file.path.slice(cut + 1);
    const dir = cut === -1 ? '' : file.path.slice(0, cut);
    const renamed = file.oldPath !== null && file.oldPath !== file.path;

    return (
        <span className="file-card__title">
            <span className={`file-card__name${file.changeType === 'delete' ? ' file-card__name--deleted' : ''}`}>
                {name}
            </span>
            <span className="file-card__path" title={file.path}>
                {renamed ? (
                    <>
                        <span className="file-card__old-path">{file.oldPath}</span> → {dir}
                    </>
                ) : (
                    dir
                )}
            </span>
        </span>
    );
}

/**
 * "Expand context" and "Expand all" buttons (SPEC §2.13). When disabled, they always have a `title`
 * explaining why, as required by the disabled contract in SPEC §1.1.
 */
function ExpandButtons({
    model,
    content,
    contentAvailable,
    expanded,
    onExpand,
}: {
    model: DiffFileModel | null;
    content: FileContent | null | undefined;
    contentAvailable: boolean;
    expanded: boolean;
    onExpand: (amount?: ExpandAmount) => void;
}) {
    const disabledReason = !contentAvailable
        ? 'the host does not provide file contents — there is nothing to expand from'
        : content === null
          ? 'this file has no contents'
          : model !== null && remainingHiddenLines(model, content ?? null) === 0
            ? 'the whole file is already on screen'
            : null;
    const disabled = disabledReason !== null;

    return (
        <span className="file-card__expand">
            <button
                type="button"
                className="file-card__action"
                disabled={disabled}
                title={disabledReason ?? 'show 20 unchanged lines around each block'}
                onClick={() => {
                    onExpand();
                }}
            >
                Context ±20
            </button>
            {expanded && !disabled ? (
                <button
                    type="button"
                    className="file-card__action"
                    onClick={() => {
                        onExpand('all');
                    }}
                >
                    Expand all
                </button>
            ) : null}
        </span>
    );
}

/** Single-line notices from SPEC §2.14: binary, mode change, whitespace only. */
function Notices({
    model,
    file,
    onOpenInEditor,
}: {
    model: DiffFileModel | null;
    file: FileDiff;
    onOpenInEditor: () => void;
}) {
    if (model === null) {
        return null;
    }

    return (
        <>
            {model.content.kind === 'binary' ? (
                <p className="file-card__notice">
                    binary file not shown
                    <button type="button" className="file-card__action" onClick={onOpenInEditor}>
                        Open in editor
                    </button>
                </p>
            ) : null}
            {model.modeChange === null ? null : (
                <p className="file-card__notice">
                    mode {model.modeChange.from} → {model.modeChange.to}
                </p>
            )}
            {model.content.kind === 'none' && model.modeChange === null && !file.binary ? (
                <p className="file-card__notice">no text changes</p>
            ) : null}
            {model.malformed ? (
                <p className="file-card__notice">part of the patch failed to parse — shown as is</p>
            ) : null}
        </>
    );
}

interface BodyProps {
    readonly model: DiffFileModel | null;
    readonly mode: DiffMode;
    readonly content: FileContent | null;
    readonly selection: LineSelection | null;
    readonly expansion: ExpandAmount;
    readonly showWhitespace: boolean;
    readonly onShowWhitespace: () => void;
    readonly onSelectStart: (key: LineKey, extend: boolean) => void;
    readonly onSelectExtend: (key: LineKey) => void;
    readonly renderAfterLine?: ((side: 'old' | 'new', line: number) => ReactNode) | undefined;
    readonly onCommentLine?: ((side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineFocus?: ((side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineBlur?: (() => void) | undefined;
}

function Body(props: BodyProps) {
    const { model, mode, content, selection, showWhitespace, onShowWhitespace } = props;

    if (model === null) {
        return <div className="file-card__loading">parsing the diff…</div>;
    }
    if (model.content.kind !== 'text') {
        return null;
    }
    if (model.whitespaceOnly && !showWhitespace) {
        return (
            <button type="button" className="file-card__notice file-card__notice--button" onClick={onShowWhitespace}>
                whitespace only — show
            </button>
        );
    }

    return (
        <div
            className="file-card__body"
            onMouseDown={(event) => {
                // Drag selection starts in the gutter. Mouse gestures in code keep native text selection.
                const target = event.target as HTMLElement;
                if (target.closest('.diff-row__comment') !== null) {
                    return;
                }
                const key = parseLineKey(target.closest('[data-key]')?.getAttribute('data-key'));
                if (key === null) {
                    return;
                }
                if (target.closest('.diff-row__code') !== null && !event.shiftKey) {
                    return;
                }
                event.preventDefault();
                props.onSelectStart(key, event.shiftKey);
            }}
            onMouseOver={(event) => {
                if (event.buttons !== 1) {
                    return;
                }
                const key = parseLineKey((event.target as HTMLElement).closest('[data-key]')?.getAttribute('data-key'));
                if (key !== null) {
                    props.onSelectExtend(key);
                }
            }}
        >
            <DiffRows
                model={model}
                mode={mode}
                content={content}
                selection={selection}
                renderAfterLine={props.renderAfterLine}
                onCommentLine={props.onCommentLine}
                onLineFocus={props.onLineFocus}
                onLineBlur={props.onLineBlur}
            />
        </div>
    );
}

/** Entity header (SPEC §2.13): empty if the parser found nothing. Never displays "unknown". */
function entityText(model: DiffFileModel | null): string {
    if (model?.content.kind !== 'text') {
        return '';
    }
    const hunk = model.content.blocks.find((block) => block.kind === 'hunk' && block.entity !== null);
    const entity = hunk?.kind === 'hunk' ? hunk.entity : null;
    if (entity === null) {
        return '';
    }

    const { label, range } = entity;
    const prefix = model.changeType === 'add' ? 'new file · ' : '';
    return range === null ? `${prefix}${label}` : `${prefix}${label} · ${String(range.from)}–${String(range.to)}`;
}
