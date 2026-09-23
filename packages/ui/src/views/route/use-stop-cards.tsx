import type { AgentNote, FileDiff, PrMeta, Thread, UiSeenRange } from '@sherpa/protocol';
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { useCallback, useMemo, useState } from 'react';

import type { ContextExpandRequest, ContextExpandResult } from '../../diff-view/context-expansion.js';
import type { Feedback, FileCardActions } from '../../diff-view/file-card.tsx';
import type { DiffViewSnapshot, DiffViewStore } from '../../diff-view/store.js';
import { collapseReasonOf, viewedCollapsible } from '../../diff-view/store.js';
import type { CardNoteActions } from '../../notes/card-notes.tsx';
import type { FileReadState } from '../../progress/read-state.js';
import { readStateOf } from '../../progress/read-state.js';
import type { RouteFileGroup } from '../../route/route-model.js';
import { composersForGroup, notesForGroup, threadsForGroup } from '../../route/route-model.js';
import type { CardViewedMark } from '../../route/stop-coverage.js';
import { cardViewedMark, groupReadState } from '../../route/stop-coverage.js';
import type { RoutePreset, SessionStore } from '../../session/session-store.js';
import type { ComposerLayoutSnapshot, ThreadStore, ThreadStoreSnapshot } from '../../threads/store.js';
import { openFileComposer, openNewComposer } from '../../threads/thread-list.tsx';
import type { ThreadActions } from '../../threads/thread-list.tsx';
import { commentPosition } from '../full-diff.tsx';
import { nextCardInStop, topFileCard } from './stop-dom.js';
import { StopFileCard, stopFileShownModel } from './stop-file-card.tsx';
import { collapsedKey, EMPTY_EXPANSION, expansionKey } from './stop-lookup.js';
import type { RequestJump } from './use-route-jump.js';

export interface StopCardsOptions {
    readonly files: readonly FileDiff[];
    readonly capabilities: PrMeta['capabilities'];
    readonly session: SessionStore;
    readonly store: DiffViewStore;
    readonly threadStore: ThreadStore;
    readonly threadActions: ThreadActions;
    /** Fixed thread clock: the same throughout the view. */
    readonly threadNow: number;
    readonly diffSnapshot: DiffViewSnapshot;
    readonly threadSnapshot: ThreadStoreSnapshot;
    readonly composersSnapshot: ComposerLayoutSnapshot;
    readonly preset: RoutePreset;
    readonly noteActions: CardNoteActions;
    readonly notesByFile: ReadonlyMap<string, readonly AgentNote[]>;
    readonly parseErrors: ReadonlyMap<string, string>;
    /** Collapsed cards expanded by hand: keyed by stop and file together. */
    readonly openedCollapsed: ReadonlySet<string>;
    readonly setOpenedCollapsed: Dispatch<SetStateAction<ReadonlySet<string>>>;
    /** Temporarily expanded viewed cards: keyed by stop and file together. */
    readonly openedViewed: ReadonlySet<string>;
    readonly setOpenedViewed: Dispatch<SetStateAction<ReadonlySet<string>>>;
    readonly containerRef: RefObject<HTMLElement | null>;
    /** The card where the reviewer started selecting: its displayed model determines the selection. */
    readonly selectionCard: { readonly stopId: string; readonly group: RouteFileGroup } | null;
    readonly setSelectionCard: Dispatch<
        SetStateAction<{ readonly stopId: string; readonly group: RouteFileGroup } | null>
    >;
    readonly expand: (fileId: string, request: ContextExpandRequest) => Promise<ContextExpandResult>;
    readonly retryParse: (fileIds: readonly string[]) => void;
    readonly markViewed: (fileId: string, viewed: boolean) => Promise<Feedback>;
    readonly markStopFile: (
        stopId: string,
        fileId: string,
        viewed: boolean,
        ranges: readonly UiSeenRange[],
    ) => Promise<Feedback>;
    readonly requestJump: RequestJump;
}

export interface StopCards {
    /** A file card inside a stop: the same file at different stops has separate cards. */
    readonly cardFor: (stopId: string, group: RouteFileGroup) => ReactNode;
    readonly busyFileIds: ReadonlySet<string>;
    readonly stopLayoutKey: (stopId: string, files: readonly RouteFileGroup[]) => string | null;
    readonly commentLine: (fileId: string, side: 'old' | 'new', line: number) => void;
    readonly focusedLine: { readonly fileId: string; readonly side: 'old' | 'new'; readonly line: number } | null;
    readonly focusedThreadId: string | null;
    readonly selectedShownModel: ReturnType<typeof stopFileShownModel>;
    /** Threads by file as the card renders them: the route does not apply an author lens. */
    readonly visibleByFile: ReadonlyMap<string, readonly Thread[]>;
    readonly iterationLayout: ThreadStoreSnapshot['iterationLayout'];
}

/**
 * Route file cards: what they render, what controls them and what keeps a
 * stop in the DOM. Line and thread focus live here too, since both cards and shortcuts depend on them.
 */
export function useStopCards({
    files,
    capabilities,
    session,
    store,
    threadStore,
    threadActions,
    threadNow,
    diffSnapshot,
    threadSnapshot,
    composersSnapshot,
    preset,
    noteActions,
    notesByFile,
    parseErrors,
    openedCollapsed,
    setOpenedCollapsed,
    openedViewed,
    setOpenedViewed,
    containerRef,
    selectionCard,
    setSelectionCard,
    expand,
    retryParse,
    markViewed,
    markStopFile,
    requestJump,
}: StopCardsOptions): StopCards {
    // The rendered diff's iteration: in an old iteration, a thread sits by its lines only at its pinned commit.
    const iterationLayout = threadSnapshot.iterationLayout;
    // The source filter is gone (SPEC-changes-2026-09-20 §3), and the route does not apply an author
    // lens: the card shows all threads for its lines. Collapsing them into a marker reduces noise.
    const visibleThreads = useCallback(
        (group: RouteFileGroup): readonly Thread[] =>
            threadsForGroup(group, threadSnapshot.byFile, iterationLayout),
        [iterationLayout, threadSnapshot.byFile],
    );
    const visibleByFile = threadSnapshot.byFile;

    const [focusedLine, setFocusedLine] = useState<{ fileId: string; side: 'old' | 'new'; line: number } | null>(null);
    const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
    const selectedShownModel = useMemo(() => {
        if (selectionCard === null || diffSnapshot.selection?.fileId !== selectionCard.group.fileId) {
            return null;
        }
        const key = collapsedKey(selectionCard.stopId, selectionCard.group.fileId);
        return stopFileShownModel(
            selectionCard.group,
            diffSnapshot.models.get(selectionCard.group.fileId) ?? null,
            diffSnapshot.content.get(selectionCard.group.fileId) ?? null,
            diffSnapshot.expansion.get(selectionCard.group.fileId) ?? EMPTY_EXPANSION,
            openedCollapsed.has(key),
        );
    }, [diffSnapshot, openedCollapsed, selectionCard]);
    const commentLine = useCallback(
        (fileId: string, side: 'old' | 'new', line: number) => {
            const file = files.find((candidate) => candidate.fileId === fileId);
            if (file === undefined) {
                return;
            }
            const position = commentPosition(
                diffSnapshot.selection,
                selectedShownModel ?? diffSnapshot.models.get(fileId) ?? null,
                fileId,
                side,
                line,
            );
            const key = `new:${fileId}:${position.side}:${String(position.line)}`;
            openNewComposer(threadStore, key, { fileId, path: file.path, position }, capabilities.commentIssues);
            // The range moved into the composer, so the live selection is no longer needed. Leaving it
            // would keep the line pencil visible and mix it into the next comment.
            store.clearSelection();
        },
        [
            capabilities.commentIssues,
            diffSnapshot.models,
            diffSnapshot.selection,
            files,
            selectedShownModel,
            store,
            threadStore,
        ],
    );
    const commentFile = useCallback(
        (fileId: string) => {
            const file = files.find((candidate) => candidate.fileId === fileId);
            if (file !== undefined) {
                openFileComposer(threadStore, fileId, file.path, capabilities.commentIssues);
            }
        },
        [capabilities.commentIssues, files, threadStore],
    );

    /**
     * Marking a file inside a stop (docs/design/SPEC-elements.md §2.10) writes only the card's
     * lines without pinning the file (except for a non-text file, `cardViewedMark`). A file pin
     * (manual, from the host, generated) keeps `read` in all cards, so it can only be cleared
     * for the whole file, through the file mark.
     *
     * Collapsing the card the reviewer is currently reading scrolls to the next card
     * in the same stop, the same "scroll follows collapse" behaviour as stops. The last
     * card does not request scrolling: the covered stop marks itself and moves to the next stop.
     */
    const markCardViewed = useCallback(
        (
            stopId: string,
            group: RouteFileGroup,
            fileRead: FileReadState,
            mark: CardViewedMark,
            viewed: boolean,
        ): Promise<Feedback> => {
            const pin = mark === 'pin' || (!viewed && fileRead.state === 'read' && fileRead.pinned);
            if (!pin && mark !== 'ranges') {
                return Promise.resolve(null);
            }
            const container = containerRef.current;
            // Capture the geometry before writing: the mark collapses the card in the same frame.
            const top = viewed && container !== null ? topFileCard(container) : null;
            const advance =
                container !== null && top?.stopId === stopId && top.fileId === group.fileId
                    ? nextCardInStop(container, stopId, group.fileId)
                    : null;
            const key = collapsedKey(stopId, group.fileId);
            setOpenedViewed((previous) => {
                if (!previous.has(key)) {
                    return previous;
                }
                const next = new Set(previous);
                next.delete(key);
                return next;
            });
            const written = pin
                ? markViewed(group.fileId, viewed)
                : markStopFile(
                      stopId,
                      group.fileId,
                      viewed,
                      group.seenRanges.map(({ side, start, end }) => ({ side, start, end })),
                  );
            if (advance !== null) {
                requestJump(stopId, advance, null, null, false);
            }
            return written;
        },
        [containerRef, markStopFile, markViewed, requestJump, setOpenedViewed],
    );

    const actions = useMemo<FileCardActions>(
        () => ({
            // A stop's card substitutes its own mark (`cardFor`).
            onViewed: markViewed,
            onExpand: expand,
            onRetryParse: (fileId: string) => {
                retryParse([fileId]);
            },
            onOpenFile: store.openFile,
            onShowWhitespace: store.showWhitespace,
            onToggleMarkdown: store.toggleMarkdown,
            onSelectText: store.selectText,
            onClearSelection: store.clearSelection,
            onSelectStart: (fileId, key, side, extend) => {
                store.beginSelection();
                if (extend) {
                    store.extendSelection(fileId, key, side);
                } else {
                    store.startSelection(fileId, key, side);
                }
            },
            onSelectExtend: store.dragSelection,
            onCommentLine: commentLine,
            onCommentFile: commentFile,
            onLineFocus: (fileId, side, line) => {
                setFocusedLine({ fileId, side, line });
            },
            onLineBlur: () => {
                setFocusedLine(null);
            },
        }),
        [commentFile, commentLine, expand, markViewed, retryParse, store],
    );

    const cardFor = useCallback(
        (stopId: string, group: RouteFileGroup) => {
            const key = collapsedKey(stopId, group.fileId);
            const record = diffSnapshot.progress.get(group.fileId) ?? null;
            const fileRead = diffSnapshot.readState.get(group.fileId) ?? readStateOf({ file: group.file, record });
            // The card's toggle, checkbox and fold describe its lines, not the whole file.
            const read = groupReadState(group, fileRead, record);
            const collapseReason = collapseReasonOf(diffSnapshot, group.file, read, openedViewed.has(key));
            const model = diffSnapshot.models.get(group.fileId) ?? null;
            const parseError = parseErrors.get(group.fileId) ?? null;
            const mark = cardViewedMark(group, model, parseError !== null);
            const shownModel = stopFileShownModel(
                group,
                model,
                diffSnapshot.content.get(group.fileId) ?? null,
                diffSnapshot.expansion.get(group.fileId) ?? EMPTY_EXPANSION,
                openedCollapsed.has(key),
            );
            const cardActions: FileCardActions = {
                ...actions,
                // A composer without a line renders only where the entry explains the whole file
                // (`composersForGroup`). In other cards the menu item would open a draft
                // that is invisible everywhere, so hide it. A comment on such a file can be added
                // in Full diff.
                onCommentFile: group.whole ? actions.onCommentFile : undefined,
                onViewed: (_fileId, viewed) => markCardViewed(stopId, group, fileRead, mark, viewed),
                onSelectText: (selection) => {
                    setSelectionCard({ stopId, group });
                    store.selectText(selection);
                },
                onSelectStart: (fileId, lineKey, side, extend) => {
                    setSelectionCard({ stopId, group });
                    actions.onSelectStart(fileId, lineKey, side, extend);
                },
            };
            return (
                <StopFileCard
                    key={group.fileId}
                    group={group}
                    model={model}
                    parseError={parseError}
                    mode={diffSnapshot.effectiveMode}
                    content={diffSnapshot.content.get(group.fileId)}
                    contentAvailable={capabilities.fileContent}
                    expansion={diffSnapshot.expansion.get(group.fileId) ?? EMPTY_EXPANSION}
                    shownModel={shownModel}
                    read={read}
                    viewedBlocked={mark === 'pending' || mark === 'parseFailed' ? mark : null}
                    collapseReason={collapseReason}
                    onToggleCollapse={() => {
                        actions.onLineBlur?.();
                        // A viewed card expands and collapses independently.
                        // Manual and generated folds are shared across the file.
                        if (collapseReason === 'viewed' || (collapseReason === null && viewedCollapsible(read))) {
                            setOpenedViewed((previous) => {
                                const next = new Set(previous);
                                if (!next.delete(key)) {
                                    next.add(key);
                                }
                                return next;
                            });
                            return;
                        }
                        store.toggleFileCollapse(group.fileId);
                    }}
                    showWhitespace={diffSnapshot.whitespaceShown.has(group.fileId)}
                    markdown={diffSnapshot.markdownShown.has(group.fileId)}
                    selection={diffSnapshot.selection?.fileId === group.fileId ? diffSnapshot.selection : null}
                    session={session}
                    notes={notesForGroup(group, notesByFile)}
                    noteActions={noteActions}
                    threads={visibleThreads(group)}
                    composers={composersForGroup(group, composersSnapshot.byFile)}
                    threadStore={threadStore}
                    threadActions={threadActions}
                    threadNow={threadNow}
                    onFocusThread={setFocusedThreadId}
                    actions={cardActions}
                    collapsedOpen={openedCollapsed.has(key)}
                    onToggleCollapsed={() => {
                        setOpenedCollapsed((previous) => {
                            const next = new Set(previous);
                            if (next.has(key)) {
                                next.delete(key);
                            } else {
                                next.add(key);
                            }
                            return next;
                        });
                    }}
                />
            );
        },
        [
            actions,
            capabilities.fileContent,
            composersSnapshot.byFile,
            diffSnapshot,
            markCardViewed,
            noteActions,
            notesByFile,
            openedCollapsed,
            openedViewed,
            parseErrors,
            session,
            setOpenedCollapsed,
            setOpenedViewed,
            setSelectionCard,
            store,
            threadActions,
            threadNow,
            threadStore,
            visibleThreads,
        ],
    );

    /**
     * Files that keep a stop in the DOM: unmounting would lose the live
     * selection, the comment editor instance with its caret and undo history, and line focus.
     */
    const busyFileIds = useMemo(() => {
        const ids = new Set<string>(composersSnapshot.byFile.keys());
        // Replies and draft edits open without an anchor, so their file is found through the thread.
        if (composersSnapshot.openThreadIds.size > 0) {
            for (const [fileId, threads] of threadSnapshot.byFile) {
                if (threads.some((thread) => composersSnapshot.openThreadIds.has(thread.id))) {
                    ids.add(fileId);
                }
            }
        }
        if (diffSnapshot.selection !== null) {
            ids.add(diffSnapshot.selection.fileId);
        }
        if (focusedLine !== null) {
            ids.add(focusedLine.fileId);
        }
        return ids;
    }, [
        composersSnapshot.byFile,
        composersSnapshot.openThreadIds,
        diffSnapshot.selection,
        focusedLine,
        threadSnapshot.byFile,
    ]);

    /**
     * Layout marker for one stop's diff column: while the marker is unchanged, the measured
     * placeholder height remains valid. The marker uses the stop's own files. A global marker
     * would reset on every gap expansion and remount the whole route
     * just to remeasure it. Include the entire file list: a lens leaves only some of the stop's
     * cards, so the old height would be wrong by the difference.
     *
     * `null` means the layout has not settled: a file has no parsed model yet, and its place holds
     * a parsing skeleton, which cannot be used to measure the card's height.
     */
    const stopLayoutKey = useCallback(
        (stopId: string, files: readonly RouteFileGroup[]): string | null => {
            const parts: string[] = [diffSnapshot.effectiveMode, preset];
            for (const group of files) {
                const model = diffSnapshot.models.get(group.fileId) ?? null;
                if (model === null) {
                    return null;
                }
                // Expanded file threads enter the marker: collapsing them changes the card's height.
                const openThreads = visibleThreads(group)
                    .filter((thread) => threadSnapshot.openThreads.has(thread.id))
                    .map((thread) => thread.id)
                    .join(',');
                const state =
                    (diffSnapshot.whitespaceShown.has(group.fileId) ? 'w' : '') +
                    (diffSnapshot.markdownShown.has(group.fileId) ? 'm' : '') +
                    (diffSnapshot.collapseExpanded.has(group.fileId) ? 'e' : '') +
                    (openedViewed.has(collapsedKey(stopId, group.fileId)) ? 'v' : '') +
                    (diffSnapshot.collapseCollapsed.has(group.fileId) ? 'c' : '') +
                    (diffSnapshot.opened.has(group.fileId) ? 'o' : '') +
                    (openedCollapsed.has(collapsedKey(stopId, group.fileId)) ? 'k' : '');
                parts.push(
                    group.fileId,
                    // Use patch size instead of the model itself: reparsing the same file yields
                    // the same lines, so there is no reason to reset the measured height.
                    `${String(model.additions)}+${String(model.deletions)}${state}`,
                    openThreads,
                    expansionKey(diffSnapshot.expansion.get(group.fileId)),
                );
            }
            return parts.join('|');
        },
        [
            diffSnapshot.collapseCollapsed,
            diffSnapshot.collapseExpanded,
            diffSnapshot.effectiveMode,
            diffSnapshot.expansion,
            diffSnapshot.markdownShown,
            diffSnapshot.models,
            diffSnapshot.opened,
            diffSnapshot.whitespaceShown,
            openedCollapsed,
            openedViewed,
            preset,
            threadSnapshot.openThreads,
            visibleThreads,
        ],
    );

    return {
        cardFor,
        busyFileIds,
        stopLayoutKey,
        commentLine,
        focusedLine,
        focusedThreadId,
        selectedShownModel,
        visibleByFile,
        iterationLayout,
    };
}
