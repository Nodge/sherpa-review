import type { FileContent, FileDiff, Thread } from '@sherpa/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ReactNode, Ref } from 'react';
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { DiffFileModel } from '../diff/model.js';
import { updateFragment } from '../fragment.js';
import type { FileReadState } from '../progress/read-state.js';
import { readStateOf as computeReadState } from '../progress/read-state.js';
import { placeThreadsOnVisibleLines } from '../threads/model.js';
import type { ThreadActions } from '../threads/thread-list.tsx';
import { NewCommentComposer, ThreadList } from '../threads/thread-list.tsx';
import { createThreadStore } from '../threads/store.js';
import type { ComposerSnapshot, ThreadStore } from '../threads/store.js';
import type { ExpandAmount } from './expand.js';
import { expandFileContext } from './expand.js';
import type { Feedback, FileCardActions } from './file-card.tsx';
import type { LineSelection } from './selection.js';
import { COLLAPSE_THRESHOLD, FileCard } from './file-card.tsx';
import type { DiffViewStore } from './store.js';

/**
 * Virtualized list of diff cards (SPEC §8 item 8: 60+ files at 60fps). The DOM contains
 * only visible cards plus overscan, so worker parsing is lazy too: a file
 * is parsed exactly when it scrolls into view.
 *
 * Card heights are measured (`measureElement`). Line counts can only estimate them,
 * and folds, notices and expanded context invalidate that estimate.
 */

/** Code row and card header heights from README §1 estimate height before measurement. */
const CODE_LINE_HEIGHT = 20;
const CARD_CHROME_HEIGHT = 74;

/** Cards to keep beyond the viewport. Fewer expose loading, more cost more. */
const OVERSCAN = 3;

/** Frames to adjust scrolling to a linked file, giving the cards time to measure. */
const SCROLL_TO_FILE_FRAMES = 12;

/** Imperative list control. The file tree requests scrolling to its row. */
export interface DiffListHandle {
    readonly scrollToFile: (fileId: string) => void;
}

export interface DiffFileListProps {
    readonly files: readonly FileDiff[];
    readonly store: DiffViewStore;
    /** The host can supply file contents (`capabilities.fileContent`). */
    readonly contentAvailable: boolean;
    /** Patch parsing uses a worker for live data and a synchronous parser in the gallery. */
    readonly parse: (file: FileDiff) => Promise<DiffFileModel>;
    readonly loadContent: (fileId: string) => Promise<FileContent | null>;
    readonly onOpenInEditor: (path: string) => Promise<Feedback>;
    /** Viewed mark. The view owns the optimistic write, the list only calls it. */
    readonly onViewed: (fileId: string, viewed: boolean) => Promise<Feedback>;
    readonly threadStore?: ThreadStore | undefined;
    readonly threadActions?: ThreadActions | undefined;
    readonly threadVisible?: ((thread: Thread) => boolean) | undefined;
    readonly onCommentLine?: ((fileId: string, side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineFocus?: ((fileId: string, side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineBlur?: (() => void) | undefined;
    readonly onFocusThread?: ((threadId: string | null) => void) | undefined;
    readonly threadNow?: number | undefined;
    readonly outsideThreads?: ReactNode;
    /** File from the URL fragment (`file=`), scrolled to on open. */
    readonly initialFileId?: string | null;
    /**
     * File kept on screen despite the filter (SPEC §2.7): the card gets an
     * "outside current filter" notice. The view decides which file to keep.
     */
    readonly keptFileId?: string | null;
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
    files,
    store,
    contentAvailable,
    parse,
    loadContent,
    onOpenInEditor,
    onViewed,
    threadStore = EMPTY_THREAD_STORE,
    threadActions = EMPTY_THREAD_ACTIONS,
    threadVisible = HIDE_THREAD,
    onCommentLine = NOOP_LINE,
    onLineFocus = NOOP_LINE,
    onLineBlur = NOOP,
    onFocusThread = NOOP_THREAD,
    threadNow: providedThreadNow,
    outsideThreads = null,
    initialFileId = null,
    keptFileId = null,
    onTopFileChange,
    onScroll,
    ref,
}: DiffFileListProps) {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const threadSnapshot = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot);
    const composersSnapshot = useSyncExternalStore(threadStore.subscribeComposers, threadStore.getComposersSnapshot);
    const threadNowRef = useRef(providedThreadNow ?? Date.now());
    const threadNow = providedThreadNow ?? threadNowRef.current;
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const requested = useRef(new Set<string>());
    // Files whose parsing failed. Only an explicit reviewer retry will parse them again.
    const [parseErrors, setParseErrors] = useState<ReadonlyMap<string, string>>(new Map());

    const virtualizer = useVirtualizer({
        count: files.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: (index) => estimateHeight(files[index]),
        overscan: OVERSCAN,
        getItemKey: (index) => files[index]?.fileId ?? index,
    });

    const items = virtualizer.getVirtualItems();

    // Parse visible files. The worker replies asynchronously, and each file is requested only once.
    useEffect(() => {
        for (const item of items) {
            const file = files[item.index];
            if (file === undefined || requested.current.has(file.fileId)) {
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
    }, [items, files, parse, store, parseErrors]);

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
        const element = scrollRef.current;
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

    // Esc and clicks outside the rows clear the selection (SPEC §2.14).
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                store.clearSelection();
            }
        };
        const onPointerDown = (event: MouseEvent): void => {
            const target = event.target as HTMLElement | null;
            if (target?.closest('.diff-rows') === null) {
                store.clearSelection();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('mousedown', onPointerDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('mousedown', onPointerDown);
        };
    }, [store]);

    // While the list adjusts scrolling itself (a `#file=` link, tree navigation, repositioning after
    // a filter change), no scroll event is reported upward. These are not reviewer gestures and
    // must not clear the "kept on screen" notice (SPEC §2.7).
    const settling = useRef(0);
    const converge = useCallback(
        (index: number) => {
            settling.current += 1;
            return convergeScroll(
                () => {
                    virtualizer.scrollToIndex(index, { align: 'start' });
                },
                () => scrollRef.current?.scrollTop ?? 0,
                () => {
                    // One frame later. The browser dispatches scroll events after the final step.
                    requestAnimationFrame(() => {
                        settling.current -= 1;
                    });
                },
            );
        },
        [virtualizer],
    );

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

        const run = converge(index);
        return () => {
            // Adjustment was interrupted before completion (StrictMode unmounts effects twice), so
            // scrolling did not finish and the next pass must repeat it.
            if (!run.cancel() && scrolled.current === target) {
                scrolled.current = null;
            }
        };
    }, [files, initialFileId, converge]);

    // Scroll to the file requested by the tree. Cancel the previous adjustment, because two overlapping
    // loops would pull the list in different directions.
    const pending = useRef<ConvergingScroll | null>(null);
    useImperativeHandle(
        ref,
        () => ({
            scrollToFile: (fileId: string) => {
                const index = files.findIndex((file) => file.fileId === fileId);
                if (index < 0) {
                    return;
                }
                pending.current?.cancel();
                pending.current = converge(index);
            },
        }),
        [files, converge],
    );

    // Tree scroll-spy uses the top card in the viewport. The virtualizer rerenders the list
    // on every scroll frame, so no separate listener is needed.
    const topFileId = topFile(files, items, virtualizer.scrollOffset ?? 0);
    const reportedTop = useRef<string | null>(null);
    useEffect(() => {
        if (onTopFileChange !== undefined && topFileId !== reportedTop.current) {
            reportedTop.current = topFileId;
            onTopFileChange(topFileId);
        }
    }, [topFileId, onTopFileChange]);

    const expand = useCallback(
        async (fileId: string, amount?: ExpandAmount): Promise<Feedback> => {
            if (!contentAvailable) {
                return null;
            }
            if (store.getSnapshot().content.has(fileId)) {
                store.expand(fileId, amount);
                return null;
            }

            let content: FileContent | null;
            try {
                content = await loadContent(fileId);
            } catch (error: unknown) {
                // A failed request does not mean "no content". Caching it as null would
                // disable the button permanently for the wrong reason. Leave the cache untouched and retry.
                const reason = (error instanceof Error ? error.message : String(error)).replace(/\s*\.\s*$/, '');
                return `Could not fetch the file contents: ${reason}. Try again.`;
            }

            store.setContent(fileId, content);
            if (content !== null) {
                store.expand(fileId, amount);
            }
            return null;
        },
        [contentAvailable, loadContent, store],
    );

    const actions = useMemo<FileCardActions>(
        () => ({
            onViewed,
            onExpand: expand,
            onRetryParse: retryParse,
            onOpenFile: store.openFile,
            onShowWhitespace: store.showWhitespace,
            onSelectStart: (fileId, key, extend) => {
                if (extend) {
                    store.extendSelection(fileId, key);
                } else {
                    store.startSelection(fileId, key);
                }
            },
            onSelectExtend: store.extendSelection,
            onOpenInEditor,
            onCopyLink: copyFileLink,
            onCommentLine,
            onLineFocus,
            onLineBlur,
        }),
        [expand, onCommentLine, onLineBlur, onLineFocus, onOpenInEditor, onViewed, retryParse, store],
    );

    return (
        <div className="diff-list" ref={scrollRef} onScroll={handleScroll}>
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
                            start={item.start}
                            measure={virtualizer.measureElement}
                            model={snapshot.models.get(file.fileId) ?? null}
                            parseError={parseErrors.get(file.fileId) ?? null}
                            mode={snapshot.effectiveMode}
                            content={snapshot.content.get(file.fileId)}
                            contentAvailable={contentAvailable}
                            expansion={snapshot.expansion.get(file.fileId) ?? 0}
                            read={readStateOf(snapshot, file)}
                            opened={snapshot.opened.has(file.fileId)}
                            showWhitespace={snapshot.whitespaceShown.has(file.fileId)}
                            keptInView={file.fileId === keptFileId}
                            selection={snapshot.selection?.fileId === file.fileId ? snapshot.selection : null}
                            threads={threadSnapshot.byFile.get(file.fileId) ?? EMPTY_THREADS}
                            keptThreadIds={threadSnapshot.keptByFile.get(file.fileId) ?? EMPTY_THREAD_IDS}
                            composers={composersSnapshot.byFile.get(file.fileId) ?? EMPTY_COMPOSERS}
                            threadVisible={threadVisible}
                            threadStore={threadStore}
                            threadActions={threadActions}
                            threadNow={threadNow}
                            onFocusThread={onFocusThread}
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
const EMPTY_THREAD_IDS: ReadonlySet<string> = new Set();
const EMPTY_COMPOSERS: readonly ComposerSnapshot[] = [];

const VirtualFileCard = memo(function VirtualFileCard({
    file,
    index,
    start,
    measure,
    model,
    parseError,
    mode,
    content,
    contentAvailable,
    expansion,
    read,
    opened,
    showWhitespace,
    keptInView,
    selection,
    threads,
    keptThreadIds,
    composers,
    threadVisible,
    threadStore,
    threadActions,
    threadNow,
    onFocusThread,
    actions,
}: {
    file: FileDiff;
    index: number;
    start: number;
    measure: (element: HTMLDivElement | null) => void;
    model: DiffFileModel | null;
    parseError: string | null;
    mode: 'unified' | 'split';
    content: FileContent | null | undefined;
    contentAvailable: boolean;
    expansion: ExpandAmount;
    read: FileReadState;
    opened: boolean;
    showWhitespace: boolean;
    keptInView: boolean;
    selection: LineSelection | null;
    threads: readonly Thread[];
    keptThreadIds: ReadonlySet<string>;
    composers: readonly ComposerSnapshot[];
    threadVisible: (thread: Thread) => boolean;
    threadStore: ThreadStore;
    threadActions: ThreadActions;
    threadNow: number;
    onFocusThread: (threadId: string | null) => void;
    actions: FileCardActions;
}) {
    const shownModel = useMemo(
        () => (model === null ? null : expandFileContext(model, content ?? null, expansion)),
        [content, expansion, model],
    );
    const visibleThreads = useMemo(
        () => threads.filter((thread) => keptThreadIds.has(thread.id) || threadVisible(thread)),
        [keptThreadIds, threadVisible, threads],
    );
    const changed = (model?.additions ?? file.additions) + (model?.deletions ?? file.deletions);
    const canRenderRows =
        parseError === null &&
        shownModel?.content.kind === 'text' &&
        (!shownModel.whitespaceOnly || showWhitespace) &&
        (opened || changed <= COLLAPSE_THRESHOLD);
    const layout = useMemo(() => {
        const underHeader = visibleThreads.filter(
            (thread) => thread.outdated || thread.anchor?.position === null,
        );
        const positional = visibleThreads.filter(
            (thread) => !thread.outdated && thread.anchor?.position !== null,
        );
        const placed = canRenderRows
            ? placeThreadsOnVisibleLines(shownModel, positional)
            : { byLine: new Map<string, readonly Thread[]>(), unplaced: positional };
        return { byLine: placed.byLine, underHeader: [...underHeader, ...placed.unplaced] };
    }, [canRenderRows, shownModel, visibleThreads]);

    const composerLayout = useMemo(() => {
        const byLine: ComposerSnapshot[] = [];
        const underHeader: ComposerSnapshot[] = [];
        for (const composer of composers) {
            const position = composer.anchor?.position;
            if (canRenderRows && position !== null && position !== undefined && modelHasPosition(shownModel, position.side, position.line)) {
                byLine.push(composer);
            } else {
                underHeader.push(composer);
            }
        }
        return { byLine, underHeader };
    }, [canRenderRows, composers, shownModel]);
    const threadsUnderHeader = useMemo(
        () =>
            layout.underHeader.length === 0 && composerLayout.underHeader.length === 0 ? null : (
                <>
                    {layout.underHeader.length === 0 ? null : (
                        <ThreadList
                            threads={layout.underHeader}
                            store={threadStore}
                            actions={threadActions}
                            now={threadNow}
                            onFocusThread={onFocusThread}
                        />
                    )}
                    {composerLayout.underHeader.map((composer) => (
                        <div key={composer.key} className="diff-row-extra thread-fade">
                            <NewCommentComposer
                                composerKey={composer.key}
                                store={threadStore}
                                transport={threadActions.transport}
                            />
                        </div>
                    ))}
                </>
            ),
        [composerLayout.underHeader, layout.underHeader, onFocusThread, threadActions, threadNow, threadStore],
    );
    const renderAfterLine = useCallback(
        (side: 'old' | 'new', line: number): ReactNode => {
            const lineThreads = layout.byLine.get(`${side}:${String(line)}`) ?? EMPTY_THREADS;
            const composer = composerLayout.byLine.find(
                (candidate) =>
                    candidate.anchor?.position?.side === side && candidate.anchor.position.line === line,
            );
            if (lineThreads.length === 0 && composer === undefined) {
                return null;
            }
            return (
                <div className="diff-row-extra thread-fade">
                    {lineThreads.length === 0 ? null : (
                        <ThreadList
                            threads={lineThreads}
                            store={threadStore}
                            actions={threadActions}
                            now={threadNow}
                            onFocusThread={onFocusThread}
                        />
                    )}
                    {composer === undefined ? null : (
                        <NewCommentComposer
                            composerKey={composer.key}
                            store={threadStore}
                            transport={threadActions.transport}
                        />
                    )}
                </div>
            );
        },
        [composerLayout.byLine, layout.byLine, onFocusThread, threadActions, threadNow, threadStore],
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
                expansion={expansion}
                read={read}
                opened={opened}
                showWhitespace={showWhitespace}
                keptInView={keptInView}
                selection={selection}
                threadsUnderHeader={threadsUnderHeader}
                renderAfterLine={renderAfterLine}
                actions={actions}
            />
        </div>
    );
});

function modelHasPosition(model: DiffFileModel | null, side: 'old' | 'new', line: number): boolean {
    if (model?.content.kind !== 'text') {
        return false;
    }
    return model.content.blocks.some(
        (block) =>
            block.kind === 'hunk' &&
            block.lines.some((candidate) => (side === 'old' ? candidate.oldLine : candidate.newLine) === line),
    );
}

interface ConvergingScroll {
    /** `true` once adjustment has finished on its own. */
    readonly cancel: () => boolean;
}

/**
 * Adjust virtualizer scrolling. Heights are estimates until cards are first measured, so
 * the target moves and a single call is not enough. Repeat until the position stops changing.
 * `onDone` runs exactly once, on both natural completion and cancellation.
 */
function convergeScroll(step: () => void, currentTop: () => number, onDone: () => void): ConvergingScroll {
    let attempts = 0;
    let previousTop = -1;
    let done = false;
    const finish = (): void => {
        if (!done) {
            done = true;
            onDone();
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
        finish();
    });

    return {
        cancel: () => {
            cancelAnimationFrame(frame);
            const completed = attempts >= SCROLL_TO_FILE_FRAMES;
            finish();
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
        save: () => Promise.reject(new Error('drafts are unavailable')),
        update: () => Promise.reject(new Error('drafts are unavailable')),
        delete: () => Promise.reject(new Error('drafts are unavailable')),
    },
    resolve: () => Promise.reject(new Error('resolve is unavailable')),
};
const HIDE_THREAD = (): boolean => false;
const NOOP = (): void => undefined;
const NOOP_LINE = (): void => undefined;
const NOOP_THREAD = (): void => undefined;

function estimateHeight(file: FileDiff | undefined): number {
    if (file === undefined) {
        return CARD_CHROME_HEIGHT;
    }
    // A file above the threshold starts collapsed (SPEC §2.13), with one button row instead of thousands
    // of code lines. Capping the line count at the threshold would overestimate height hundreds of times and break the scrollbar.
    const changed = file.additions + file.deletions;
    const lines = changed > COLLAPSE_THRESHOLD ? 1 : changed;
    return CARD_CHROME_HEIGHT + lines * CODE_LINE_HEIGHT;
}

/** A file link is the current address plus the `file` fragment parameter. */
async function copyFileLink(fileId: string): Promise<Feedback> {
    const url = new URL(window.location.href);
    url.hash = updateFragment(window.location.hash, { file: fileId, thread: null });

    try {
        await navigator.clipboard.writeText(url.toString());
    } catch {
        return 'The browser could not copy the link. Copy the page address manually.';
    }
    return 'File link copied.';
}
