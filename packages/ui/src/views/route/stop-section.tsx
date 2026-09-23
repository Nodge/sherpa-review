import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../../i18n/index.js';
import type { StopLink } from '../../markdown/markdown.tsx';
import type { readStateOf } from '../../progress/read-state.js';
import { buildDigest, buildDigestTestCode } from '../../route/digest.js';
import type { RouteEntry, RouteFileGroup, RouteStopView } from '../../route/route-model.js';
import { canUnmountStopDiff, lazyCards } from '../../route/route-model.js';
import { FileChips } from './file-chips.tsx';
import type { StopChangeThread } from './stop-card.tsx';
import {
    AnchorDrift,
    CollapsedStop,
    EmptyStop,
    StopCard,
    StopConflicts,
    StopSkeleton,
    ViewedSummary,
} from './stop-card.tsx';
import { TestDigest } from './test-digest.tsx';
import { useNearViewport, useOnScreen } from './use-on-screen.js';

/**
 * One route stop: narrative card on the left and diff column on the right, clipped to the stop's
 * anchors. The column leaves the DOM when the reviewer scrolls far away. A placeholder
 * at the last measured height reserves its space.
 */

export interface StopSectionProps {
    readonly view: RouteStopView;
    /** First route stop. Its diff column stays in the DOM. */
    readonly first: boolean;
    /** First collapsed low-tier stop. Its fold holds the tour step target `fold-<stopId>`. */
    readonly tourFold: boolean;
    /** Files with an active selection, open composer or focused row, across the whole route. */
    readonly busyFileIds: ReadonlySet<string>;
    /** Column layout key. Changing it resets measured height. `null` means it is too early to measure. */
    readonly layoutKeyOf: (stopId: string, files: readonly RouteFileGroup[]) => string | null;
    /** Stop targeted by a jump still in progress. */
    readonly jumping: boolean;
    readonly entries: readonly RouteEntry[];
    readonly stopCount: number;
    readonly comments: number;
    /** Links to causal threads in the "why this stop changed" block. */
    readonly changeThreads: readonly StopChangeThread[];
    readonly onOpenThread?: (threadId: string) => void;
    /** null shows all stop files (no filter, or the stop is kept on screen). */
    readonly fileIds: ReadonlySet<string> | null;
    readonly keptInView: boolean;
    readonly viewed: boolean;
    /** Stop files are still being parsed, so mark ranges cannot be computed yet. */
    readonly pending: boolean;
    /** Parsing failed for some files. Their ranges are unavailable until retry. */
    readonly parseFailed: boolean;
    /** Agent disconnected during generation. Filled content gets a muted note (docs/design/SPEC-elements.md §4.4). */
    readonly filledBeforeStop: boolean;
    /** Collapsed by a viewed mark, manual `x` collapse or the low-tier default. */
    readonly collapsed: boolean;
    readonly collapsedManually: boolean;
    /** See `StopCardProps.marked`. */
    readonly marked: boolean;
    /** Value of the failed mark write. `null` means no write has failed. */
    readonly failedViewed: boolean | null;
    readonly flash: boolean;
    readonly readStateOf: (fileId: string) => ReturnType<typeof readStateOf>;
    readonly onViewed: (viewed: boolean) => void;
    readonly onFillStop?: (planIndex: number) => void;
    readonly onExpand: () => void;
    readonly onOpenFile: (stopId: string, fileId: string) => void;
    /** Follow an internal description link. `stopId` is the stop whose description contained the clicked link. */
    readonly onOpenLink?: (stopId: string, link: StopLink) => void;
    readonly onVisible: (fileIds: readonly string[]) => void;
    readonly renderCard: (stopId: string, group: RouteFileGroup) => ReactNode;
    /** Digest stop with test code expanded below the digest card (docs/design/README.md §2). */
    readonly testCodeShown: boolean;
    readonly onToggleTestCode: () => void;
    /** Whether a route card renders the file containing the assertion's anchor. */
    readonly anchorReachable: (fileId: string, line: number) => boolean;
    readonly onOpenAnchor: (fileId: string, line: number) => void;
}

/**
 * Whether a stop renders a fold. Same conditions the diff column in `StopSection`
 * uses to choose `collapsed`: stop filled, anchors intact, files present after applying the lens.
 */
export function collapsedStopShown(view: RouteStopView, fileIds: ReadonlySet<string> | null): boolean {
    if (view.stop.status === 'queued' || view.stop.status === 'filling' || view.drift) {
        return false;
    }
    const files = fileIds === null ? view.files : view.files.filter((group) => fileIds.has(group.fileId));
    return files.length > 0 || buildDigest(view.stop) !== null;
}

export function StopSection({
    view,
    first,
    tourFold,
    busyFileIds,
    layoutKeyOf,
    jumping,
    entries,
    stopCount,
    comments,
    changeThreads,
    onOpenThread,
    fileIds,
    keptInView,
    viewed,
    pending,
    parseFailed,
    filledBeforeStop,
    collapsed,
    collapsedManually,
    marked,
    failedViewed,
    flash,
    readStateOf: readState,
    onViewed,
    onFillStop,
    onExpand,
    onOpenFile,
    onOpenLink,
    onVisible,
    renderCard,
    testCodeShown,
    onToggleTestCode,
    anchorReachable,
    onOpenAnchor,
}: StopSectionProps) {
    const t = useT();
    const ref = useRef<HTMLDivElement | null>(null);
    const diffRef = useRef<HTMLDivElement | null>(null);
    const onScreen = useOnScreen(ref);
    const nearViewport = useNearViewport(ref, {
        mountMargin: MOUNT_MARGIN,
        unmountMargin: UNMOUNT_MARGIN,
    });
    const files = useMemo(
        () => (fileIds === null ? view.files : view.files.filter((group) => fileIds.has(group.fileId))),
        [fileIds, view.files],
    );
    // Parsing is requested for all stop files, including hidden test code. The viewed mark's seen ranges
    // are computed from the stop's anchors and do not depend on the toggle.
    const ids = useMemo(() => files.map((group) => group.fileId), [files]);
    useEffect(() => {
        if (onScreen) {
            onVisible(ids);
        }
    }, [ids, onScreen, onVisible]);

    const digest = useMemo(() => buildDigest(view.stop), [view.stop]);
    // Hybrid "digest + regular files": hide only assertion anchor files that also belong
    // to this stop after applying the lens. Render all other cards as usual.
    const testCode = useMemo(
        () =>
            digest === null
                ? null
                : buildDigestTestCode(
                      digest,
                      entries,
                      view.stop.id,
                      files.map((group) => group.fileId),
                      t,
                  ),
        [digest, entries, files, t, view.stop.id],
    );
    const shownFiles = useMemo(
        () =>
            testCode === null || testCodeShown
                ? files
                : files.filter((group) => !testCode.hiddenFileIds.has(group.fileId)),
        [files, testCode, testCodeShown],
    );

    const lines = files.reduce((total, group) => total + group.additions + group.deletions, 0);
    const cards = onScreen ? shownFiles : lazyCards(shownFiles);

    /**
     * Layout key for this column. Computed from rendered files, so the lens, test-code toggle
     * and edits in neighbouring stops do not leak into it.
     */
    const layoutKey = useMemo(() => {
        const key = layoutKeyOf(view.stop.id, shownFiles);
        return key === null ? null : `${key}|${testCodeShown ? 'test' : ''}`;
    }, [layoutKeyOf, shownFiles, testCodeShown, view.stop.id]);

    /**
     * Diff column height measured for the current layout while the column is mounted.
     * The placeholder keeps that exact height, so removal from the DOM does not shift the document or disturb scrolling.
     */
    const [measured, setMeasured] = useState<{ readonly key: string; readonly height: number } | null>(null);
    const measuredHeight = measured !== null && measured.key === layoutKey ? measured.height : null;
    const busy = view.files.some((group) => busyFileIds.has(group.fileId));

    const status = view.stop.status;
    /** Diff column content. Everything except `cards` fits in a skeleton or a single row. */
    const content: 'skeleton' | 'drift' | 'conflicts' | 'empty' | 'collapsed' | 'cards' =
        status === 'queued' || status === 'filling'
            ? 'skeleton'
            : view.drift
              ? 'drift'
              : files.length === 0 && digest === null
                ? view.conflictPaths.length > 0
                    ? // The entire stop falls in conflicted files, so "no hunks" would be misleading.
                      'conflicts'
                    : 'empty'
                : collapsed
                  ? 'collapsed'
                  : 'cards';

    const unmounted = canUnmountStopDiff({
        nearViewport,
        measuredHeight,
        first,
        rendersCards: content === 'cards',
        jumping: jumping || flash,
        busy,
    });

    /**
     * Only measure the column in full. A stop that has not yet appeared on
     * screen renders only the head of its list (`lazyCards`), and cards may be replaced with
     * skeletons or single-row summaries. Measuring these would put the placeholder hundreds of pixels off.
     */
    const measurable = !unmounted && layoutKey !== null && onScreen && content === 'cards';

    useEffect(() => {
        const element = diffRef.current;
        if (layoutKey === null || !measurable || element === null) {
            return;
        }
        const record = (): void => {
            const height = element.offsetHeight;
            setMeasured((previous) =>
                previous !== null && previous.key === layoutKey && Math.abs(previous.height - height) < 1
                    ? previous
                    : { key: layoutKey, height },
            );
        };
        // Take the first measurement manually. Layout changes do not always change height, but still require a new measurement.
        record();
        if (typeof ResizeObserver === 'undefined') {
            return;
        }
        const observer = new ResizeObserver(record);
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, [layoutKey, measurable]);

    const diff = unmounted ? (
        // Column removed from the DOM. Its last measured height reserves space so the document stays still.
        <div
            className="route-stop__placeholder"
            style={{ height: `${String(measuredHeight ?? 0)}px` }}
            aria-hidden="true"
        />
    ) : content === 'skeleton' ? (
        // Planned slot awaiting filling. Show a skeleton because there is nothing to explain yet, not "no hunks".
        <StopSkeleton />
    ) : content === 'drift' ? (
        <AnchorDrift paths={view.unresolvedPaths} />
    ) : content === 'conflicts' ? (
        <StopConflicts paths={view.conflictPaths} />
    ) : content === 'empty' ? (
        <EmptyStop
            text={t(
                status === 'failed'
                    ? 'route.emptyStop.unfilled'
                    : view.empty
                      ? 'route.emptyStop.noRanges'
                      : 'route.emptyStop.filtered',
            )}
        />
    ) : content === 'collapsed' ? (
        viewed ? (
            <ViewedSummary
                lines={lines}
                files={files.length}
                assertions={digest?.total ?? 0}
                onExpand={onExpand}
            />
        ) : (
            <CollapsedStop
                label={t(
                    'route.collapsed',
                    lines,
                    files.length,
                    t(collapsedManually ? 'route.collapsed.reason.manual' : 'route.collapsed.reason.low'),
                )}
                {...(tourFold ? { dataTour: `fold-${view.stop.id}` } : {})}
                onExpand={onExpand}
            />
        )
    ) : (
        <>
            {/* Some anchors fail to resolve, while others survive. Place the notice above the remaining cards. */}
            {view.unresolvedPaths.length === 0 ? null : <AnchorDrift paths={view.unresolvedPaths} partial />}
            {view.conflictPaths.length === 0 ? null : <StopConflicts paths={view.conflictPaths} />}
            {digest === null ? null : (
                <TestDigest
                    model={digest}
                    shown={testCodeShown}
                    onToggle={onToggleTestCode}
                    hiddenFiles={testCode?.hiddenFileIds.size ?? 0}
                    location={testCode?.location ?? null}
                    anchorReachable={(anchor) => anchorReachable(anchor.fileId, anchor.line)}
                    onOpenAnchor={(anchor) => {
                        onOpenAnchor(anchor.fileId, anchor.line);
                    }}
                />
            )}
            {cards.map((group) => renderCard(view.stop.id, group))}
            {cards.length < shownFiles.length ? (
                <p className="route-stop__lazy">{t('route.lazyMore', shownFiles.length - cards.length)}</p>
            ) : null}
        </>
    );

    return (
        <div ref={ref} data-stop={view.stop.id}>
            <StopCard
                view={view}
                tourAnchors={first}
                stopCount={stopCount}
                comments={comments}
                changeThreads={changeThreads}
                {...(onOpenThread === undefined ? {} : { onOpenThread })}
                viewed={viewed}
                pending={pending}
                parseFailed={parseFailed}
                filledBeforeStop={filledBeforeStop}
                onViewed={onViewed}
                {...(onFillStop === undefined ? {} : { onFillStop })}
                {...(onOpenLink === undefined
                    ? {}
                    : {
                          onOpenLink: (link: StopLink) => {
                              onOpenLink(view.stop.id, link);
                          },
                      })}
                failedViewed={failedViewed}
                marked={marked}
                keptInView={keptInView}
                flash={flash}
                chips={
                    <FileChips
                        files={files}
                        readStateOf={readState}
                        onOpen={(fileId) => {
                            onOpenFile(view.stop.id, fileId);
                        }}
                    />
                }
                diffRef={diffRef}
                diff={diff}
            />
        </div>
    );
}

/**
 * Hysteresis boundaries for returning the stop's diff column to the DOM and removing it.
 * Mount a screen ahead so cards render before the reviewer arrives. Unmount
 * much further away so a stop edge sitting on the boundary does not flicker every frame.
 */
const MOUNT_MARGIN = 1200;
const UNMOUNT_MARGIN = 2500;
