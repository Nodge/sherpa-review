import type { RouteStopChange, Thread } from '@sherpa/protocol';
import type { ReactNode, RefObject } from 'react';

import { ViewedToggle } from '../../components/viewed-toggle.tsx';
import type { MessageKey, Translate } from '../../i18n/index.js';
import { useFormat, useT } from '../../i18n/index.js';
import { Icon } from '../../icons/icon.tsx';
import { useReadOnlyIteration, useReadOnlyReason } from '../../iterations/read-only.tsx';
import { stripInlineCode } from '@sherpa/protocol/markdown';
import type { StopLink } from '../../markdown/markdown.tsx';
import { Markdown, StopMarkdown } from '../../markdown/markdown.tsx';
import type { RouteStopView } from '../../route/route-model.js';

/**
 * Route stop (docs/design/README.md §1): a grid with a sticky left column and a diff column.
 * The left column has a tier rule, plan number, badge, comment count, viewed mark, title,
 * paragraph, connector and file chips. The view builds the right column and passes it as the `diff` prop.
 *
 * The component loads and computes nothing. Everything arrives through props, so the same
 * card renders in the state gallery with fixtures.
 */

export interface StopCardProps {
    readonly view: RouteStopView;
    readonly stopCount: number;
    readonly comments: number;
    readonly viewed: boolean;
    readonly onViewed: (viewed: boolean) => void;
    /** Stop files are still being parsed, so no ranges are available for a viewed mark. */
    readonly pending?: boolean;
    /** Parsing failed for some files. Their ranges will be unavailable until retry. */
    readonly parseFailed?: boolean;
    /** Agent stopped during generation. Filled content has a muted note (docs/design/SPEC-elements.md §4.4). */
    readonly filledBeforeStop?: boolean;
    /** Value of the failed mark write. Shows "not saved · retry" beside the control. */
    readonly failedViewed?: boolean | null;
    /** Stop highlighted by hovering a coverage bar segment (docs/design/SPEC-elements.md §2.4). */
    readonly marked?: boolean;
    /** "Kept on screen, outside the current filter" note (docs/design/SPEC-elements.md §2.7). */
    readonly keptInView?: boolean;
    /** Fill the individual slot where the agent previously stopped (docs/design/SPEC-elements.md §4.3). */
    readonly onFillStop?: (planIndex: number) => void;
    /** Follow an internal description link to another stop or a diff file. */
    readonly onOpenLink?: (link: StopLink) => void;
    readonly chips: ReactNode;
    readonly diff: ReactNode;
    /** Expose the diff column so the view can measure its height and reserve space when it leaves the DOM. */
    readonly diffRef?: RefObject<HTMLDivElement | null>;
    /** Accent line flash above the diff column after a file jump (docs/design/README.md §Interactions & behaviour). */
    readonly flash?: boolean;
    /** Threads from `change.threadIds` that caused the change, reduced to links with unknown ids removed. */
    readonly changeThreads?: readonly StopChangeThread[];
    readonly onOpenThread?: (threadId: string) => void;
    /**
     * Onboarding tour step targets: `narrative` for the narrative column,
     * `stopdiff` for the diff column. Set on the first route stop and the tour skeleton placeholder.
     */
    readonly tourAnchors?: boolean;
}

/** Link to a thread that caused the change in the "why this stop changed" block (docs/design/README.md §1 item 4). */
export interface StopChangeThread {
    readonly id: string;
    readonly label: string;
}

/**
 * Links to threads that caused the change. A thread without an anchor position is a "PR thread". Unknown ids have no link
 * (the section validator already removes them, but the view does not rely on that cleanup).
 */
export function stopChangeThreads(
    change: RouteStopChange | null,
    threads: ReadonlyMap<string, Thread>,
    t: Translate,
): readonly StopChangeThread[] {
    if (change === null) {
        return EMPTY_CHANGE_THREADS;
    }
    const links: StopChangeThread[] = [];
    for (const id of change.threadIds) {
        const thread = threads.get(id);
        if (thread === undefined) {
            continue;
        }
        const line = thread.anchor?.position?.line ?? null;
        links.push({ id, label: line === null ? t('route.stop.thread.pr') : t('route.stop.thread.line', line) });
    }
    return links;
}

const EMPTY_CHANGE_THREADS: readonly StopChangeThread[] = [];

/** Stop classification badge relative to the previous pass (docs/design/README.md §1 item 1). */
const CHANGE_BADGE: Readonly<Record<RouteStopChange['kind'], MessageKey>> = {
    changed: 'route.stop.change.changed',
    new: 'route.stop.change.new',
};

export function StopCard({
    view,
    stopCount,
    comments,
    viewed,
    onViewed,
    pending = false,
    parseFailed = false,
    filledBeforeStop = false,
    failedViewed = null,
    marked = false,
    keptInView = false,
    onFillStop,
    onOpenLink,
    chips,
    diff,
    diffRef,
    flash = false,
    changeThreads = EMPTY_CHANGE_THREADS,
    onOpenThread,
    tourAnchors = false,
}: StopCardProps) {
    const t = useT();
    const { count } = useFormat();
    // Filling writes to the snapshot, so it is only available in the active iteration.
    const readOnly = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();
    const { stop } = view;
    const tier = stop.tier;
    const unfilled = stop.status !== 'ready';

    return (
        <section
            className={`route-stop route-stop--${tier}${unfilled ? ' route-stop--unfilled' : ''}${viewed ? ' is-viewed' : ''}${marked ? ' is-marked' : ''}`}
            id={`stop-${stop.id}`}
            {...(stop.change === null ? {} : { 'data-stop-change': stop.change.kind })}
            role="region"
            aria-label={t('route.stop.aria', view.planLabel, stopCount, stripInlineCode(stop.title))}
        >
            <div className="route-stop__side" {...(tourAnchors ? { 'data-tour': 'narrative' } : {})}>
                <div className="route-stop__head">
                    <span className={`route-stop__rule route-stop__rule--${tier}`} aria-hidden="true" />
                    <span className="route-stop__number">
                        {view.planLabel} / {String(stopCount)}
                    </span>
                    {tier === 'high' ? <span className="route-stop__badge">high</span> : null}
                    {stop.status === 'ready' ? null : (
                        <span className="route-stop__badge route-stop__badge--queued">
                            {t(statusBadge(stop.status))}
                        </span>
                    )}
                    {/* Show the classification badge whenever it exists, even without a filter. */}
                    {stop.change === null ? null : (
                        <span className={`route-stop__badge route-stop__badge--${stop.change.kind}`}>
                            {t(CHANGE_BADGE[stop.change.kind])}
                        </span>
                    )}
                    <span className="route-stop__spacer" />
                    {comments === 0 ? null : (
                        <span className="route-stop__comments" title={t('route.stop.commentsTitle', comments)}>
                            <span className="route-stop__comments-box" aria-hidden="true" />
                            {count(comments)}
                        </span>
                    )}
                    <StopViewedToggle
                        viewed={viewed}
                        pending={pending}
                        parseFailed={parseFailed}
                        unfilled={unfilled}
                        failedViewed={failedViewed}
                        onViewed={onViewed}
                    />
                </div>

                <h2 className="route-stop__title">
                    <Markdown text={stop.title} profile="route" />
                </h2>

                {filledBeforeStop && !unfilled ? (
                    <p className="route-stop__filled-before">{t('route.stop.filledBefore')}</p>
                ) : null}

                {stop.paragraph === null ? (
                    <p className="route-stop__note">
                        {t(unfilledNote(stop.status))}
                        {stop.status !== 'failed' || onFillStop === undefined ? null : (
                            <button
                                type="button"
                                className="ctl ctl--link-muted route-stop__regenerate"
                                disabled={readOnly}
                                {...(readOnly ? { title: readOnlyReason } : {})}
                                onClick={() => {
                                    onFillStop(stop.planIndex);
                                }}
                            >
                                {t('route.stop.fill')}
                            </button>
                        )}
                    </p>
                ) : (
                    <div className="route-stop__paragraph">
                        <StopMarkdown
                            text={stop.paragraph}
                            {...(onOpenLink === undefined ? {} : { onOpenLink })}
                        />
                    </div>
                )}

                {stop.change?.reason == null ? null : (
                    <StopChangeReason
                        reason={stop.change.reason}
                        threads={changeThreads}
                        {...(onOpenThread === undefined ? {} : { onOpenThread })}
                    />
                )}

                {stop.bridge === null ? null : (
                    <p className="route-stop__bridge">
                        <Markdown text={stop.bridge} profile="route" />
                    </p>
                )}

                {/*
                 * Validator notes only appear on unfilled stops, where they explain
                 * the empty slot. On filled stops, they cost more space than they help. The reviewer
                 * cannot move a discarded anchor anyway, and missing coverage appears in the bar and Other.
                 */}
                {!unfilled || stop.validationNotes.length === 0 ? null : (
                    <ul className="route-stop__validation">
                        {stop.validationNotes.map((note) => (
                            <li key={note}>
                                <Markdown text={note} profile="route" />
                            </li>
                        ))}
                    </ul>
                )}

                {keptInView ? <p className="route-stop__kept">{t('route.stop.kept')}</p> : null}

                {chips}
            </div>

            <div className="route-stop__diff" ref={diffRef} {...(tourAnchors ? { 'data-tour': 'stopdiff' } : {})}>
                {flash ? <div className="route-stop__flash" aria-hidden="true" /> : null}
                {diff}
            </div>
        </section>
    );
}

/**
 * Stop viewed mark uses the same control as a file card (docs/design/SPEC-elements.md §2.10),
 * with an error on failed writes beside it and a retry of the exact same action.
 *
 * A stop cannot be marked until its ranges are computed. An empty set would go
 * to the server, leaving files unread. The same applies to an unfilled stop, which has no ranges
 * at all, and to a stop with a file whose parsing failed, whose ranges would silently
 * be omitted. Clearing a mark is always possible because it needs no ranges.
 */
export function StopViewedToggle({
    viewed,
    pending = false,
    parseFailed = false,
    unfilled = false,
    failedViewed,
    onViewed,
}: {
    viewed: boolean;
    pending?: boolean;
    parseFailed?: boolean;
    unfilled?: boolean;
    failedViewed: boolean | null;
    onViewed: (viewed: boolean) => void;
}) {
    const t = useT();
    const disabled = (pending || parseFailed || unfilled) && !viewed;
    const reason = unfilled
        ? t('route.stop.viewed.unfilled')
        : parseFailed
          ? t('route.stop.viewed.parseFailed')
          : t('route.stop.viewed.pending');
    return (
        <>
            {failedViewed === null ? null : (
                <span className="route-stop__viewed-error" role="status">
                    {t('route.stop.notSaved')}
                    <button
                        type="button"
                        onClick={() => {
                            onViewed(failedViewed);
                        }}
                    >
                        {t('route.stop.retry')}
                    </button>
                </span>
            )}
            <ViewedToggle
                className="route-stop__viewed"
                variant="toggle"
                viewed={viewed}
                disabled={disabled}
                title={disabled ? reason : undefined}
                onToggle={onViewed}
            />
        </>
    );
}

/**
 * "Why this stop changed" (docs/design/README.md §1 item 4): model explanation below the paragraph, followed by
 * links to the threads it named as the cause. Without a handler, the links remain text:
 * only the view, which knows about the URL fragment, can open a thread.
 */
function StopChangeReason({
    reason,
    threads,
    onOpenThread,
}: {
    reason: string;
    threads: readonly StopChangeThread[];
    onOpenThread?: (threadId: string) => void;
}) {
    const t = useT();
    return (
        <div className="route-stop__change">
            <div className="route-stop__change-label">{t('route.stop.changeLabel')}</div>
            <div className="route-stop__change-body">
                <Markdown text={reason} profile="route" />
            </div>
            {threads.length === 0 || onOpenThread === undefined ? null : (
                <div className="route-stop__change-threads">
                    {threads.map((thread) => (
                        <button
                            key={thread.id}
                            type="button"
                            className="ctl ctl--link-muted route-stop__change-thread"
                            onClick={() => {
                                onOpenThread(thread.id);
                            }}
                        >
                            {thread.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * Collapsed low-tier stop card (docs/design/README.md §2). The view builds the line-count label. The tour skeleton
 * placeholder has nothing to count and must not invent numbers.
 */
export function CollapsedStop({
    label,
    dataTour,
    onExpand,
}: {
    label: string;
    /** Onboarding tour step target: `fold-<stopId>`. */
    dataTour?: string;
    onExpand: () => void;
}) {
    const t = useT();
    return (
        <button
            type="button"
            className="route-collapsed"
            {...(dataTour === undefined ? {} : { 'data-tour': dataTour })}
            onClick={onExpand}
        >
            <span className="route-collapsed__mark" aria-hidden="true">
                <Icon name="chev-down" size={13} />
            </span>
            {label}
            <span className="route-stop__spacer" />
            <span className="route-collapsed__hint">{t('route.collapsed.hint')}</span>
        </button>
    );
}

/**
 * Viewed stop fold: a summary row that expands on click (docs/design/SPEC-elements.md §2.9).
 * A digest stop's summary also names assertions. The reviewer did not read test code line by line,
 * so "N files · M lines" alone would misrepresent what they accepted (docs/design/README.md §2).
 */
export function ViewedSummary({
    lines,
    files,
    assertions = 0,
    onExpand,
}: {
    lines: number;
    files: number;
    assertions?: number;
    onExpand: () => void;
}) {
    const t = useT();
    return (
        <button type="button" className="route-collapsed route-collapsed--viewed" onClick={onExpand}>
            <span className="route-collapsed__mark" aria-hidden="true">
                <Icon name="chev-down" size={13} />
            </span>
            {assertions === 0
                ? t('route.viewedSummary', files, lines)
                : t('route.viewedSummary.assertions', assertions, files, lines)}
        </button>
    );
}

/** Card with a dashed border fills the empty space when a stop has no hunks (docs/design/SPEC-elements.md §2.9). */
export function EmptyStop({ text }: { text: string }) {
    return <div className="route-collapsed route-collapsed--empty">{text}</div>;
}

/**
 * Shimmer skeleton in the diff column while the stop awaits filling (docs/design/README.md §8, docs/design/SPEC-elements.md §3).
 * Its fixed height is close to a real card, so arriving content does not shift
 * neighbouring elements.
 */
export function StopSkeleton() {
    return (
        <div className="route-skeleton-card" aria-hidden="true">
            <div className="route-skeleton-card__head" />
            <div className="route-skeleton-card__body">
                {SKELETON_ROWS.map((row) => (
                    <div key={row} className={`route-skeleton-card__row route-skeleton-card__row--${row}`} />
                ))}
            </div>
        </div>
    );
}

const SKELETON_ROWS = ['wide', 'mid', 'wide', 'short', 'mid', 'wide'] as const;

/**
 * Anchor drift: the stop points to lines no longer in the diff (docs/design/SPEC-elements.md §2.9).
 * `partial` means some anchors survived. The notice sits above their cards.
 */
export function AnchorDrift({ paths, partial = false }: { paths: readonly string[]; partial?: boolean }) {
    const t = useT();
    return (
        <div className="route-drift" role="note">
            <p className="route-drift__text">{partial ? t('route.drift.partial') : t('route.drift')}</p>
            {paths.length === 0 ? null : (
                <ul className="route-drift__paths">
                    {paths.map((path) => (
                        <li key={path}>{path}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/**
 * Stop anchors fall in conflicted files (docs/design/SPEC-elements.md §4.1). The lines exist in the diff, but the file is outside
 * route coverage. There is nothing to read or mark here. Resolve the conflict in the host.
 * This is not drift, so prompting regeneration would be misleading.
 */
export function StopConflicts({ paths }: { paths: readonly string[] }) {
    const t = useT();
    return (
        <div className="route-conflicts" role="note">
            <p className="route-conflicts__text">{t('route.stop.conflicts', paths.length)}</p>
            <ul className="route-conflicts__paths">
                {paths.map((path) => (
                    <li key={path}>{path}</li>
                ))}
            </ul>
        </div>
    );
}

function statusBadge(status: RouteStopView['stop']['status']): MessageKey {
    return status === 'failed'
        ? 'route.gen.plan.failed'
        : status === 'filling'
          ? 'route.gen.plan.filling'
          : 'route.gen.plan.queued';
}

function unfilledNote(status: RouteStopView['stop']['status']): MessageKey {
    return status === 'failed' ? 'route.stop.unfilled.failed' : 'route.stop.unfilled.queued';
}
