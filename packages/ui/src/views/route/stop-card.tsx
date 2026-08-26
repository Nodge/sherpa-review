import type { ReactNode } from 'react';
import { useState } from 'react';

import { clampParagraph } from '../../route/paragraph.js';
import type { RouteStopView } from '../../route/route-model.js';
import { formatCount, plural } from '../../text.js';

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
    /** Agent died during generation: filled content remains readable with a quiet note (SPEC §4.4). */
    readonly filledBeforeStop?: boolean;
    /** Value of the failed mark write. Shows "not saved · retry" beside the control. */
    readonly failedViewed?: boolean | null;
    /** The stop is highlighted by hovering over a coverage strip segment (SPEC §2.4). */
    readonly marked?: boolean;
    /** "Kept in view — outside the current filter" label (SPEC §2.7). */
    readonly keptInView?: boolean;
    readonly onCopyLink: () => void;
    readonly copyHint?: string | null;
    readonly chips: ReactNode;
    readonly diff: ReactNode;
    /** Accent line flash above the diff column after jumping to a file (README Interactions). */
    readonly flash?: boolean;
}

export function StopCard({
    view,
    stopCount,
    comments,
    viewed,
    onViewed,
    pending = false,
    filledBeforeStop = false,
    failedViewed = null,
    marked = false,
    keptInView = false,
    onCopyLink,
    copyHint = null,
    chips,
    diff,
    flash = false,
}: StopCardProps) {
    const { stop } = view;
    const tier = stop.tier;
    const unfilled = stop.status !== 'ready';

    return (
        <section
            className={`route-stop route-stop--${tier}${unfilled ? ' route-stop--unfilled' : ''}${viewed ? ' is-viewed' : ''}${marked ? ' is-marked' : ''}`}
            id={`stop-${stop.id}`}
            role="region"
            aria-label={`Stop ${view.planLabel} of ${String(stopCount)} — ${stop.title}`}
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
                    <span className="route-stop__spacer" />
                    {/* Header actions appear on hover and focus within the card (SPEC §2.9). */}
                    <button
                        type="button"
                        className="route-stop__action"
                        title="Copy link to stop"
                        onClick={onCopyLink}
                    >
                        Link
                    </button>
                    {comments === 0 ? null : (
                        <span className="route-stop__comments" title={`Comments in this stop's ranges: ${String(comments)}`}>
                            <span className="route-stop__comments-box" aria-hidden="true" />
                            {formatCount(comments)}
                        </span>
                    )}
                    <StopViewedToggle
                        viewed={viewed}
                        pending={pending}
                        unfilled={unfilled}
                        failedViewed={failedViewed}
                        onViewed={onViewed}
                    />
                </div>

                <h2 className="route-stop__title">{stop.title}</h2>

                {filledBeforeStop && !unfilled ? (
                    <p className="route-stop__filled-before">filled before the agent stopped</p>
                ) : null}

                {stop.paragraph === null ? (
                    <p className="route-stop__note">{unfilledNote(stop.status)}</p>
                ) : (
                    <Paragraph text={stop.paragraph} />
                )}

                {stop.bridge === null ? null : <p className="route-stop__bridge">{stop.bridge}</p>}

                {stop.validationNotes.length === 0 ? null : (
                    <ul className="route-stop__validation">
                        {stop.validationNotes.map((note) => (
                            <li key={note}>{note}</li>
                        ))}
                    </ul>
                )}

                {keptInView ? (
                    <p className="route-stop__kept">kept in view — outside the current filter</p>
                ) : null}
                {copyHint === null ? null : (
                    <p className="route-stop__hint" role="status">
                        {copyHint}
                    </p>
                )}

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
 * A stop's "viewed" mark (SPEC §2.10): a two-state control with `aria-pressed`,
 * with an error on failed writes beside it and a retry of the exact same action.
 *
 * A stop cannot be marked until its ranges are computed. An empty set would go
 * to the server, leaving files unread. The same applies to an unfilled stop, which has no ranges
 * at all. The mark can always be cleared because that requires no ranges.
 */
export function StopViewedToggle({
    viewed,
    pending = false,
    unfilled = false,
    failedViewed,
    onViewed,
}: {
    viewed: boolean;
    pending?: boolean;
    unfilled?: boolean;
    failedViewed: boolean | null;
    onViewed: (viewed: boolean) => void;
}) {
    const disabled = (pending || unfilled) && !viewed;
    const reason = unfilled ? 'The stop is not filled yet' : 'Stop ranges are still being computed';
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
            <button
                type="button"
                className={`route-stop__viewed${viewed ? ' is-viewed' : ''}`}
                aria-pressed={viewed}
                disabled={disabled}
                {...(disabled ? { title: reason } : {})}
                onClick={() => {
                    onViewed(!viewed);
                }}
            >
                {viewed ? '✓ Viewed' : 'Mark viewed'}
            </button>
        </>
    );
}

/** Paragraph clamped to four sentences (SPEC §2.9). */
function Paragraph({ text }: { text: string }) {
    const [full, setFull] = useState(false);
    const { head, rest } = clampParagraph(text);

    if (rest === '' || full) {
        return <p className="route-stop__paragraph">{text}</p>;
    }
    return (
        <p className="route-stop__paragraph">
            {head}{' '}
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
                ⌄
            </span>
            Collapsed · {formatCount(lines)} {plural(lines, 'line', 'lines', 'lines')} in {formatCount(files)}{' '}
            {plural(files, 'file', 'files', 'files')} · {reason}
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
                ⌄
            </span>
            {assertions === 0
                ? null
                : `${formatCount(assertions)} ${plural(assertions, 'assertion', 'assertions', 'assertions')} · `}
            {formatCount(files)} {plural(files, 'file', 'files', 'files')} · {formatCount(lines)}{' '}
            {plural(lines, 'line', 'lines', 'lines')} · viewed
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
