import type { FileContent, FileDiff } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { memo, useCallback, useMemo, useState } from 'react';

import { ViewedToggle } from '../components/viewed-toggle.tsx';
import type { DiffFileModel } from '../diff/model.js';
import { Icon } from '../icons/icon.tsx';
import type { FileReadState } from '../progress/read-state.js';
import { formatCount, plural } from '../text.js';
import type { ContextExpandRequest, ContextExpandResult, GapExpandResult } from './context-expansion.js';
import { DiffRows } from './diff-rows.tsx';
import type { FileExpansion } from './expand.js';
import { expandFileContext, gapExpansionDelta, gapKeyOf, remainingHiddenLines } from './expand.js';
import type { LineKey, LineSelection } from './selection.js';
import { parseLineKey } from './selection.js';
import type { DiffMode, FileCollapseReason } from './store.js';

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
    /** Expand one gap bar or the whole file. The response carries final content/expansion after lazy-fetch. */
    readonly onExpand: (fileId: string, request: ContextExpandRequest) => Promise<ContextExpandResult>;
    /** Retry patch parsing after a worker failure. */
    readonly onRetryParse: (fileId: string) => void;
    /** Toggle manual/read/generated file card collapse. */
    readonly onToggleCollapse?: ((fileId: string) => void) | undefined;
    readonly onOpenFile: (fileId: string) => void;
    readonly onShowWhitespace: (fileId: string) => void;
    readonly onSelectStart: (fileId: string, key: LineKey, extend: boolean) => void;
    readonly onSelectExtend: (fileId: string, key: LineKey) => void;
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
    readonly expansion: FileExpansion;
    /** File reading progress (SPEC §2.12): box state and tooltip counts. */
    readonly read: FileReadState;
    /** Collapse reason per SPEC §2.9. null means the manual/read/generated layer is expanded. */
    readonly collapseReason?: FileCollapseReason | null;
    /** Toggle manual/read/generated collapse. Without it the header ignores clicks. */
    readonly onToggleCollapse?: (() => void) | undefined;
    /** The reviewer opened the file by hand despite size-based collapse. */
    readonly opened: boolean;
    readonly showWhitespace: boolean;
    /** Card kept on screen despite the filter (SPEC §2.7). */
    readonly keptInView?: boolean;
    /**
     * Space reserved for the "parsing diff…" skeleton, using the list estimate of card body height.
     * Without it, the virtualizer would measure the unparsed file as one line of text, and the model arriving
     * would multiply the card height along with the entire list below it.
     */
    readonly loadingMinHeight?: number | undefined;
    /** Initial hint lets the gallery show a failed write without a click. */
    readonly initialHint?: Feedback;
    /** Gallery only: deterministic error state for the first gap bar. */
    readonly initialGapError?: boolean;
    /**
     * Post-process the model before rendering, after context expansion. Route uses this
     * to clip the model to stop anchors, so "Expand context" keeps working. Expansion
     * runs on the full model, and the slice is computed from it.
     */
    readonly transform?: (model: DiffFileModel) => DiffFileModel;
    /** Header counters override file totals. On the route, the card shows counts for its stop. */
    readonly counts?: { readonly additions: number; readonly deletions: number };
    readonly selection: LineSelection | null;
    /** Route badge in the header (README §10): "explained in 02 · …" or a hatch. */
    readonly routeBadge?: ReactNode;
    /** Strips for uncovered ranges with no row, grouped below the header. */
    readonly routeStrips?: ReactNode;
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
        collapseReason = null,
        onToggleCollapse,
        opened,
        showWhitespace,
        keptInView = false,
        loadingMinHeight,
        initialHint = null,
        initialGapError = false,
        transform,
        counts,
        selection,
        routeBadge = null,
        routeStrips = null,
        threadsUnderHeader = null,
        renderAfterLine,
        actions,
    } = props;
    const [hint, setHint] = useState<Feedback>(initialHint);
    const [announcement, setAnnouncement] = useState('');

    // Model with context already expanded. Expansion is a pure function of the original model.
    const shown = useMemo(() => {
        if (model === null) {
            return null;
        }
        const expanded = expandFileContext(model, content ?? null, expansion);
        return transform === undefined ? expanded : transform(expanded);
    }, [model, content, expansion, transform]);

    const changed =
        counts === undefined
            ? (model?.additions ?? file.additions) + (model?.deletions ?? file.deletions)
            : counts.additions + counts.deletions;
    const sizeCollapsed = !opened && changed > COLLAPSE_THRESHOLD;

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
    const onExpandContext = useCallback(
        async (request: ContextExpandRequest): Promise<GapExpandResult> => {
            const result = await actions.onExpand(file.fileId, request);
            if (result.feedback !== null || request.kind !== 'gap' || model === null) {
                return { feedback: result.feedback, loaded: 0, hidden: 0 };
            }

            const beforeExpanded = expandFileContext(model, result.content, expansion);
            const afterExpanded = expandFileContext(model, result.content, result.expansion);
            const beforeShown = transform === undefined ? beforeExpanded : transform(beforeExpanded);
            const afterShown = transform === undefined ? afterExpanded : transform(afterExpanded);
            return {
                feedback: null,
                ...gapExpansionDelta(beforeShown, afterShown, result.content, request.gapKey),
            };
        },
        [actions, expansion, file.fileId, model, transform],
    );
    const onContextExpanded = useCallback((loaded: number, hidden: number) => {
        setAnnouncement(`loaded ${String(loaded)} lines, ${String(hidden)} hidden`);
    }, []);

    return (
        <article
            className={`file-card${file.generated ? ' file-card--generated' : ''}`}
            id={`file-${file.fileId}`}
            data-file={file.fileId}
        >
            <header
                className={`file-card__header${onToggleCollapse === undefined ? '' : ' file-card__header--collapsible'}`}
                onClick={(event) => {
                    const target = event.target;
                    if (
                        onToggleCollapse === undefined ||
                        !(target instanceof Element) ||
                        target.closest('button, a, .route-badge') !== null ||
                        window.getSelection()?.isCollapsed === false
                    ) {
                        return;
                    }
                    onToggleCollapse();
                }}
            >
                <FileName file={file} />
                <span className="file-card__counts">
                    <span className="file-card__add">+{formatCount(counts?.additions ?? model?.additions ?? file.additions)}</span>
                    <span className="file-card__del">−{formatCount(counts?.deletions ?? model?.deletions ?? file.deletions)}</span>
                </span>
                <span className="file-card__entity">{entityText(shown)}</span>

                {routeBadge}

                {file.blameUrl === null ? null : (
                    <span className="file-card__actions">
                        <a
                            className="file-card__header-action"
                            href={file.blameUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                        >
                            Blame
                        </a>
                    </span>
                )}

                <ExpandButton
                    model={shown}
                    content={content}
                    contentAvailable={contentAvailable}
                    onExpand={(gapKeys) => {
                        run(
                            actions
                                .onExpand(file.fileId, { kind: 'file', gapKeys })
                                .then((result) => result.feedback),
                        );
                    }}
                />

                {/* The toggle tooltip always carries progress counts (SPEC §2.12): partial progress appears
                    in those counts and the tree and chip indicators, not in the button itself. */}
                <ViewedToggle
                    className="file-card__viewed"
                    viewed={read.state === 'read'}
                    title={read.tooltip}
                    onToggle={(viewed) => {
                        run(actions.onViewed(file.fileId, viewed));
                    }}
                />
            </header>

            {collapseReason === null ? routeStrips : null}

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

            {collapseReason === null ? <Notices model={shown} file={file} /> : null}

            {collapseReason !== null ? (
                <CollapsedFileSummary
                    file={file}
                    counts={counts}
                    reason={collapseReason}
                    onExpand={() => {
                        onToggleCollapse?.();
                    }}
                />
            ) : parseError !== null && model === null ? (
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
            ) : sizeCollapsed ? (
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
                    contextAvailable={contentAvailable && content !== null}
                    loadingMinHeight={loadingMinHeight}
                    selection={selection}
                    showWhitespace={showWhitespace}
                    onShowWhitespace={onShowWhitespace}
                    onSelectStart={onSelectStart}
                    onSelectExtend={onSelectExtend}
                    renderAfterLine={renderAfterLine}
                    onCommentLine={onCommentLine}
                    onLineFocus={onLineFocus}
                    onLineBlur={actions.onLineBlur}
                    onExpandContext={onExpandContext}
                    onContextExpanded={onContextExpanded}
                    initialGapError={initialGapError}
                />
            )}
            <span className="visually-hidden" aria-live="polite">
                {announcement}
            </span>
        </article>
    );
});

function CollapsedFileSummary({
    file,
    counts,
    reason,
    onExpand,
}: {
    file: FileDiff;
    counts: FileCardProps['counts'];
    reason: FileCollapseReason;
    onExpand: () => void;
}) {
    const text =
        reason === 'viewed' ? 'viewed' : reason === 'manual' ? 'collapsed by hand' : 'generated file';
    return (
        <button type="button" className="file-card__collapsed file-card__collapsed--file" onClick={onExpand}>
            <span className="file-card__collapsed-mark" aria-hidden="true">
                <Icon name="chev-down" size={13} />
            </span>
            <span className="file-card__add">+{formatCount(counts?.additions ?? file.additions)}</span>
            <span className="file-card__del">−{formatCount(counts?.deletions ?? file.deletions)}</span>
            <span>· {text}</span>
            <span className="file-card__collapsed-spacer" />
            <span className="file-card__collapsed-hint">click to expand the lines</span>
        </button>
    );
}

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

/** The only header button expands the whole file. The 20-line step belongs to gap bars. */
function ExpandButton({
    model,
    content,
    contentAvailable,
    onExpand,
}: {
    model: DiffFileModel | null;
    content: FileContent | null | undefined;
    contentAvailable: boolean;
    onExpand: (gapKeys: readonly string[]) => void;
}) {
    const gapKeys =
        model?.content.kind === 'text'
            ? model.content.blocks.filter((block) => block.kind === 'gap').map((gap) => gapKeyOf(gap))
            : [];
    const disabledReason = !contentAvailable
        ? 'the host does not provide file contents — there is nothing to expand from'
        : model === null
          ? 'the diff is still being parsed'
          : content === null
            ? 'this file has no content'
            : remainingHiddenLines(model, content ?? null) === 0
              ? 'the entire file is already on screen'
              : null;

    return (
        <span className="file-card__expand">
            <button
                type="button"
                className="file-card__header-action"
                disabled={disabledReason !== null}
                title={disabledReason ?? 'show the entire file'}
                onClick={() => {
                    onExpand(gapKeys);
                }}
            >
                Expand file
            </button>
        </span>
    );
}

/** Single-line notices from SPEC §2.14: binary, mode change, whitespace only. */
function Notices({ model, file }: { model: DiffFileModel | null; file: FileDiff }) {
    if (model === null) {
        return null;
    }

    return (
        <>
            {model.content.kind === 'binary' ? <p className="file-card__notice">binary file not shown</p> : null}
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
    readonly contextAvailable: boolean;
    readonly loadingMinHeight?: number | undefined;
    readonly selection: LineSelection | null;
    readonly showWhitespace: boolean;
    readonly onShowWhitespace: () => void;
    readonly onSelectStart: (key: LineKey, extend: boolean) => void;
    readonly onSelectExtend: (key: LineKey) => void;
    readonly renderAfterLine?: ((side: 'old' | 'new', line: number) => ReactNode) | undefined;
    readonly onCommentLine?: ((side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineFocus?: ((side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineBlur?: (() => void) | undefined;
    readonly onExpandContext: (request: ContextExpandRequest) => Promise<GapExpandResult>;
    readonly onContextExpanded: (loaded: number, hidden: number) => void;
    readonly initialGapError: boolean;
}

function Body(props: BodyProps) {
    const { model, mode, content, selection, showWhitespace, onShowWhitespace } = props;

    if (model === null) {
        return (
            <div
                className="file-card__loading"
                style={props.loadingMinHeight === undefined ? undefined : { minHeight: props.loadingMinHeight }}
            >
                parsing the diff…
            </div>
        );
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
                onExpandContext={props.onExpandContext}
                onContextExpanded={props.onContextExpanded}
                initialGapError={props.initialGapError}
                contextAvailable={props.contextAvailable}
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
