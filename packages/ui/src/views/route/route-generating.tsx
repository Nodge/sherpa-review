import type { UiRouteFailure } from '@sherpa/protocol';

import { useT } from '../../i18n/index.js';
import { CoverageStrip } from './coverage-strip.tsx';
import { RouteFailedCard } from './generation-card.tsx';
import { StopSkeleton } from './stop-card.tsx';
import './route.css';
import './generation.css';

/**
 * The "Route" tab in phases where no route exists yet (or anymore): reading-phase skeleton (README §8),
 * red failure card (README §12) and small-PR explanation (SPEC §4.1).
 *
 * None of the three loads anything. The state gallery renders them as they are.
 */

/**
 * Reading phase: three unnumbered `— / ?` placeholders. Numbers are absent on purpose. The plan is not ready,
 * and the stop count is unknown (README §6, last sentence of §8).
 */
export function RouteReadingView({ onOpenDiff }: { onOpenDiff: () => void }) {
    const t = useT();
    return (
        <main className="route route--skeleton" id="view-route">
            <div className="route-skeleton__bar">
                <CoverageStrip model={null} loading={{ kind: 'plan', ready: 0, total: 0 }} />
            </div>

            <div className="route__stops">
                {PLACEHOLDERS.map((key) => (
                    <section key={key} className="route-stop route-stop--unfilled" aria-hidden="true">
                        <div className="route-stop__side">
                            <div className="route-stop__head">
                                <span className="route-stop__rule" />
                                <span className="route-stop__number">— / ?</span>
                                <span className="route-stop__badge route-stop__badge--queued">{t('route.gen.plan.queued')}</span>
                            </div>
                            <div className="route-skeleton__title" />
                            <div className="route-skeleton__line" />
                            <div className="route-skeleton__line route-skeleton__line--short" />
                        </div>
                        <div className="route-stop__diff">
                            <StopSkeleton />
                        </div>
                    </section>
                ))}

                <p className="route-skeleton__note">
                    {t('route.gen.planning.note')}
                    <button type="button" className="route-skeleton__link" onClick={onOpenDiff}>
                        {t('route.readFullDiff')}
                    </button>
                </p>
            </div>
        </main>
    );
}

/** Route tab in the `failed` phase: a red card instead of stops. */
export function RouteFailedView({
    failure,
    retrying = false,
    actionError = null,
    initialRawShown = false,
    onRetry,
    onOpenDiff,
}: {
    failure: UiRouteFailure;
    retrying?: boolean;
    actionError?: string | null;
    /** Expand raw output immediately, only for the state gallery. */
    initialRawShown?: boolean;
    onRetry: () => void;
    onOpenDiff: () => void;
}) {
    return (
        <main className="route-empty" id="view-route">
            <div className="gen-failed-wrap">
                <RouteFailedCard
                    failure={failure}
                    retrying={retrying}
                    actionError={actionError}
                    initialRawShown={initialRawShown}
                    onRetry={onRetry}
                    onOpenDiff={onOpenDiff}
                />
            </div>
        </main>
    );
}

const PLACEHOLDERS = ['a', 'b', 'c'] as const;
