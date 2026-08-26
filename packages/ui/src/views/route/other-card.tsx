import type { ReactNode } from 'react';

import type { RouteOtherView } from '../../route/route-model.js';
import { formatCount, plural } from '../../text.js';

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
    /** Files that failed to parse. Their uncovered lines are absent from the count. */
    readonly failedFiles?: number;
    readonly onRetryFailed?: () => void;
    /** Card kept on screen despite the filter (SPEC §2.7). */
    readonly keptInView?: boolean;
}

export function OtherCard({
    view,
    stopCount,
    opened,
    onOpen,
    diff,
    pending,
    failedFiles = 0,
    onRetryFailed,
    keptInView = false,
}: OtherCardProps) {
    const { lines } = view;
    const files = view.files.length;

    return (
        <section
            className="route-stop route-stop--other"
            id={`stop-${view.stop.id}`}
            role="region"
            aria-label={`Stop ${view.planLabel} of ${String(stopCount)} — ${view.stop.title}`}
        >
            <div className="route-stop__side">
                <div className="route-stop__head">
                    <span className="route-stop__rule route-stop__rule--other" aria-hidden="true" />
                    <span className="route-stop__number">
                        {view.planLabel} / {String(stopCount)}
                    </span>
                </div>
                <h2 className="route-stop__title">{view.stop.title}</h2>
                <p className="route-stop__paragraph">
                    {formatCount(lines)} {plural(lines, 'changed line', 'changed lines', 'changed lines')} in{' '}
                    {formatCount(files)} {plural(files, 'file', 'files', 'files')} were left without a stop. Coverage is
                    structurally guaranteed, so they are not lost. They collect here.
                </p>
                {keptInView ? (
                    <p className="route-stop__kept">kept in view — outside the current filter</p>
                ) : null}
            </div>

            <div className="route-stop__diff">
                <div className="route-other">
                    <p className="route-other__text">
                        The model did not place these ranges. They are <strong>not explained</strong>, not{' '}
                        <strong>unimportant</strong> — read them as a raw diff.
                    </p>
                    <div className="route-other__actions">
                        <button type="button" className="route-other__action" disabled={pending} onClick={onOpen}>
                            {pending
                                ? 'Counting the uncovered lines…'
                                : opened
                                  ? 'Collapse the uncovered ranges'
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
export function RegenerateBanner() {
    return (
        <div className="route-regenerate" role="status">
            <span className="route-regenerate__dot" aria-hidden="true" />
            the plan explains less than half of this diff — consider regenerating
        </div>
    );
}
