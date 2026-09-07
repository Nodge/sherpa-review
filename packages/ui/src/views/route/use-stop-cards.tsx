import type { AgentNote, FileDiff, PrMeta, Thread } from '@sherpa/protocol';
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { useCallback, useMemo, useState } from 'react';

import type { ContextExpandRequest, ContextExpandResult } from '../../diff-view/context-expansion.js';
import type { Feedback, FileCardActions } from '../../diff-view/file-card.tsx';
import type { DiffViewSnapshot, DiffViewStore } from '../../diff-view/store.js';
import { fileCollapseReason } from '../../diff-view/store.js';
import type { CardNoteActions } from '../../notes/card-notes.tsx';
import { readStateOf } from '../../progress/read-state.js';
import type { RouteFileGroup } from '../../route/route-model.js';
import { composersForGroup, notesForGroup, threadsForGroup } from '../../route/route-model.js';
import type { RoutePreset, SessionStore, ThreadsShow } from '../../session/session-store.js';
import { threadIsVisible } from '../../threads/model.js';
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
    readonly threadsShow: ThreadsShow;
    readonly preset: RoutePreset;
    readonly noteActions: CardNoteActions;
    readonly notesByFile: ReadonlyMap<string, readonly AgentNote[]>;
    readonly parseErrors: ReadonlyMap<string, string>;
    /** Collapsed cards expanded by hand: keyed by stop and file together. */
    readonly openedCollapsed: ReadonlySet<string>;
    readonly setOpenedCollapsed: Dispatch<SetStateAction<ReadonlySet<string>>>;
    readonly containerRef: RefObject<HTMLElement | null>;
    /** The card where the reviewer started selecting: its displayed model determines the selection. */
    readonly selectionCard: { readonly stopId: string; readonly group: RouteFileGroup } | null;
    readonly setSelectionCard: Dispatch<
        SetStateAction<{ readonly stopId: string; readonly group: RouteFileGroup } | null>
    >;
    readonly expand: (fileId: string, request: ContextExpandRequest) => Promise<ContextExpandResult>;
    readonly retryParse: (fileIds: readonly string[]) => void;
    readonly markViewed: (fileId: string, viewed: boolean) => Promise<Feedback>;
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
    readonly threadVisible: (thread: Thread) => boolean;
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
    threadsShow,
    preset,
    noteActions,
    notesByFile,
    parseErrors,
    openedCollapsed,
    setOpenedCollapsed,
    containerRef,
    selectionCard,
    setSelectionCard,
    expand,
    retryParse,
    markViewed,
    requestJump,
}: StopCardsOptions): StopCards {
    const threadVisible = useCallback((thread: Thread) => threadIsVisible(thread, threadsShow), [threadsShow]);
    // The rendered diff's iteration: in an old iteration, a thread sits by its lines only at its pinned commit.
    const iterationLayout = threadSnapshot.iterationLayout;
    const visibleThreads = useCallback(
        (group: RouteFileGroup): readonly Thread[] =>
            threadsForGroup(group, threadSnapshot.byFile, iterationLayout).filter(
                (thread) =>
                    (threadSnapshot.keptByFile.get(group.fileId)?.has(thread.id) ?? false) || threadVisible(thread),
            ),
        [iterationLayout, threadSnapshot.byFile, threadSnapshot.keptByFile, threadVisible],
    );
    const visibleByFile = useMemo(() => {
        const map = new Map<string, readonly Thread[]>();
        for (const [fileId, threads] of threadSnapshot.byFile) {
            map.set(
                fileId,
                threads.filter(
                    (thread) => (threadSnapshot.keptByFile.get(fileId)?.has(thread.id) ?? false) || threadVisible(thread),
                ),
            );
        }
        return map;
    }, [threadSnapshot.byFile, threadSnapshot.keptByFile, threadVisible]);

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
     * Mark a file within a stop. After the file the reviewer is reading collapses,
     * the view moves to the next card in the same stop. The same "scrolling follows
     * collapse" rule applies to stops (decision log 2026-09-02). The last file in a stop
     * does not request scrolling: the covered stop marks itself and moves to the next one.
     */
    const markFileViewed = useCallback(
        (fileId: string, viewed: boolean): Promise<Feedback> => {
            const container = containerRef.current;
            // Capture the geometry before writing: the mark collapses the card in the same frame.
            const top = viewed && container !== null ? topFileCard(container) : null;
            const stopId = top?.fileId === fileId ? top.stopId : null;
            const advance =
                container === null || stopId === null ? null : nextCardInStop(container, stopId, fileId);
            const written = markViewed(fileId, viewed);
            if (stopId !== null && advance !== null) {
                requestJump(stopId, advance, null, null, false);
            }
            return written;
        },
        [containerRef, markViewed, requestJump],
    );

    const actions = useMemo<FileCardActions>(
        () => ({
            onViewed: markFileViewed,
            onExpand: expand,
            onRetryParse: (fileId: string) => {
                retryParse([fileId]);
            },
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
            onCommentLine: commentLine,
            onCommentFile: commentFile,
            onLineFocus: (fileId, side, line) => {
                setFocusedLine({ fileId, side, line });
            },
            onLineBlur: () => {
                setFocusedLine(null);
            },
        }),
        [commentFile, commentLine, expand, markFileViewed, retryParse, store],
    );

    const cardFor = useCallback(
        (stopId: string, group: RouteFileGroup) => {
            const key = collapsedKey(stopId, group.fileId);
            const collapseReason = fileCollapseReason(diffSnapshot, group.file);
            const shownModel = stopFileShownModel(
                group,
                diffSnapshot.models.get(group.fileId) ?? null,
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
                onSelectStart: (fileId, lineKey, side, extend) => {
                    setSelectionCard({ stopId, group });
                    actions.onSelectStart(fileId, lineKey, side, extend);
                },
            };
            return (
                <StopFileCard
                    key={group.fileId}
                    group={group}
                    model={diffSnapshot.models.get(group.fileId) ?? null}
                    parseError={parseErrors.get(group.fileId) ?? null}
                    mode={diffSnapshot.effectiveMode}
                    content={diffSnapshot.content.get(group.fileId)}
                    contentAvailable={capabilities.fileContent}
                    expansion={diffSnapshot.expansion.get(group.fileId) ?? EMPTY_EXPANSION}
                    shownModel={shownModel}
                    read={
                        diffSnapshot.readState.get(group.fileId) ??
                        readStateOf({ file: group.file, record: null })
                    }
                    collapseReason={collapseReason}
                    onToggleCollapse={() => {
                        actions.onLineBlur?.();
                        store.toggleFileCollapse(group.fileId);
                    }}
                    showWhitespace={diffSnapshot.whitespaceShown.has(group.fileId)}
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
            noteActions,
            notesByFile,
            openedCollapsed,
            parseErrors,
            session,
            setOpenedCollapsed,
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
            const threads =
                (threadsShow.people ? 'p' : '') +
                (threadsShow.bots ? 'b' : '') +
                (threadsShow.resolved ? 'r' : '');
            const parts: string[] = [diffSnapshot.effectiveMode, preset, threads];
            for (const group of files) {
                const model = diffSnapshot.models.get(group.fileId) ?? null;
                if (model === null) {
                    return null;
                }
                const state =
                    (diffSnapshot.whitespaceShown.has(group.fileId) ? 'w' : '') +
                    (diffSnapshot.collapseExpanded.has(group.fileId) ? 'e' : '') +
                    (diffSnapshot.collapseExpandedViewed.has(group.fileId) ? 'v' : '') +
                    (diffSnapshot.collapseCollapsed.has(group.fileId) ? 'c' : '') +
                    (diffSnapshot.opened.has(group.fileId) ? 'o' : '') +
                    (openedCollapsed.has(collapsedKey(stopId, group.fileId)) ? 'k' : '');
                parts.push(
                    group.fileId,
                    // Use patch size instead of the model itself: reparsing the same file yields
                    // the same lines, so there is no reason to reset the measured height.
                    `${String(model.additions)}+${String(model.deletions)}${state}`,
                    expansionKey(diffSnapshot.expansion.get(group.fileId)),
                );
            }
            return parts.join('|');
        },
        [
            diffSnapshot.collapseCollapsed,
            diffSnapshot.collapseExpanded,
            diffSnapshot.collapseExpandedViewed,
            diffSnapshot.effectiveMode,
            diffSnapshot.expansion,
            diffSnapshot.models,
            diffSnapshot.opened,
            diffSnapshot.whitespaceShown,
            openedCollapsed,
            preset,
            threadsShow,
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
        threadVisible,
        visibleByFile,
        iterationLayout,
    };
}
