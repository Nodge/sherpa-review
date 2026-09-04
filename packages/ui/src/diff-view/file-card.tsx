import type { FileContent, FileDiff } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import { FileContextMenu, useContextMenu } from '../components/context-menu.tsx';
import { useDelayedPending } from '../components/use-delayed-pending.js';
import { ViewedToggle } from '../components/viewed-toggle.tsx';
import type { DiffFileModel } from '../diff/model.js';
import type { Translate } from '../i18n/index.js';
import { useFormat, useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import type { FileReadState } from '../progress/read-state.js';
import { readStateTooltip } from '../progress/read-state.js';
import type { ContextExpandRequest, ContextExpandResult, GapExpandResult } from './context-expansion.js';
import { DiffRows } from './diff-rows.tsx';
import type { FileExpansion } from './expand.js';
import {
    expandFileContext,
    gapExpansionDelta,
    gapKeyOf,
    remainingHiddenChanged,
    remainingHiddenLines,
} from './expand.js';
import type { LineKey, LineRange, LineSelection } from './selection.js';
import { lineSide, parseLineKey } from './selection.js';
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
    readonly onSelectStart: (fileId: string, key: LineKey, side: 'old' | 'new', extend: boolean) => void;
    readonly onSelectExtend: (fileId: string, key: LineKey, side: 'old' | 'new') => void;
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
    /** Reason for unavailable content. Defaults to a host without `fileContent`. */
    readonly noContentReason?: string | undefined;
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
    /** Precomputed render model for consumers that need it outside the card. */
    readonly shownModel?: DiffFileModel | null;
    /** Header counters override file totals. On the route, the card shows counts for its stop. */
    readonly counts?: { readonly additions: number; readonly deletions: number };
    readonly selection: LineSelection | null;
    /** Route badge in the header (README §10): "explained in 02 · …" or a hatch. */
    readonly routeBadge?: ReactNode;
    /** Strips for uncovered ranges with no row, grouped below the header. */
    readonly routeStrips?: ReactNode;
    readonly threadsUnderHeader?: ReactNode;
    readonly focusedThreadRange?: LineRange | null;
    readonly renderAfterLine?: ((side: 'old' | 'new', line: number) => ReactNode) | undefined;
    readonly actions: FileCardActions;
}

/**
 * The first card to reach its rows sets a mark. The performance spec measures time to the first
 * diff frame from it. The flag is module-level because there must be one mark per page, not per card.
 */
let firstDiffFrameMarked = false;

function markFirstDiffFrame(): void {
    if (firstDiffFrameMarked || typeof performance === 'undefined' || typeof performance.mark !== 'function') {
        return;
    }
    firstDiffFrameMarked = true;
    performance.mark('sherpa:first-diff-frame');
}

/** The exact model `FileCard` passes to the diff rows. */
export function shownFileModel(
    model: DiffFileModel | null,
    content: FileContent | null,
    expansion: FileExpansion,
    transform?: (model: DiffFileModel) => DiffFileModel,
): DiffFileModel | null {
    if (model === null) {
        return null;
    }
    const expanded = expandFileContext(model, content, expansion);
    return transform === undefined ? expanded : transform(expanded);
}

export const FileCard = memo(function FileCard(props: FileCardProps) {
    const {
        file,
        model,
        parseError = null,
        mode,
        content,
        contentAvailable,
        noContentReason,
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
        shownModel,
        counts,
        selection,
        routeBadge = null,
        routeStrips = null,
        threadsUnderHeader = null,
        focusedThreadRange = null,
        renderAfterLine,
        actions,
    } = props;
    const t = useT();
    const { count } = useFormat();
    const [hint, setHint] = useState<Feedback>(initialHint);
    const [announcement, setAnnouncement] = useState('');
    const menu = useContextMenu();

    // Model with context already expanded. Expansion is a pure function of the original model.
    const shown = useMemo(
        () => (shownModel === undefined ? shownFileModel(model, content ?? null, expansion, transform) : shownModel),
        [content, expansion, model, shownModel, transform],
    );

    const changed =
        counts === undefined
            ? (model?.additions ?? file.additions) + (model?.deletions ?? file.deletions)
            : counts.additions + counts.deletions;
    const sizeCollapsed = !opened && changed > COLLAPSE_THRESHOLD;

    const rowsRendered = collapseReason === null && !sizeCollapsed && shown?.content.kind === 'text';
    useEffect(() => {
        if (rowsRendered) {
            markFirstDiffFrame();
        }
    }, [rowsRendered]);

    const run = (action: Promise<Feedback>): void => {
        void action.then(setHint, (error: unknown) => {
            setHint(error instanceof Error ? error.message : String(error));
        });
    };
    const onShowWhitespace = useCallback(() => {
        actions.onShowWhitespace(file.fileId);
    }, [actions, file.fileId]);
    const onSelectStart = useCallback(
        (key: LineKey, side: 'old' | 'new', extend: boolean) => {
            actions.onSelectStart(file.fileId, key, side, extend);
        },
        [actions, file.fileId],
    );
    const onSelectExtend = useCallback(
        (key: LineKey, side: 'old' | 'new') => {
            actions.onSelectExtend(file.fileId, key, side);
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
    const onContextExpanded = useCallback(
        (loaded: number, hidden: number, hiddenChanged: number) => {
            setAnnouncement(expansionAnnouncement(loaded, hidden, hiddenChanged, t));
        },
        [t],
    );

    return (
        <article
            className={`file-card${file.generated ? ' file-card--generated' : ''}`}
            id={`file-${file.fileId}`}
            data-file={file.fileId}
        >
            <header
                className={`file-card__header${onToggleCollapse === undefined ? '' : ' file-card__header--collapsible'}`}
                // Outside tab order but accepts focus: focus returns here when a menu
                // opened by right-clicking the header is closed with the keyboard.
                tabIndex={-1}
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
                onContextMenu={menu.openAtPointer}
            >
                <FileName file={file} />
                <ConflictBadge file={file} />
                <span className="file-card__counts">
                    <span className="file-card__add">
                        +{count(counts?.additions ?? model?.additions ?? file.additions)}
                    </span>
                    <span className="file-card__del">
                        −{count(counts?.deletions ?? model?.deletions ?? file.deletions)}
                    </span>
                </span>
                <span className="file-card__entity">{entityText(shown, t)}</span>

                {routeBadge}

                {/* The blame link moved into the menu ("Open on the web"). "⋯" takes its place in the header. */}
                <span className="file-card__actions">
                    <button
                        type="button"
                        className="file-card__header-action"
                        aria-haspopup="menu"
                        aria-expanded={menu.open}
                        aria-label={t('file.menu.more')}
                        onClick={menu.openAtButton}
                    >
                        ⋯
                    </button>
                </span>

                <ExpandButton
                    model={shown}
                    content={content}
                    contentAvailable={contentAvailable}
                    noContentReason={noContentReason}
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
                    title={readStateTooltip(t, read)}
                    onToggle={(viewed) => {
                        run(actions.onViewed(file.fileId, viewed));
                    }}
                />
            </header>

            {menu.anchor === null ? null : (
                <FileContextMenu
                    file={file}
                    viewed={read.state === 'read'}
                    onToggleViewed={() => {
                        run(actions.onViewed(file.fileId, read.state !== 'read'));
                    }}
                    anchor={menu.anchor}
                    onClose={menu.close}
                    toggleRef={menu.toggleRef}
                />
            )}

            {collapseReason === null ? routeStrips : null}

            {threadsUnderHeader}

            {keptInView ? (
                <p className="file-card__kept">{t('diff.file.kept')}</p>
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
                                {t('diff.file.retry')}
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
                    {t('diff.file.parseFailed', parseError)}
                    <button
                        type="button"
                        className="file-card__action"
                        onClick={() => {
                            actions.onRetryParse(file.fileId);
                        }}
                    >
                        {t('diff.file.retryParse')}
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
                    {t('diff.file.sizeCollapsed', changed)}
                </button>
            ) : (
                <Body
                    model={shown}
                    mode={mode}
                    content={content ?? null}
                    contextAvailable={contentAvailable && content !== null}
                    loadingMinHeight={loadingMinHeight}
                    selection={selection}
                    focusedThreadRange={focusedThreadRange}
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
    const t = useT();
    const { count } = useFormat();
    const text = t(
        reason === 'viewed'
            ? 'diff.file.collapsed.viewed'
            : reason === 'manual'
              ? 'diff.file.collapsed.manual'
              : 'diff.file.collapsed.generated',
    );
    return (
        <button type="button" className="file-card__collapsed file-card__collapsed--file" onClick={onExpand}>
            <span className="file-card__collapsed-mark" aria-hidden="true">
                <Icon name="chev-down" size={13} />
            </span>
            <span className="file-card__add">+{count(counts?.additions ?? file.additions)}</span>
            <span className="file-card__del">−{count(counts?.deletions ?? file.deletions)}</span>
            <span>· {text}</span>
            <span className="file-card__collapsed-spacer" />
            <span className="file-card__collapsed-hint">{t('diff.file.collapsed.hint')}</span>
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

/**
 * File parsing slot (SPEC §3): space for the card body is reserved immediately, so the arriving
 * diff does not shift the layout. The label appears only if parsing takes longer than 200 ms,
 * so fast files produce no flash.
 */
function ParsingSlot({ minHeight }: { minHeight?: number | undefined }) {
    const t = useT();
    const shown = useDelayedPending(true);
    return (
        <div className="file-card__loading" style={minHeight === undefined ? undefined : { minHeight }}>
            {shown ? t('diff.body.parsing') : null}
        </div>
    );
}

/**
 * Conflict badge (SPEC §2.14, §4.1): the file is unmerged. This is a precondition, not
 * a diff property. The route does not cover it, and the conflict is resolved in the host. The header has no other
 * status badges because add/delete/rename are visible in the name and counters.
 */
function ConflictBadge({ file }: { file: FileDiff }) {
    const t = useT();
    if (file.changeType !== 'conflict') {
        return null;
    }
    return <span className="file-card__badge file-card__badge--conflict">{t('file.conflict')}</span>;
}


/**
 * aria-live announcement after loading more context in a gap.
 * Keep the Full diff pair "loaded N, hidden H" unchanged because `hiddenChanged` is always 0 there.
 * In a route slice, "hidden 0" would be false, so report changed lines from other stops separately.
 */
export function expansionAnnouncement(
    loaded: number,
    hidden: number,
    hiddenChanged: number,
    t: Translate,
): string {
    const parts = [t('diff.expand.loaded', loaded)];
    if (hidden > 0 || hiddenChanged === 0) {
        parts.push(t('diff.expand.hidden', hidden));
    }
    if (hiddenChanged > 0) {
        parts.push(t('diff.elsewhere', hiddenChanged));
    }
    return parts.join(', ');
}

/** The only header button expands the whole file. The 20-line step belongs to gap bars. */
function ExpandButton({
    model,
    content,
    contentAvailable,
    noContentReason,
    onExpand,
}: {
    model: DiffFileModel | null;
    content: FileContent | null | undefined;
    contentAvailable: boolean;
    noContentReason: string | undefined;
    onExpand: (gapKeys: readonly string[]) => void;
}) {
    const t = useT();
    const gapKeys =
        model?.content.kind === 'text'
            ? model.content.blocks.filter((block) => block.kind === 'gap').map((gap) => gapKeyOf(gap))
            : [];
    // The button cannot expand changed lines from other stops, so it stays disabled,
    // but it cannot claim the whole file is on screen either.
    const hiddenChanged = model === null ? 0 : remainingHiddenChanged(model);
    const disabledReason = !contentAvailable
        ? (noContentReason ?? t('diff.expand.noContent'))
        : model === null
          ? t('diff.expand.parsing')
          : content === null
            ? t('diff.expand.noFileContent')
            : remainingHiddenLines(model, content ?? null) !== 0
              ? null
              : hiddenChanged > 0
                ? t('diff.expand.allShownElsewhere', t('diff.elsewhere', hiddenChanged))
                : t('diff.expand.allShown');

    return (
        <span className="file-card__expand">
            <button
                type="button"
                className="file-card__header-action"
                disabled={disabledReason !== null}
                title={disabledReason ?? t('diff.expand.showWholeFile')}
                onClick={() => {
                    onExpand(gapKeys);
                }}
            >
                {t('diff.expand.openFile')}
            </button>
        </span>
    );
}

/** Single-line notices from SPEC §2.14: binary, mode change, whitespace only. */
function Notices({ model, file }: { model: DiffFileModel | null; file: FileDiff }) {
    const t = useT();
    if (model === null) {
        return null;
    }

    return (
        <>
            {model.content.kind === 'binary' ? (
                <p className="file-card__notice">{t('diff.notice.binary')}</p>
            ) : null}
            {model.modeChange === null ? null : (
                <p className="file-card__notice">
                    {t('diff.notice.mode', model.modeChange.from, model.modeChange.to)}
                </p>
            )}
            {model.content.kind === 'none' && model.modeChange === null && !file.binary ? (
                <p className="file-card__notice">{t('diff.notice.noText')}</p>
            ) : null}
            {model.malformed ? <p className="file-card__notice">{t('diff.notice.malformed')}</p> : null}
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
    readonly focusedThreadRange: LineRange | null;
    readonly showWhitespace: boolean;
    readonly onShowWhitespace: () => void;
    readonly onSelectStart: (key: LineKey, side: 'old' | 'new', extend: boolean) => void;
    readonly onSelectExtend: (key: LineKey, side: 'old' | 'new') => void;
    readonly renderAfterLine?: ((side: 'old' | 'new', line: number) => ReactNode) | undefined;
    readonly onCommentLine?: ((side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineFocus?: ((side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineBlur?: (() => void) | undefined;
    readonly onExpandContext: (request: ContextExpandRequest) => Promise<GapExpandResult>;
    readonly onContextExpanded: (loaded: number, hidden: number, hiddenChanged: number) => void;
    readonly initialGapError: boolean;
}

function Body(props: BodyProps) {
    const t = useT();
    const { model, mode, content, selection, showWhitespace, onShowWhitespace } = props;

    if (model === null) {
        return <ParsingSlot minHeight={props.loadingMinHeight} />;
    }
    if (model.content.kind !== 'text') {
        return null;
    }
    if (model.whitespaceOnly && !showWhitespace) {
        return (
            <button type="button" className="file-card__notice file-card__notice--button" onClick={onShowWhitespace}>
                {t('diff.body.whitespaceOnly')}
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
                const keyed = target.closest<HTMLElement>('[data-key]');
                const key = parseLineKey(keyed?.getAttribute('data-key'));
                if (key === null) {
                    return;
                }
                if (target.closest('.diff-row__code') !== null && !event.shiftKey) {
                    return;
                }
                const side = keyed?.dataset.side === 'old' || keyed?.dataset.side === 'new' ? keyed.dataset.side : lineSide(key);
                event.preventDefault();
                props.onSelectStart(key, side, event.shiftKey);
            }}
            onMouseOver={(event) => {
                if (event.buttons !== 1) {
                    return;
                }
                const keyed = (event.target as HTMLElement).closest<HTMLElement>('[data-key]');
                const key = parseLineKey(keyed?.getAttribute('data-key'));
                if (key !== null) {
                    const side =
                        keyed?.dataset.side === 'old' || keyed?.dataset.side === 'new' ? keyed.dataset.side : lineSide(key);
                    props.onSelectExtend(key, side);
                }
            }}
        >
            <DiffRows
                model={model}
                mode={mode}
                content={content}
                selection={selection}
                focusedThreadRange={props.focusedThreadRange}
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
function entityText(model: DiffFileModel | null, t: Translate): string {
    if (model?.content.kind !== 'text') {
        return '';
    }
    const hunk = model.content.blocks.find((block) => block.kind === 'hunk' && block.entity !== null);
    const entity = hunk?.kind === 'hunk' ? hunk.entity : null;
    if (entity === null) {
        return '';
    }

    const { label, range } = entity;
    if (model.changeType === 'add') {
        return range === null ? t('diff.entity.newFile', label) : t('diff.entity.newFileRange', label, range.from, range.to);
    }
    return range === null ? label : `${label} · ${String(range.from)}–${String(range.to)}`;
}
