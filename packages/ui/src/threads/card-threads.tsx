import type { Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useMemo } from 'react';

import type { DiffFileModel } from '../diff/model.js';
import { placeThreadsOnVisibleLines } from './model.js';
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
    placement = 'nearest',
}: CardThreadsInput): CardThreads {
    const layout = useMemo(() => {
        const underHeader = threads.filter((thread) => thread.outdated || thread.anchor?.position === null);
        const positional = threads.filter((thread) => !thread.outdated && thread.anchor?.position !== null);
        const onScreen =
            placement === 'exact'
                ? positional.filter((thread) => positionShown(model, rowsShown, thread.anchor?.position))
                : positional;
        const offScreen = placement === 'exact' ? positional.filter((thread) => !onScreen.includes(thread)) : [];
        const placed = rowsShown
            ? placeThreadsOnVisibleLines(model, onScreen)
            : { byLine: new Map<string, readonly Thread[]>(), unplaced: onScreen };
        return { byLine: placed.byLine, underHeader: [...underHeader, ...placed.unplaced, ...offScreen] };
    }, [model, placement, rowsShown, threads]);

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
                            onFocusThread={onFocusThread}
                        />
                    )}
                    {composerLayout.underHeader.map((composer) => (
                        <div key={composer.key} className="diff-row-extra thread-fade">
                            <NewCommentComposer composerKey={composer.key} store={store} transport={actions.transport} />
                        </div>
                    ))}
                </>
            ),
        [actions, composerLayout.underHeader, layout.underHeader, now, onFocusThread, store],
    );

    const renderAfterLine = useCallback(
        (side: 'old' | 'new', line: number): ReactNode => {
            const lineThreads = layout.byLine.get(`${side}:${String(line)}`) ?? EMPTY_THREADS;
            const composer = composerLayout.byLine.find(
                (candidate) => candidate.anchor?.position?.side === side && candidate.anchor.position.line === line,
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
                            onFocusThread={onFocusThread}
                        />
                    )}
                    {composer === undefined ? null : (
                        <NewCommentComposer composerKey={composer.key} store={store} transport={actions.transport} />
                    )}
                </div>
            );
        },
        [actions, composerLayout.byLine, layout.byLine, now, onFocusThread, store],
    );

    return { threadsUnderHeader, renderAfterLine };
}

/** The position line is actually rendered in the card. */
function positionShown(
    model: DiffFileModel | null,
    rowsShown: boolean,
    position: { readonly side: 'old' | 'new'; readonly line: number } | null | undefined,
): boolean {
    return rowsShown && position !== null && position !== undefined && modelHasPosition(model, position.side, position.line);
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
