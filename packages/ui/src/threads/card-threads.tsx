import type { Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import type { DiffFileModel } from '../diff/model.js';
import type { LinePosition } from '../diff-view/diff-rows.tsx';
import type { ThreadsCollapse } from '../diff-view/file-card.tsx';
import type { LineRange } from '../diff-view/selection.js';
import type { ComposerLayout } from './composer-markdown.js';
import { placeThreadsOnVisibleLines, positionLastLine, threadAtLines } from './model.js';
import type { ComposerSnapshot, ThreadStore } from './store.js';
import type { ThreadActions } from './thread-list.tsx';
import { NewCommentComposer, ThreadList } from './thread-list.tsx';
import { ThreadMarker } from './thread-marker.tsx';

/**
 * Thread and composer placement in a file card: what goes below the header and what sits
 * below a specific line. Both views share the same logic. Full diff cards and route stop
 * cards must behave alike (principle 5 in `docs/product.md` §3: one reader, two orders).
 *
 * On the route, stop anchors trim the card model. A thread on a line absent from the
 * slice goes below the header, through the same path as a thread without a position.
 */

export interface CardThreadsInput {
    /** The model actually drawn in the card (after context expansion and trimming). */
    readonly model: DiffFileModel | null;
    /** Whether diff lines are rendered: a collapsed card does not place threads by line. */
    readonly rowsShown: boolean;
    readonly threads: readonly Thread[];
    readonly composers: readonly ComposerSnapshot[];
    readonly store: ThreadStore;
    readonly actions: ThreadActions;
    readonly now: number;
    readonly onFocusThread: (threadId: string | null) => void;
    /** Gallery only: the editor layout must be deterministic. */
    readonly initialLayout?: ComposerLayout;
    /**
     * Where to place a thread whose line is absent from the rendered model. `nearest` (full diff) puts
     * it at the nearest visible line. That model is complete, so the adjacent line is part of the same change.
     * `exact` (route) moves such a thread below the header. A stop card shows only its own
     * ranges, so the "nearest" line would belong to a different part of the file.
     */
    readonly placement?: 'nearest' | 'exact';
}

export interface CardThreads {
    readonly threadsUnderHeader: ReactNode;
    readonly renderAfterLine: (side: 'old' | 'new', line: number) => ReactNode;
    /** Marker at the card edge: drawn inside the row itself, with no dedicated column. */
    readonly renderLineMarker: (positions: readonly LinePosition[]) => ReactNode;
    readonly focusedThreadRange: LineRange | null;
    /** This file's inline threads, used to determine "collapse all". */
    readonly lineThreadIds: readonly string[];
}

export function useCardThreads({
    model,
    rowsShown,
    threads,
    composers,
    store,
    actions,
    now,
    onFocusThread,
    initialLayout,
    placement = 'nearest',
}: CardThreadsInput): CardThreads {
    const [focusedThreadRange, setFocusedThreadRange] = useState<LineRange | null>(null);
    // Iteration of the rendered diff: in an old iteration, only threads pinned to it sit by their lines.
    // An iteration's role changes on the fly (a push makes it previous), so read it from the store.
    // Thread expansion comes in the same snapshot. The marker and the block below the line must
    // switch in the same frame.
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const iteration = snapshot.iterationLayout;
    const openThreads = snapshot.openThreads;
    const focusThread = useCallback(
        (threadId: string | null): void => {
            const thread = threads.find((candidate) => candidate.id === threadId);
            setFocusedThreadRange(
                thread !== undefined && threadAtLines(thread, iteration) ? (thread.anchor?.position ?? null) : null,
            );
            onFocusThread(threadId);
        },
        [iteration, onFocusThread, threads],
    );
    const layout = useMemo(() => {
        const underHeader = threads.filter((thread) => !threadAtLines(thread, iteration));
        const positional = threads.filter((thread) => threadAtLines(thread, iteration));
        const onScreen =
            placement === 'exact'
                ? positional.filter((thread) => positionShown(model, rowsShown, thread.anchor?.position))
                : positional;
        const offScreen = placement === 'exact' ? positional.filter((thread) => !onScreen.includes(thread)) : [];
        const placed = rowsShown
            ? placeThreadsOnVisibleLines(model, onScreen)
            : { byLine: new Map<string, readonly Thread[]>(), unplaced: onScreen };
        return { byLine: placed.byLine, underHeader: [...underHeader, ...placed.unplaced, ...offScreen] };
    }, [iteration, model, placement, rowsShown, threads]);

    const composerLayout = useMemo(() => {
        const byLine: ComposerSnapshot[] = [];
        const underHeader: ComposerSnapshot[] = [];
        for (const composer of composers) {
            if (positionShown(model, rowsShown, composer.anchor?.position)) {
                byLine.push(composer);
            } else {
                underHeader.push(composer);
            }
        }
        return { byLine, underHeader };
    }, [composers, model, rowsShown]);

    const threadsUnderHeader = useMemo(
        () =>
            layout.underHeader.length === 0 && composerLayout.underHeader.length === 0 ? null : (
                <>
                    {layout.underHeader.length === 0 ? null : (
                        <ThreadList
                            threads={layout.underHeader}
                            store={store}
                            actions={actions}
                            now={now}
                            onFocusThread={focusThread}
                            {...(initialLayout === undefined ? {} : { initialLayout })}
                        />
                    )}
                    {composerLayout.underHeader.map((composer) => (
                        <div key={composer.key} className="diff-row-extra thread-fade">
                            <NewCommentComposer
                                composerKey={composer.key}
                                store={store}
                                transport={actions.transport}
                                {...(initialLayout === undefined ? {} : { initialLayout })}
                            />
                        </div>
                    ))}
                </>
            ),
        [
            actions,
            composerLayout.underHeader,
            initialLayout,
            layout.underHeader,
            now,
            focusThread,
            store,
        ],
    );

    const renderAfterLine = useCallback(
        (side: 'old' | 'new', line: number): ReactNode => {
            const lineThreads = layout.byLine.get(`${side}:${String(line)}`) ?? EMPTY_THREADS;
            // A collapsed thread takes up no rows. Only its marker remains in the DOM.
            const shown = lineThreads.filter((thread) => openThreads.has(thread.id));
            const composer = composerLayout.byLine.find(
                (candidate) =>
                    candidate.anchor?.position?.side === side && positionLastLine(candidate.anchor.position) === line,
            );
            if (shown.length === 0 && composer === undefined) {
                return null;
            }
            return (
                <div className="diff-row-extra thread-fade">
                    {shown.length === 0 ? null : (
                        <div
                            className={`thread-line${shown.every((thread) => thread.resolved) ? ' thread-line--resolved' : ''}`}
                        >
                            <ThreadList
                                threads={shown}
                                store={store}
                                actions={actions}
                                now={now}
                                onFocusThread={focusThread}
                                {...(initialLayout === undefined ? {} : { initialLayout })}
                            />
                        </div>
                    )}
                    {composer === undefined ? null : (
                        <div className="diff-line-composer">
                            <NewCommentComposer
                                composerKey={composer.key}
                                store={store}
                                transport={actions.transport}
                                {...(initialLayout === undefined ? {} : { initialLayout })}
                            />
                        </div>
                    )}
                </div>
            );
        },
        [
            actions,
            composerLayout.byLine,
            initialLayout,
            layout.byLine,
            now,
            focusThread,
            openThreads,
            store,
        ],
    );

    const renderLineMarker = useCallback(
        (positions: readonly LinePosition[]): ReactNode => {
            // Several threads on one line collapse into one marker: the first author's avatar,
            // the total count, and a click expands or collapses them together.
            const lineThreads = positions.flatMap(
                (position) => layout.byLine.get(`${position.side}:${String(position.line)}`) ?? EMPTY_THREADS,
            );
            if (lineThreads.length === 0) {
                return null;
            }
            return <ThreadMarker threads={lineThreads} store={store} openThreads={openThreads} />;
        },
        [layout.byLine, openThreads, store],
    );

    const lineThreadIds = useMemo(
        () => [...layout.byLine.values()].flatMap((bucket) => bucket.map((thread) => thread.id)),
        [layout.byLine],
    );

    return { threadsUnderHeader, renderAfterLine, renderLineMarker, focusedThreadRange, lineThreadIds };
}

/**
 * "Collapse all / expand all" card threads (docs/design/SPEC-changes-2026-09-20.md §3):
 * the button only appears with at least two inline threads. Its label promises what the button will do.
 *
 * A thread with an open composer is not collapsed in bulk because it holds the reviewer's unsaved text. Such
 * a thread is excluded from the label count too. Otherwise it would get stuck on "collapse all" when the button
 * has nothing left to collapse.
 */
export function useThreadsCollapse(store: ThreadStore, threadIds: readonly string[]): ThreadsCollapse | null {
    const openThreads = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).openThreads;
    const typing = useSyncExternalStore(
        store.subscribeComposers,
        store.getComposersSnapshot,
        store.getComposersSnapshot,
    ).openThreadIds;
    const canCollapse = threadIds.some((id) => openThreads.has(id) && !typing.has(id));
    const onToggle = useCallback(() => {
        const open = store.getSnapshot().openThreads;
        const busy = store.getComposersSnapshot().openThreadIds;
        const collapse = threadIds.some((id) => open.has(id) && !busy.has(id));
        store.setThreadsOpen(collapse ? threadIds.filter((id) => !busy.has(id)) : threadIds, !collapse);
    }, [store, threadIds]);
    return threadIds.length < 2 ? null : { canCollapse, onToggle };
}

/** The position line is actually rendered in the card. */
function positionShown(
    model: DiffFileModel | null,
    rowsShown: boolean,
    position: { readonly side: 'old' | 'new'; readonly line: number; readonly size: number } | null | undefined,
): boolean {
    return (
        rowsShown &&
        position !== null &&
        position !== undefined &&
        modelHasPosition(model, position.side, positionLastLine(position))
    );
}

export function modelHasPosition(model: DiffFileModel | null, side: 'old' | 'new', line: number): boolean {
    if (model?.content.kind !== 'text') {
        return false;
    }
    return model.content.blocks.some(
        (block) =>
            block.kind === 'hunk' &&
            block.lines.some((candidate) => (side === 'old' ? candidate.oldLine : candidate.newLine) === line),
    );
}

const EMPTY_THREADS: readonly Thread[] = [];
