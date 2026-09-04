import type { AgentNote, FileContent, FileDiff, Thread } from '@sherpa/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ReactNode, Ref } from 'react';
import {
    memo,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';

import type { DiffFileModel } from '../diff/model.js';
import { useT } from '../i18n/index.js';
import type { CardNoteActions } from '../notes/card-notes.tsx';
import { useCardNotes } from '../notes/card-notes.tsx';
import type { FileReadState } from '../progress/read-state.js';
import { readStateOf as computeReadState } from '../progress/read-state.js';
import type { AnchorSpan } from '../route/anchor-clip.js';
import type { RouteMarginFile, RouteMarginModel } from '../route/margin-model.js';
import type { SessionStore } from '../session/session-store.js';
import type { MarginStripActions } from '../route/route-margin.tsx';
import { RouteBadge, useMarginStrips } from '../route/route-margin.tsx';
import { useCardThreads } from '../threads/card-threads.tsx';
import type { ThreadActions } from '../threads/thread-list.tsx';
import { createThreadStore } from '../threads/store.js';
import type { ComposerSnapshot, ThreadStore } from '../threads/store.js';
import type { ContextExpandRequest, ContextExpandResult } from './context-expansion.js';
import { expandContext } from './context-expansion.js';
import type { FileExpansion } from './expand.js';
import type { Feedback, FileCardActions } from './file-card.tsx';
import type { LineSelection } from './selection.js';
import { COLLAPSE_THRESHOLD, FileCard, shownFileModel } from './file-card.tsx';
import type { DiffMode, DiffViewStore, FileCollapseReason } from './store.js';
import { fileCollapseReason } from './store.js';
import { useSelectionLifecycle } from './use-selection.js';

/**
 * Virtualized list of diff cards (SPEC §8 item 8: 60+ files at 60fps). The DOM contains
 * only visible cards plus overscan, so worker parsing is lazy too: a file
 * is parsed exactly when it scrolls into view.
 *
 * `measureElement` measures actual card heights. The estimate lasts only until the first measurement.
 * To keep measurement from shifting the scroll position, the "parsing diff..." skeleton gets
 * min-height from the same estimate, since it is several times shorter than the finished card.
 * The cold card then measures close to its slot, and the model changes its height by a small delta.
 *
 * Cold cards must be measured too. They contain threads, route bars and a filter notice alongside
 * the skeleton. File metadata cannot give their heights, so an unmeasured slot has no room for them
 * and the card would overlap the next one.
 */

/** Code line height, `--line-height-code`. Used to estimate the card body before measurement. */
const CODE_LINE_HEIGHT = 20;
/** Everything in a card except lines: header 36.8 + borders 2 + gap to the next card 22 (measured in M2F-T3). */
const CARD_CHROME_HEIGHT = 61;
/** Single-line notice or collapsed card: 7+7 padding, 11px/1.5 line and a border. */
const NOTICE_ROW_HEIGHT = 32;
/**
 * Rough allowance for unchanged context lines and separators between hunks. File metadata has no
 * count for these, and `additions`/`deletions` alone cannot give it. The value was measured on
 * `fixture-large`: three context lines and two separators. The estimate still falls short for
 * files with several hunks. Accuracy is secondary here, measurement with compensation covers the gap.
 */
const HUNK_CONTEXT_HEIGHT = 104;

/** Cards to keep beyond the viewport. Fewer expose loading, more cost more. */
const OVERSCAN = 3;

/** Frames to adjust scrolling to a linked file, giving the cards time to measure. */
const SCROLL_TO_FILE_FRAMES = 12;

/** Imperative list control. The file tree requests scrolling to its row. */
export interface DiffListHandle {
    /**
     * `true` means the card was found and the virtualizer finished adjusting. `false` means cancellation or
     * a missing file. `reveal: false` preserves the target's collapsed state. Moving to the next file
     * after marking one viewed must not expand an already viewed or generated file.
     */
    readonly scrollToFile: (fileId: string, options?: { readonly reveal?: boolean }) => Promise<boolean>;
}

export interface DiffFileListProps {
    /** The view's only scroll container. The list itself stays a regular block. */
    readonly scrollElement: HTMLElement | null;
    /** Node above the list. Changes to its height shift the virtual list's start. */
    readonly scrollMarginElement?: HTMLElement | null;
    /** Sticky bar above the cards. File navigation leaves the target just below it. */
    readonly scrollPaddingStart: number;
    readonly files: readonly FileDiff[];
    readonly store: DiffViewStore;
    /** The host can supply file contents (`capabilities.fileContent`). */
    readonly contentAvailable: boolean;
    /** Why contents are missing: an inter-iteration slice has none, even without a host (M4-T12). */
    readonly noContentReason?: string | undefined;
    /** Patch parsing uses a worker for live data and a synchronous parser in the gallery. */
    readonly parse: (file: FileDiff) => Promise<DiffFileModel>;
    readonly loadContent: (fileId: string) => Promise<FileContent | null>;
    /** Viewed mark. The view owns the optimistic write, the list only calls it. */
    readonly onViewed: (fileId: string, viewed: boolean) => Promise<Feedback>;
    readonly session: SessionStore;
    readonly notes?: readonly AgentNote[];
    readonly noteActions?: CardNoteActions;
    readonly threadStore?: ThreadStore | undefined;
    readonly threadActions?: ThreadActions | undefined;
    readonly threadVisible?: ((thread: Thread) => boolean) | undefined;
    readonly onCommentLine?: ((fileId: string, side: 'old' | 'new', line: number) => void) | undefined;
    /** File comment without a line: image card menu item (M5-T24). */
    readonly onCommentFile?: ((fileId: string) => void) | undefined;
    readonly onLineFocus?: ((fileId: string, side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineBlur?: (() => void) | undefined;
    readonly onFocusThread?: ((threadId: string | null) => void) | undefined;
    readonly threadNow?: number | undefined;
    readonly outsideThreads?: ReactNode;
    /** Route in card margins (README §10). null means no route and no margins. */
    readonly routeMargin?: RouteMarginModel | null;
    /** Hatched strip action (README §10). Without it, the strip remains a label. */
    readonly marginActions?: MarginStripActions | null;
    readonly onJumpToStop?: ((stopId: string) => void) | undefined;
    /** File from the URL fragment (`file=`), scrolled to on open. */
    readonly initialFileId?: string | null;
    /**
     * File kept on screen despite the filter (SPEC §2.7): the card gets an
     * "outside current filter" notice. The view decides which file to keep.
     */
    readonly keptFileId?: string | null;
    /**
     * File from which the view has already requested navigation to the next one. Collapsing it sets no anchor,
     * or list adjustment and view scrolling would pull the screen in different directions.
     */
    readonly advancingFileId?: string | null;
    /** Top card in the viewport, used by scroll-spy for the active tree row. */
    readonly onTopFileChange?: (fileId: string | null) => void;
    /**
     * Reviewer scrolling lets the view clear the "kept on screen" mark. The list's own adjustments
     * (file link, tree navigation, repositioning after a filter change) do not trigger this.
     */
    readonly onScroll?: () => void;
    readonly ref?: Ref<DiffListHandle>;
}

export function DiffFileList({
    scrollElement,
    scrollMarginElement = null,
    scrollPaddingStart,
    files,
    store,
    contentAvailable,
    noContentReason,
    parse,
    loadContent,
    onViewed,
    session,
    notes = EMPTY_NOTES,
    noteActions = EMPTY_NOTE_ACTIONS,
    threadStore = EMPTY_THREAD_STORE,
    threadActions = EMPTY_THREAD_ACTIONS,
    threadVisible = HIDE_THREAD,
    onCommentLine = NOOP_LINE,
    onCommentFile = NOOP_FILE,
    onLineFocus = NOOP_LINE,
    onLineBlur = NOOP,
    onFocusThread = NOOP_THREAD,
    threadNow: providedThreadNow,
    outsideThreads = null,
    routeMargin = null,
    marginActions = null,
    onJumpToStop,
    initialFileId = null,
    keptFileId = null,
    advancingFileId = null,
    onTopFileChange,
    onScroll,
    ref,
}: DiffFileListProps) {
    const t = useT();
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const threadSnapshot = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot);
    const composersSnapshot = useSyncExternalStore(threadStore.subscribeComposers, threadStore.getComposersSnapshot);
    const notesByFile = useMemo(() => {
        const grouped = new Map<string, AgentNote[]>();
        for (const note of notes) {
            const bucket = grouped.get(note.anchor.fileId);
            if (bucket === undefined) {
                grouped.set(note.anchor.fileId, [note]);
            } else {
                bucket.push(note);
            }
        }
        return grouped;
    }, [notes]);
    const threadNowRef = useRef(providedThreadNow ?? Date.now());
    const threadNow = providedThreadNow ?? threadNowRef.current;
    const listRef = useRef<HTMLDivElement | null>(null);
    const [scrollMargin, setScrollMargin] = useState(0);
    const requested = useRef(new Set<string>());
    // Files whose parsing failed. Only an explicit reviewer retry will parse them again.
    const [parseErrors, setParseErrors] = useState<ReadonlyMap<string, string>>(new Map());

    // Mode used for estimates. It follows the toggle only until the first file is parsed.
    // Recalculating estimates while the list is active would shift everything below the fold.
    // The virtualizer compensates only for measured heights, not changes to estimates. This lets
    // the initial value wait for the width measurement.
    const estimateMode = useRef(snapshot.effectiveMode);
    if (snapshot.models.size === 0) {
        estimateMode.current = snapshot.effectiveMode;
    }
    const { readState, collapseCollapsed, collapseExpanded, collapseExpandedViewed } = snapshot;
    const collapseReasons = useMemo(() => {
        const reasons = new Map<string, FileCollapseReason>();
        const collapseSnapshot = { readState, collapseCollapsed, collapseExpanded, collapseExpandedViewed };
        for (const file of files) {
            const reason = fileCollapseReason(collapseSnapshot, file);
            if (reason !== null) {
                reasons.set(file.fileId, reason);
            }
        }
        return reasons;
    }, [files, readState, collapseCollapsed, collapseExpanded, collapseExpandedViewed]);

    // `scrollMargin` maps virtualizer positions to the outer scroller's coordinates.
    // Read it before painting and after layout changes. rect is more reliable than an offsetParent chain.
    useLayoutEffect(() => {
        const list = listRef.current;
        if (list === null || scrollElement === null) {
            return;
        }
        const report = (): void => {
            const margin =
                list.getBoundingClientRect().top -
                scrollElement.getBoundingClientRect().top +
                scrollElement.scrollTop;
            setScrollMargin((previous) => (previous === margin ? previous : margin));
        };
        report();
        const observer = new ResizeObserver(report);
        observer.observe(list);
        observer.observe(scrollElement);
        if (scrollMarginElement !== null) {
            observer.observe(scrollMarginElement);
        }
        return () => {
            observer.disconnect();
        };
    }, [files, scrollElement, scrollMarginElement, scrollPaddingStart]);

    const virtualizer = useVirtualizer({
        count: files.length,
        getScrollElement: () => scrollElement,
        estimateSize: (index) =>
            CARD_CHROME_HEIGHT +
            estimateBodyHeight(files[index], estimateMode.current, collapseReasons.has(files[index]?.fileId ?? '')),
        overscan: OVERSCAN,
        getItemKey: (index) => files[index]?.fileId ?? index,
        scrollMargin,
        scrollPaddingStart,
    });

    /**
     * In virtual-core 3.17.8, `shouldAdjustScrollPositionOnItemSizeChange` is an instance property,
     * not a hook option. Passing it to `useVirtualizer` silently does nothing.
     *
     * Always compensate for cards entirely above the viewport, regardless of scroll direction.
     * The library disables compensation when scrolling up by default, so a file parsed above
     * would pull the list away from the cursor. Cards touching the viewport or below it grow
     * downward. Adjusting the scroll position for them would move visible text.
     */
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) =>
        item.end <= (virtualizer.scrollOffset ?? 0) + scrollPaddingStart + virtualizer.scrollAdjustments;

    const items = virtualizer.getVirtualItems();

    // Parse visible files. The worker replies asynchronously, and each file is requested only once.
    useEffect(() => {
        for (const item of items) {
            const file = files[item.index];
            if (
                file === undefined ||
                collapseReasons.has(file.fileId) ||
                requested.current.has(file.fileId)
            ) {
                continue;
            }
            requested.current.add(file.fileId);
            void parse(file).then(
                (model) => {
                    store.setModel(file.fileId, model);
                },
                (error: unknown) => {
                    // Keep the file in `requested`. Automatic retries would loop if the worker kept failing.
                    // The card reports the failure and offers a retry button.
                    setParseErrors((previous) =>
                        new Map(previous).set(file.fileId, error instanceof Error ? error.message : String(error)),
                    );
                },
            );
        }
        // `parseErrors` is a dependency for retries. It does not change the set of visible files,
        // but clearing a failure must rerun this effect, or the retry would have to wait for
        // an unrelated scroll.
    }, [items, files, parse, store, parseErrors, collapseReasons]);

    const retryParse = useCallback((fileId: string) => {
        requested.current.delete(fileId);
        setParseErrors((previous) => {
            const next = new Map(previous);
            next.delete(fileId);
            return next;
        });
    }, []);

    // Width available to the diff: side by side is unavailable below 1100px (SPEC §2.6). Measure the
    // list itself, not the window. The tree panel on its left takes 290px that the diff cannot use.
    // Use the padding-box (`clientWidth`), since page padding is part of the space given to the diff.
    // otherwise the reference 1440px viewport (README "Fidelity") would never meet the threshold.
    // Read the initial value immediately. ResizeObserver does not fire in a background tab.
    useEffect(() => {
        const element = listRef.current;
        if (element === null) {
            return;
        }
        const report = (): void => {
            store.setAvailableWidth(element.clientWidth);
        };
        report();
        const observer = new ResizeObserver(report);
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, [store]);

    useSelectionLifecycle(store);

    // While the list adjusts scrolling itself (a `#file=` link, tree navigation, repositioning after
    // a filter change), no scroll event is reported upward. These are not reviewer gestures and
    // must not clear the "kept on screen" notice (SPEC §2.7).
    const settling = useRef(0);
    // Active adjustment sequence, cancelled by either new navigation or the reviewer's wheel.
    const converging = useRef<ConvergingScroll | null>(null);
    const converge = useCallback(
        (index: number) => {
            // Two overlapping adjustments would pull the list in different directions.
            converging.current?.cancel();
            settling.current += 1;
            const run = convergeScroll(
                () => {
                    virtualizer.scrollToIndex(index, { align: 'start' });
                },
                () => scrollElement?.scrollTop ?? 0,
                () => {
                    if (converging.current === run) {
                        converging.current = null;
                    }
                    // One frame later. The browser dispatches scroll events after the final step.
                    requestAnimationFrame(() => {
                        settling.current -= 1;
                    });
                },
            );
            converging.current = run;
            return run;
        },
        [scrollElement, virtualizer],
    );

    // ResizeObserver cannot see a card outside the DOM. When its collapsed state changes, replace its old
    // measurement with a new estimate. Keep the collapsed card's sticky header below the toolbar, since
    // the reviewer stayed on it. The only exception is a card from which the view already requested
    // a move to the next file (`advancingFileId`, decision log 2026-09-02): keeping it would
    // pull the screen back against the view's own scrolling.
    const previousCollapseReasons = useRef<ReadonlyMap<string, FileCollapseReason>>(collapseReasons);
    useEffect(() => {
        const previous = previousCollapseReasons.current;
        const frame = requestAnimationFrame(() => {
            previousCollapseReasons.current = collapseReasons;
            const viewportTop =
                (virtualizer.scrollOffset ?? 0) + scrollPaddingStart + virtualizer.scrollAdjustments;
            let anchorIndex: number | null = null;
            for (let index = 0; index < files.length; index += 1) {
                const file = files[index];
                if (file === undefined) {
                    continue;
                }
                const wasCollapsed = previous.has(file.fileId);
                const collapsed = collapseReasons.has(file.fileId);
                if (wasCollapsed === collapsed) {
                    continue;
                }
                const measurement = virtualizer.measurementsCache[index];
                if (
                    collapsed &&
                    file.fileId !== advancingFileId &&
                    measurement !== undefined &&
                    measurement.start < viewportTop &&
                    measurement.end > viewportTop
                ) {
                    anchorIndex = index;
                }
                virtualizer.resizeItem(
                    index,
                    CARD_CHROME_HEIGHT + estimateBodyHeight(file, estimateMode.current, collapsed),
                );
            }
            if (anchorIndex !== null) {
                virtualizer.scrollToIndex(anchorIndex, { align: 'start' });
                converge(anchorIndex);
            }
        });
        return () => {
            cancelAnimationFrame(frame);
        };
    }, [advancingFileId, collapseReasons, converge, files, scrollPaddingStart, virtualizer]);

    // Adjustment lasts up to 12 frames and calls `scrollToIndex` throughout. Without cancellation,
    // the reviewer's wheel and touch would have no effect during those frames.
    useEffect(() => {
        const element = scrollElement;
        if (element === null) {
            return;
        }
        return watchUserScroll(element, () => {
            converging.current?.cancel();
        });
    }, [scrollElement]);

    const focusCheck = useRef<number | null>(null);
    const handleScroll = useCallback(() => {
        if (settling.current === 0) {
            onScroll?.();
        }
        if (focusCheck.current !== null) {
            cancelAnimationFrame(focusCheck.current);
        }
        focusCheck.current = requestAnimationFrame(() => {
            focusCheck.current = null;
            const active = document.activeElement;
            if (!(active instanceof HTMLElement) || active.closest('.diff-row') === null) {
                onLineBlur();
            }
        });
    }, [onLineBlur, onScroll]);
    useEffect(() => {
        const element = scrollElement;
        if (element === null) {
            return;
        }
        element.addEventListener('scroll', handleScroll, { passive: true });
        return () => {
            element.removeEventListener('scroll', handleScroll);
        };
    }, [handleScroll, scrollElement]);
    useEffect(
        () => () => {
            if (focusCheck.current !== null) {
                cancelAnimationFrame(focusCheck.current);
            }
        },
        [],
    );

    // A file link (`#file=`) opens the diff scrolled to that file.
    const scrolled = useRef<string | null>(null);
    useEffect(() => {
        if (initialFileId === null) {
            scrolled.current = null;
            return;
        }
        if (scrolled.current === initialFileId) {
            return;
        }
        const target = initialFileId;
        const index = files.findIndex((file) => file.fileId === target);
        if (index < 0) {
            return;
        }
        scrolled.current = target;
        store.revealFile(target);

        const run = converge(index);
        return () => {
            // Adjustment was interrupted before completion (StrictMode unmounts effects twice), so
            // scrolling did not finish and the next pass must repeat it.
            if (!run.cancel() && scrolled.current === target) {
                scrolled.current = null;
            }
        };
    }, [files, initialFileId, converge, store]);

    // Scroll to a file at the tree's request. `converge` cancels the previous adjustment itself.
    useImperativeHandle(
        ref,
        () => ({
            scrollToFile: (fileId: string, options) => {
                const index = files.findIndex((file) => file.fileId === fileId);
                if (index < 0) {
                    return Promise.resolve(false);
                }
                if (options?.reveal !== false) {
                    store.revealFile(fileId);
                }
                return converge(index).finished;
            },
        }),
        [files, converge, store],
    );

    // Tree scroll-spy uses the top card in the viewport. The virtualizer rerenders the list
    // on every scroll frame, so no separate listener is needed.
    const topFileId = topFile(files, items, (virtualizer.scrollOffset ?? 0) + scrollPaddingStart);
    const reportedTop = useRef<string | null>(null);
    useEffect(() => {
        if (onTopFileChange !== undefined && topFileId !== reportedTop.current) {
            reportedTop.current = topFileId;
            onTopFileChange(topFileId);
        }
    }, [topFileId, onTopFileChange]);

    const expand = useCallback(
        (fileId: string, request: ContextExpandRequest): Promise<ContextExpandResult> =>
            expandContext({ store, fileId, request, contentAvailable, loadContent, t }),
        [contentAvailable, loadContent, store, t],
    );

    const actions = useMemo<FileCardActions>(
        () => ({
            onViewed,
            onExpand: expand,
            onRetryParse: retryParse,
            onToggleCollapse: store.toggleFileCollapse,
            onOpenFile: store.openFile,
            onShowWhitespace: store.showWhitespace,
            onSelectStart: (fileId, key, side, extend) => {
                store.beginSelection();
                if (extend) {
                    store.extendSelection(fileId, key, side);
                } else {
                    store.startSelection(fileId, key, side);
                }
            },
            onSelectExtend: store.extendSelection,
            onCommentLine,
            onCommentFile,
            onLineFocus,
            onLineBlur,
        }),
        [expand, onCommentFile, onCommentLine, onLineBlur, onLineFocus, onViewed, retryParse, store],
    );

    return (
        <div
            className="diff-list"
            ref={listRef}
            data-collapsed-files={collapseReasons.size}
            data-generated-collapsed-files={countGeneratedCollapsed(files, collapseReasons)}
        >
            <div className="diff-list__inner" style={{ height: `${String(virtualizer.getTotalSize())}px` }}>
                {items.map((item) => {
                    const file = files[item.index];
                    if (file === undefined) {
                        return null;
                    }
                    return (
                        <VirtualFileCard
                            key={file.fileId}
                            file={file}
                            index={item.index}
                            start={item.start - scrollMargin}
                            measure={virtualizer.measureElement}
                            model={snapshot.models.get(file.fileId) ?? null}
                            parseError={parseErrors.get(file.fileId) ?? null}
                            mode={snapshot.effectiveMode}
                            estimatedBody={estimateBodyHeight(
                                file,
                                estimateMode.current,
                                collapseReasons.has(file.fileId),
                            )}
                            collapseReason={collapseReasons.get(file.fileId) ?? null}
                            content={snapshot.content.get(file.fileId)}
                            contentAvailable={contentAvailable}
                            noContentReason={noContentReason}
                            expansion={snapshot.expansion.get(file.fileId) ?? EMPTY_EXPANSION}
                            read={readStateOf(snapshot, file)}
                            opened={snapshot.opened.has(file.fileId)}
                            showWhitespace={snapshot.whitespaceShown.has(file.fileId)}
                            keptInView={file.fileId === keptFileId}
                            selection={snapshot.selection?.fileId === file.fileId ? snapshot.selection : null}
                            session={session}
                            notes={notesByFile.get(file.fileId) ?? EMPTY_NOTES}
                            noteActions={noteActions}
                            threads={threadSnapshot.byFile.get(file.fileId) ?? EMPTY_THREADS}
                            keptThreadIds={threadSnapshot.keptByFile.get(file.fileId) ?? EMPTY_THREAD_IDS}
                            composers={composersSnapshot.byFile.get(file.fileId) ?? EMPTY_COMPOSERS}
                            threadVisible={threadVisible}
                            threadStore={threadStore}
                            threadActions={threadActions}
                            threadNow={threadNow}
                            onFocusThread={onFocusThread}
                            margin={routeMargin?.files.get(file.fileId) ?? null}
                            marginActions={marginActions}
                            otherStopId={routeMargin?.otherStopId ?? null}
                            onJumpToStop={onJumpToStop}
                            actions={actions}
                        />
                    );
                })}
            </div>
            {outsideThreads}
        </div>
    );
}

const EMPTY_THREADS: readonly Thread[] = [];
const EMPTY_NOTES: readonly AgentNote[] = [];
const EMPTY_NOTE_ACTIONS: CardNoteActions = {
    onOpenInChat: () => undefined,
    onTurnIntoDraft: () => undefined,
    onDelete: () => Promise.reject(new Error('deleting notes is unavailable here')),
};
const EMPTY_THREAD_IDS: ReadonlySet<string> = new Set();
const EMPTY_EXPANSION: FileExpansion = new Map();
const EMPTY_COMPOSERS: readonly ComposerSnapshot[] = [];
const EMPTY_SPANS: readonly AnchorSpan[] = [];

const VirtualFileCard = memo(function VirtualFileCard({
    file,
    index,
    start,
    measure,
    model,
    parseError,
    mode,
    estimatedBody,
    collapseReason,
    content,
    contentAvailable,
    noContentReason,
    expansion,
    read,
    opened,
    showWhitespace,
    keptInView,
    selection,
    session,
    notes,
    noteActions,
    threads,
    keptThreadIds,
    composers,
    threadVisible,
    threadStore,
    threadActions,
    threadNow,
    onFocusThread,
    margin,
    marginActions,
    otherStopId,
    onJumpToStop,
    actions,
}: {
    file: FileDiff;
    index: number;
    start: number;
    measure: (element: HTMLDivElement | null) => void;
    model: DiffFileModel | null;
    parseError: string | null;
    mode: DiffMode;
    /** Card body estimate from the list, used by the skeleton to fill its virtual slot. */
    estimatedBody: number;
    collapseReason: FileCollapseReason | null;
    content: FileContent | null | undefined;
    contentAvailable: boolean;
    noContentReason: string | undefined;
    expansion: FileExpansion;
    read: FileReadState;
    opened: boolean;
    showWhitespace: boolean;
    keptInView: boolean;
    selection: LineSelection | null;
    session: SessionStore;
    notes: readonly AgentNote[];
    noteActions: CardNoteActions;
    threads: readonly Thread[];
    keptThreadIds: ReadonlySet<string>;
    composers: readonly ComposerSnapshot[];
    threadVisible: (thread: Thread) => boolean;
    threadStore: ThreadStore;
    threadActions: ThreadActions;
    threadNow: number;
    onFocusThread: (threadId: string | null) => void;
    margin: RouteMarginFile | null;
    marginActions: MarginStripActions | null;
    otherStopId: string | null;
    onJumpToStop: ((stopId: string) => void) | undefined;
    actions: FileCardActions;
}) {
    const shownModel = useMemo(
        () => shownFileModel(model, content ?? null, expansion),
        [content, expansion, model],
    );
    const visibleThreads = useMemo(
        () => threads.filter((thread) => keptThreadIds.has(thread.id) || threadVisible(thread)),
        [keptThreadIds, threadVisible, threads],
    );
    const changed = (model?.additions ?? file.additions) + (model?.deletions ?? file.deletions);
    const canRenderRows =
        collapseReason === null &&
        parseError === null &&
        shownModel?.content.kind === 'text' &&
        (!shownModel.whitespaceOnly || showWhitespace) &&
        (opened || changed <= COLLAPSE_THRESHOLD);
    const { threadsUnderHeader, renderAfterLine: renderThreads, focusedThreadRange } = useCardThreads({
        model: shownModel,
        rowsShown: canRenderRows,
        threads: visibleThreads,
        composers,
        store: threadStore,
        actions: threadActions,
        now: threadNow,
        onFocusThread,
    });
    const { notesUnderHeader, renderAfterLine: renderNotes } = useCardNotes({
        model: shownModel,
        rowsShown: canRenderRows,
        notes,
        placement: 'nearest',
        session,
        actions: noteActions,
    });
    const { underHeader: stripsUnderHeader, renderAfterLine: renderStrip } = useMarginStrips({
        model: shownModel,
        rowsShown: canRenderRows,
        ranges: margin?.uncovered ?? EMPTY_SPANS,
        file,
        actions: marginActions,
    });
    const underHeader = threadsUnderHeader === null && notesUnderHeader === null ? null : (
        <>
            {threadsUnderHeader}
            {notesUnderHeader}
        </>
    );
    // Threads, notes and hatching share the slot below a line, in the same order in both views.
    const renderAfterLine = useCallback(
        (side: 'old' | 'new', line: number): ReactNode => {
            const threads = renderThreads(side, line);
            const noteRows = renderNotes(side, line);
            const strip = renderStrip(side, line);
            if (threads === null && noteRows === null && strip === null) {
                return null;
            }
            return (
                <>
                    {threads}
                    {noteRows}
                    {strip}
                </>
            );
        },
        [renderNotes, renderStrip, renderThreads],
    );

    return (
        <div
            className="diff-list__item"
            data-index={index}
            ref={measure}
            // Position with `top`, not `transform`. The card's sticky header uses its layout position
            // and would otherwise stick at its bottom instead of the top edge of the screen.
            style={{ top: `${String(start)}px` }}
        >
            <FileCard
                file={file}
                model={model}
                parseError={parseError}
                mode={mode}
                content={content}
                contentAvailable={contentAvailable}
                noContentReason={noContentReason}
                expansion={expansion}
                shownModel={shownModel}
                read={read}
                collapseReason={collapseReason}
                onToggleCollapse={() => {
                    actions.onLineBlur?.();
                    // State lives in DiffViewStore. FileCard stays pure, and the route does not receive this state.
                    actions.onToggleCollapse?.(file.fileId);
                }}
                opened={opened}
                showWhitespace={showWhitespace}
                keptInView={keptInView}
                loadingMinHeight={estimatedBody}
                selection={selection}
                routeBadge={
                    margin === null ? null : (
                        <RouteBadge
                            file={margin}
                            otherStopId={otherStopId}
                            variant="card"
                            onJump={onJumpToStop}
                        />
                    )
                }
                routeStrips={stripsUnderHeader}
                threadsUnderHeader={underHeader}
                focusedThreadRange={focusedThreadRange}
                renderAfterLine={renderAfterLine}
                actions={actions}
            />
        </div>
    );
});

interface ConvergingScroll {
    /** `true` once adjustment has finished on its own. */
    readonly cancel: () => boolean;
    /** Natural completion returns `true`, cancellation by competing navigation returns `false`. */
    readonly finished: Promise<boolean>;
}

/**
 * Adjust virtualizer scrolling. Heights are estimates until cards are first measured, so
 * the target moves and a single call is not enough. Repeat until the position stops changing.
 * `onDone` runs exactly once, on both natural completion and cancellation.
 */
export function convergeScroll(
    step: () => void,
    currentTop: () => number,
    onDone: (completed: boolean) => void,
): ConvergingScroll {
    let attempts = 0;
    let previousTop = -1;
    let done = false;
    let resolveFinished: (completed: boolean) => void = () => undefined;
    const finished = new Promise<boolean>((resolve) => {
        resolveFinished = resolve;
    });
    const finish = (completed: boolean): void => {
        if (!done) {
            done = true;
            onDone(completed);
            resolveFinished(completed);
        }
    };

    let frame = requestAnimationFrame(function tick() {
        step();
        attempts += 1;
        const top = currentTop();
        const converged = top === previousTop;
        previousTop = top;
        if (!converged && attempts < SCROLL_TO_FILE_FRAMES) {
            frame = requestAnimationFrame(tick);
            return;
        }
        attempts = SCROLL_TO_FILE_FRAMES;
        finish(true);
    });

    return {
        finished,
        cancel: () => {
            cancelAnimationFrame(frame);
            const completed = attempts >= SCROLL_TO_FILE_FRAMES;
            finish(completed);
            return completed;
        },
    };
}

/**
 * File read state from the snapshot. If the file is absent from the map (the store was built
 * for a different set), use the file's own defaults instead of showing an empty box.
 */
function readStateOf(snapshot: { readState: ReadonlyMap<string, FileReadState> }, file: FileDiff): FileReadState {
    return snapshot.readState.get(file.fileId) ?? computeReadState({ file, record: null });
}

/** First card whose bottom is still below the viewport's top edge. null means nothing to show. */
function topFile(
    files: readonly FileDiff[],
    items: readonly { index: number; end: number }[],
    offset: number,
): string | null {
    for (const item of items) {
        if (item.end > offset) {
            return files[item.index]?.fileId ?? null;
        }
    }
    return null;
}

const EMPTY_THREAD_STORE = createThreadStore([], new Set());
const EMPTY_THREAD_ACTIONS: ThreadActions = {
    transport: {
        save: () => Promise.reject(new Error('drafts are unavailable here')),
        update: () => Promise.reject(new Error('drafts are unavailable here')),
        delete: () => Promise.reject(new Error('drafts are unavailable here')),
    },
    resolve: () => Promise.reject(new Error('resolve is unavailable here')),
};
const HIDE_THREAD = (): boolean => false;
const NOOP = (): void => undefined;
const NOOP_LINE = (): void => undefined;
const NOOP_FILE = (): void => undefined;
const NOOP_THREAD = (): void => undefined;

function countGeneratedCollapsed(
    files: readonly FileDiff[],
    reasons: ReadonlyMap<string, FileCollapseReason>,
): number {
    return files.reduce((count, file) => count + (file.generated && reasons.has(file.fileId) ? 1 : 0), 0);
}

/**
 * Estimate of everything below the card header. The virtualizer uses it until measurement, and the
 * skeleton uses it to fill its slot, so the model changes height by a small delta instead of several times.
 */
export function estimateBodyHeight(file: FileDiff | undefined, mode: DiffMode, collapsed = false): number {
    if (file === undefined) {
        return 0;
    }
    const changed = file.additions + file.deletions;
    // Binary files, files without a text diff and all collapsed cards show a single-line notice.
    // This is known before the first frame, so folds and viewed marks do not inflate the scrollbar.
    if (collapsed || file.binary || file.patch === null || changed > COLLAPSE_THRESHOLD) {
        return NOTICE_ROW_HEIGHT;
    }

    // In split mode, a deletion and an addition share one row. One-sided files do not collapse
    // collapses and renders unified at full width (README §1).
    const lines =
        mode === 'split' && file.additions > 0 && file.deletions > 0
            ? Math.max(file.additions, file.deletions)
            : changed;
    // add/delete files form one hunk for the whole file, with no unchanged context.
    const context = file.changeType === 'add' || file.changeType === 'delete' ? 0 : HUNK_CONTEXT_HEIGHT;
    return lines * CODE_LINE_HEIGHT + context;
}

/**
 * Manual reviewer scrolling uses wheel and touch. The `scroll` event does not work here, since
 * adjustment also emits it. Cancelling adjustment on its own scrolling would prevent it from starting.
 */
export function watchUserScroll(element: HTMLElement, onInput: () => void): () => void {
    const handle = (): void => {
        onInput();
    };
    element.addEventListener('wheel', handle, { passive: true });
    element.addEventListener('touchmove', handle, { passive: true });
    return () => {
        element.removeEventListener('wheel', handle);
        element.removeEventListener('touchmove', handle);
    };
}
