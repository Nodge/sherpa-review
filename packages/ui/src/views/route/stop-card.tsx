import type { RouteStopChange, Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { ViewedToggle } from '../../components/viewed-toggle.tsx';
import { formatCount, plural } from '../../i18n/index.js';
import { Icon } from '../../icons/icon.tsx';
import { useReadOnlyIteration, useReadOnlyReason } from '../../iterations/read-only.tsx';
import { stripInlineCode } from '../../markdown/markdown.js';
import { Markdown } from '../../markdown/markdown.tsx';
import { clampParagraph } from '../../route/paragraph.js';
import type { RouteStopView } from '../../route/route-model.js';

/**
 * Route stop (README §1): a grid with a sticky left column and a diff column.
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
    /** Agent died during generation: filled content remains readable with a quiet note (SPEC §4.4). */
    readonly filledBeforeStop?: boolean;
    /** Value of the failed mark write. Shows "not saved · retry" beside the control. */
    readonly failedViewed?: boolean | null;
    /** The stop is highlighted by hovering over a coverage strip segment (SPEC §2.4). */
    readonly marked?: boolean;
    /** "Kept in view — outside the current filter" label (SPEC §2.7). */
    readonly keptInView?: boolean;
    /** Fills the slot where the agent stopped early (SPEC §4.3). */
    readonly onFillStop?: (planIndex: number) => void;
    readonly chips: ReactNode;
    readonly diff: ReactNode;
    /** Accent line flash above the diff column after jumping to a file (README Interactions). */
    readonly flash?: boolean;
    /** Threads from `change.threadIds` that caused the change, reduced to links with unknown ids removed. */
    readonly changeThreads?: readonly StopChangeThread[];
    readonly onOpenThread?: (threadId: string) => void;
}

/** Link to a thread that caused the change, in "why this stop changed" (README §1 item 4). */
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
        links.push({ id, label: line === null ? 'thread on the PR' : `thread at line ${String(line)}` });
    }
    return links;
}

const EMPTY_CHANGE_THREADS: readonly StopChangeThread[] = [];

/** Stop classification badge relative to the previous pass (README §1 item 1). */
const CHANGE_BADGE: Readonly<Record<RouteStopChange['kind'], string>> = {
    changed: 'changed',
    new: 'new',
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
    chips,
    diff,
    flash = false,
    changeThreads = EMPTY_CHANGE_THREADS,
    onOpenThread,
}: StopCardProps) {
    // Filling writes to the snapshot and is available only in the active iteration (M4 scope).
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
            aria-label={`Stop ${view.planLabel} of ${String(stopCount)} — ${stripInlineCode(stop.title)}`}
        >
            <div className="route-stop__side">
                <div className="route-stop__head">
                    <span className={`route-stop__rule route-stop__rule--${tier}`} aria-hidden="true" />
                    <span className="route-stop__number">
                        {view.planLabel} / {String(stopCount)}
                    </span>
                    {tier === 'high' ? <span className="route-stop__badge">high</span> : null}
                    {stop.status === 'ready' ? null : (
                        <span className="route-stop__badge route-stop__badge--queued">{statusBadge(stop.status)}</span>
                    )}
                    {/* Show the classification badge whenever it exists, even without a filter. */}
                    {stop.change === null ? null : (
                        <span className={`route-stop__badge route-stop__badge--${stop.change.kind}`}>
                            {CHANGE_BADGE[stop.change.kind]}
                        </span>
                    )}
                    <span className="route-stop__spacer" />
                    {comments === 0 ? null : (
                        <span className="route-stop__comments" title={`Comments in this stop's ranges: ${String(comments)}`}>
                            <span className="route-stop__comments-box" aria-hidden="true" />
                            {formatCount(comments, 'ru')}
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
                    <p className="route-stop__filled-before">filled before the agent stopped</p>
                ) : null}

                {stop.paragraph === null ? (
                    <p className="route-stop__note">
                        {unfilledNote(stop.status)}
                        {stop.status !== 'failed' || onFillStop === undefined ? null : (
                            <button
                                type="button"
                                className="route-stop__regenerate"
                                disabled={readOnly}
                                {...(readOnly ? { title: readOnlyReason } : {})}
                                onClick={() => {
                                    onFillStop(stop.planIndex);
                                }}
                            >
                                Fill this stop
                            </button>
                        )}
                    </p>
                ) : (
                    <Paragraph text={stop.paragraph} />
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

                {stop.validationNotes.length === 0 ? null : (
                    <ul className="route-stop__validation">
                        {stop.validationNotes.map((note) => (
                            <li key={note}>
                                <Markdown text={note} profile="route" />
                            </li>
                        ))}
                    </ul>
                )}

                {keptInView ? (
                    <p className="route-stop__kept">kept in view — outside the current filter</p>
                ) : null}

                {chips}
            </div>

            <div className="route-stop__diff">
                {flash ? <div className="route-stop__flash" aria-hidden="true" /> : null}
                {diff}
            </div>
        </section>
    );
}

/**
 * Stop viewed mark: the same control as the file card uses (SPEC §2.10),
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
    const disabled = (pending || parseFailed || unfilled) && !viewed;
    const reason = unfilled
        ? 'This stop is not filled yet'
        : parseFailed
          ? 'Some files of this stop failed to parse — retry the parse'
          : 'The ranges of this stop are still being counted';
    return (
        <>
            {failedViewed === null ? null : (
                <span className="route-stop__viewed-error" role="status">
                    not saved
                    <button
                        type="button"
                        onClick={() => {
                            onViewed(failedViewed);
                        }}
                    >
                        retry
                    </button>
                </span>
            )}
            <ViewedToggle
                className="route-stop__viewed"
                viewed={viewed}
                disabled={disabled}
                title={disabled ? reason : undefined}
                onToggle={onViewed}
            />
        </>
    );
}

/**
 * "Why this stop changed" (README §1 item 4): the model's explanation below the paragraph, followed by
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
    return (
        <div className="route-stop__change">
            <div className="route-stop__change-label">why this stop changed</div>
            <div className="route-stop__change-body">
                <Markdown text={reason} profile="route" />
            </div>
            {threads.length === 0 || onOpenThread === undefined ? null : (
                <div className="route-stop__change-threads">
                    {threads.map((thread) => (
                        <button
                            key={thread.id}
                            type="button"
                            className="route-stop__change-thread"
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
 * A paragraph clamped to four sentences (SPEC §2.9). The clamp truncates plain text before rendering,
 * so the truncated start can split a pair of backticks. That backtick
 * stays visible as a literal until the paragraph is expanded.
 */
function Paragraph({ text }: { text: string }) {
    const [full, setFull] = useState(false);
    const { head, rest } = clampParagraph(text);

    if (rest === '' || full) {
        return (
            <p className="route-stop__paragraph">
                <Markdown text={text} profile="route" />
            </p>
        );
    }
    return (
        <p className="route-stop__paragraph">
            <Markdown text={head} profile="route" />{' '}
            <button
                type="button"
                className="route-stop__more"
                onClick={() => {
                    setFull(true);
                }}
            >
                more
            </button>
        </p>
    );
}

/** Collapsed low-tier stop card (README §2). */
export function CollapsedStop({
    lines,
    files,
    reason,
    onExpand,
}: {
    lines: number;
    files: number;
    reason: string;
    onExpand: () => void;
}) {
    return (
        <button type="button" className="route-collapsed" onClick={onExpand}>
            <span className="route-collapsed__mark" aria-hidden="true">
                <Icon name="chev-down" size={13} />
            </span>
            Collapsed · {formatCount(lines, 'ru')} {plural(lines, { one: 'line', few: 'lines', many: 'lines', other: 'lines' }, 'ru')} in {formatCount(files, 'ru')}{' '}
            {plural(files, { one: 'file', few: 'files', many: 'files', other: 'files' }, 'ru')} · {reason}
            <span className="route-stop__spacer" />
            <span className="route-collapsed__hint">nothing is hidden — click to expand</span>
        </button>
    );
}

/**
 * Collapsed viewed stop: a summary row that expands on click (SPEC §2.9).
 * A digest stop's summary also names assertions. The reviewer did not read test code line by line,
 * and "N files · M lines" alone would misrepresent what they actually accepted (README §2).
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
    return (
        <button type="button" className="route-collapsed route-collapsed--viewed" onClick={onExpand}>
            <span className="route-collapsed__mark" aria-hidden="true">
                <Icon name="chev-down" size={13} />
            </span>
            {assertions === 0
                ? null
                : `${formatCount(assertions, 'ru')} ${plural(assertions, { one: 'assertion', few: 'assertions', many: 'assertions', other: 'assertions' }, 'ru')} · `}
            {formatCount(files, 'ru')} {plural(files, { one: 'file', few: 'files', many: 'files', other: 'files' }, 'ru')} · {formatCount(lines, 'ru')}{' '}
            {plural(lines, { one: 'line', few: 'lines', many: 'lines', other: 'lines' }, 'ru')} · viewed
        </button>
    );
}

/** Dashed card instead of empty space: the stop has no hunks (SPEC §2.9). */
export function EmptyStop({ text }: { text: string }) {
    return <div className="route-collapsed route-collapsed--empty">{text}</div>;
}

/**
 * Shimmer skeleton in the diff column: the stop is waiting to be filled (README §8, SPEC §3).
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
 * Anchor drift: a stop points at lines no longer present in the diff (SPEC §2.9).
 * `partial` means some anchors survived. The notice sits above their cards.
 */
export function AnchorDrift({ paths, partial = false }: { paths: readonly string[]; partial?: boolean }) {
    return (
        <div className="route-drift" role="note">
            <p className="route-drift__text">
                {partial ? 'Some anchors of this stop pointed' : 'This stop pointed'} at lines that are no longer in the
                diff. Regenerate the route or read the file raw.
            </p>
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

function statusBadge(status: RouteStopView['stop']['status']): string {
    return status === 'failed' ? 'not filled' : status === 'filling' ? 'filling' : 'queued';
}

function unfilledNote(status: RouteStopView['stop']['status']): string {
    if (status === 'failed') {
        return 'Not filled — the agent stopped early. The title and the number are fixed by the plan.';
    }
    return 'The title is fixed by the plan. The agent has not filled this stop yet — it will land in this slot.';
}
