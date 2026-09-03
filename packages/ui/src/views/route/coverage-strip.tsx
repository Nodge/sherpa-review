import type { RouteTier } from '@sherpa/protocol';

import type { MessageKey } from '../../i18n/index.js';
import { useT } from '../../i18n/index.js';
import type { CoverageStripModel } from '../../route/coverage-model.js';
import { MIN_SEGMENT_PX } from '../../route/coverage-model.js';

/**
 * Coverage strip (SPEC §2.4, README §1, second row of the route toolbar): segments
 * are proportional to changed lines, the legend is computed, and the connection to stops
 * works both ways: hovering highlights their rulers, and clicking scrolls to them.
 *
 * The component calculates nothing: it receives the model as a prop, so the same strip renders
 * in the state gallery from a fixture.
 */

export interface CoverageStripLoading {
    /**
     * What we are waiting for: `plan` means route generation, `diff` means the plan is ready but the diff is still being parsed
     * and coverage cannot be calculated yet. Only the legend text differs.
     */
    readonly kind: 'plan' | 'diff';
    /** Completed portion: the shimmer segment has this size (SPEC §2.4 loading). */
    readonly ready: number;
    readonly total: number;
}

const LOADING_TEXT: Readonly<Record<CoverageStripLoading['kind'], MessageKey>> = {
    plan: 'coverage.loading.plan',
    diff: 'coverage.loading.diff',
};

export interface CoverageStripProps {
    /** `null` means the route is still being generated and the strip is loading. */
    readonly model: CoverageStripModel | null;
    readonly loading?: CoverageStripLoading | null;
    readonly viewedStops?: number;
    readonly totalStops?: number;
    readonly onJump?: (stopId: string) => void;
    /** Hovering over a segment highlights stops of that tier in the view. */
    readonly onHoverTier?: (tier: RouteTier | null) => void;
}

export function CoverageStrip({
    model,
    loading = null,
    viewedStops = 0,
    totalStops = 0,
    onJump,
    onHoverTier,
}: CoverageStripProps) {
    const t = useT();
    if (model === null) {
        // No denominator means no plan yet. The strip cannot be divided, so the shimmer fills the track.
        const unknown = loading === null || loading.total === 0;
        const ready = unknown ? 0 : loading.ready / loading.total;
        return (
            <div className="coverage">
                <div className="coverage__track" aria-hidden="true">
                    {unknown || ready > 0 ? (
                        <span
                            className="coverage__shimmer"
                            style={{ flexGrow: unknown ? 1 : ready, flexBasis: 0 }}
                        />
                    ) : null}
                    {unknown ? null : (
                        <span
                            className="coverage__rest"
                            style={{ flexGrow: Math.max(1 - ready, 0.001), flexBasis: 0 }}
                        />
                    )}
                </div>
                <div className="coverage__legend">
                    <span className="coverage__legend-text">{t(LOADING_TEXT[loading?.kind ?? 'plan'])}</span>
                    <span className="coverage__spacer" />
                    <StopCounter viewed={viewedStops} total={totalStops} />
                </div>
            </div>
        );
    }

    return (
        <div className="coverage">
            <div className="coverage__track" role="group" aria-label={t('coverage.aria')}>
                {model.segments.map((segment) => (
                    <button
                        key={segment.tier}
                        type="button"
                        className={`coverage__segment coverage__segment--${segment.tier}`}
                        style={{ flexGrow: segment.share, flexBasis: 0, minWidth: `${String(MIN_SEGMENT_PX)}px` }}
                        title={segment.title}
                        aria-label={segment.title}
                        disabled={segment.targetStopId === null}
                        onMouseEnter={() => {
                            onHoverTier?.(segment.tier);
                        }}
                        onMouseLeave={() => {
                            onHoverTier?.(null);
                        }}
                        onFocus={() => {
                            onHoverTier?.(segment.tier);
                        }}
                        onBlur={() => {
                            onHoverTier?.(null);
                        }}
                        onClick={() => {
                            if (segment.targetStopId !== null) {
                                onJump?.(segment.targetStopId);
                            }
                        }}
                    />
                ))}
            </div>
            <div className="coverage__legend">
                <span className="coverage__legend-text">
                    {model.legend.changed} · {model.legend.explained}
                    {model.legend.unexplained === null ? null : (
                        <>
                            {' · '}
                            <button
                                type="button"
                                className="coverage__link"
                                disabled={model.otherStopId === null}
                                onClick={() => {
                                    if (model.otherStopId !== null) {
                                        onJump?.(model.otherStopId);
                                    }
                                }}
                            >
                                {model.legend.unexplained}
                            </button>
                        </>
                    )}
                </span>
                <span className="coverage__spacer" />
                <StopCounter viewed={viewedStops} total={totalStops} />
            </div>
        </div>
    );
}

/** "viewed 3 of 7 stops" renders README §1 "N / 7 stops viewed" in the voice of the rest of the UI. */
function StopCounter({ viewed, total }: { viewed: number; total: number }) {
    const t = useT();
    if (total === 0) {
        return null;
    }
    return <span className="coverage__stops">{t('coverage.stopsViewed', viewed, total)}</span>;
}
