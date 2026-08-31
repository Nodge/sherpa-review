import type { ReactNode } from 'react';

import { stripInlineCode } from '../../markdown/markdown.js';
import { Markdown } from '../../markdown/markdown.tsx';
import type { RouteOtherView } from '../../route/route-model.js';
import { formatCount, plural } from '../../text.js';
import { StopViewedToggle } from './stop-card.tsx';

/**
 * "Other — lines the model did not place" (README §2): a hatched card with honest
 * copy and a single action to expand uncovered ranges as a raw diff.
 *
 * The UI calculates its contents: all changed lines minus the union of all stop
 * anchors. The snapshot does not and cannot contain it (route contract invariant).
 */

export interface OtherCardProps {
    /** The view is already narrowed by the current filter. Counts must match what expands. */
    readonly view: RouteOtherView;
    readonly stopCount: number;
    readonly opened: boolean;
    readonly onOpen: () => void;
    /** Expanded cards for uncovered ranges, assembled by the view. */
    readonly diff: ReactNode;
    /** Uncovered ranges are still being counted because some diff files have not been parsed. */
    readonly pending: boolean;
    /** Some files failed to parse, so their uncovered ranges are missing and Other cannot be marked. */
    readonly parseFailed?: boolean;
    /**
     * The route is still filling (README §8): uncovered ranges are currently unoccupied plan slots,
     * rather than the model's decision. Counts become accurate once the stops arrive.
     */
    readonly filling?: boolean;
    /** Files that failed to parse. Their uncovered lines are absent from the count. */
    readonly failedFiles?: number;
    readonly onRetryFailed?: () => void;
    /** Card kept on screen despite the filter (SPEC §2.7). */
    readonly keptInView?: boolean;
    /**
     * Other is a route stop too: marking it writes uncovered ranges into progress
     * (README §13 «Other read as raw diff»).
     */
    readonly viewed?: boolean;
    readonly onViewed?: (viewed: boolean) => void;
    readonly failedViewed?: boolean | null;
    /** Accent line flash after navigating to Other. */
    readonly flash?: boolean;
    /** Highlight from hovering over the hatched coverage strip segment (SPEC §2.4). */
    readonly marked?: boolean;
}

export function OtherCard({
    view,
    stopCount,
    opened,
    onOpen,
    diff,
    pending,
    parseFailed = false,
    filling = false,
    failedFiles = 0,
    onRetryFailed,
    keptInView = false,
    viewed = false,
    onViewed,
    failedViewed = null,
    flash = false,
    marked = false,
}: OtherCardProps) {
    const { lines } = view;
    const files = view.files.length;

    return (
        <section
            className={`route-stop route-stop--other${viewed ? ' is-viewed' : ''}${marked ? ' is-marked' : ''}`}
            id={`stop-${view.stop.id}`}
            role="region"
            aria-label={`Stop ${view.planLabel} of ${String(stopCount)} — ${stripInlineCode(view.stop.title)}`}
        >
            <div className="route-stop__side">
                <div className="route-stop__head">
                    <span className="route-stop__rule route-stop__rule--other" aria-hidden="true" />
                    <span className="route-stop__number">
                        {view.planLabel} / {String(stopCount)}
                    </span>
                    <span className="route-stop__spacer" />
                    {onViewed === undefined ? null : (
                        <StopViewedToggle
                            viewed={viewed}
                            pending={pending}
                            parseFailed={parseFailed}
                            unfilled={filling}
                            failedViewed={failedViewed}
                            onViewed={onViewed}
                        />
                    )}
                </div>
                <h2 className="route-stop__title">
                    <Markdown text={view.stop.title} profile="route" />
                </h2>
                {filling ? (
                    <p className="route-stop__paragraph">
                        The route is still filling. For now, everything the agent has not reached goes here.
                        What actually remains without a stop will become clear when the plan is filled.
                    </p>
                ) : pending ? (
                    <p className="route-stop__paragraph">
                        The diff is still being parsed. The number of lines left without a stop is unknown yet. Coverage is
                        structurally guaranteed: whatever misses the stops collects here.
                    </p>
                ) : (
                    <p className="route-stop__paragraph">
                        {formatCount(lines)}{' '}
                        {plural(lines, 'changed line', 'changed lines', 'changed lines')} in{' '}
                        {formatCount(files)} {plural(files, 'file', 'files', 'files')} left without a stop.
                        Coverage is structurally guaranteed, so they are not lost and collect here.
                    </p>
                )}
                {keptInView ? (
                    <p className="route-stop__kept">kept in view — outside the current filter</p>
                ) : null}
            </div>

            <div className="route-stop__diff">
                {flash ? <div className="route-stop__flash" aria-hidden="true" /> : null}
                <div className="route-other">
                    <p className="route-other__text">
                        {filling ? (
                            'This slot counts the remainder. While stops are arriving, it is too early to call it "not explained".'
                        ) : (
                            <>
                                The model did not place these ranges. They are <strong>not explained</strong>, not{' '}
                                <strong>unimportant</strong>. Read them as a raw diff.
                            </>
                        )}
                    </p>
                    <div className="route-other__actions">
                        <button
                            type="button"
                            className="route-other__action"
                            disabled={pending || filling}
                            onClick={onOpen}
                        >
                            {filling
                                ? 'Waiting for the route to fill'
                                : pending
                                  ? 'Counting uncovered lines…'
                                  : opened
                                    ? 'Collapse uncovered ranges'
                                    : `Open ${formatCount(lines)} ${plural(lines, 'line', 'lines', 'lines')}`}
                        </button>
                    </div>
                    {failedFiles === 0 ? null : (
                        <p className="route-other__failed" role="status">
                            {formatCount(failedFiles)} {plural(failedFiles, 'file', 'files', 'files')} failed
                            to parse. Their uncovered lines are not counted.
                            {onRetryFailed === undefined ? null : (
                                <button type="button" className="route-other__retry" onClick={onRetryFailed}>
                                    Retry the parse
                                </button>
                            )}
                        </p>
                    )}
                </div>
                {opened ? diff : null}
            </div>
        </section>
    );
}

/** SPEC §4.3 banner: the plan explains less than half the diff. */
export function RegenerateBanner({ onGenerate }: { readonly onGenerate?: () => void }) {
    return (
        <div className="route-regenerate" role="status">
            <span className="route-regenerate__dot" aria-hidden="true" />
            <span className="route-regenerate__text">
                the plan explains less than half of this diff — consider regenerating
            </span>
            {onGenerate === undefined ? null : (
                <button type="button" className="route-regenerate__action" onClick={onGenerate}>
                    Regenerate
                </button>
            )}
        </div>
    );
}
