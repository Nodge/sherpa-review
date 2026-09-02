import type { Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import type { DiffFileModel } from '../diff/model.js';
import type { LineRange } from '../diff-view/selection.js';
import type { ComposerLayout } from './composer-markdown.js';
import { placeThreadsOnVisibleLines, positionLastLine, threadAtLines } from './model.js';
import type { ComposerSnapshot, ThreadStore } from './store.js';
import type { ThreadActions } from './thread-list.tsx';
import { NewCommentComposer, ThreadList } from './thread-list.tsx';

/**
 * Thread and composer placement in a file card: what goes below the header and what sits
 * below a specific line. Both views share the same logic. Full diff cards and route stop
 * cards must behave identically (brief principle 5: one reader, two reading orders).
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
    readonly focusedThreadRange: LineRange | null;
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
    const readIteration = useCallback(() => store.getSnapshot().iterationLayout, [store]);
    const iteration = useSyncExternalStore(store.subscribe, readIteration, readIteration);
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
                            inlineDraftEditing
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
            const composer = composerLayout.byLine.find(
                (candidate) =>
                    candidate.anchor?.position?.side === side && positionLastLine(candidate.anchor.position) === line,
            );
            if (lineThreads.length === 0 && composer === undefined) {
                return null;
            }
            return (
                <div className="diff-row-extra thread-fade">
                    {lineThreads.length === 0 ? null : (
                        <ThreadList
                            threads={lineThreads}
                            store={store}
                            actions={actions}
                            now={now}
                            onFocusThread={focusThread}
                            inlineDraftEditing
                            {...(initialLayout === undefined ? {} : { initialLayout })}
                        />
                    )}
                    {composer === undefined ? null : (
                        <div className="diff-line-composer">
                            <NewCommentComposer
                                composerKey={composer.key}
                                store={store}
                                transport={actions.transport}
                                showDraftChip
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
            store,
        ],
    );

    return { threadsUnderHeader, renderAfterLine, focusedThreadRange };
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
