import type { RouteSnapshot, UiRouteFailure, UiRouteState } from '@sherpa/protocol';
import { useState } from 'react';

import type { MessageKey } from '../../i18n/index.js';
import { useT } from '../../i18n/index.js';
import { Icon } from '../../icons/icon.tsx';
import { Markdown } from '../../markdown/markdown.tsx';
import { generationCardKind, generationProgress } from '../../route/generation.js';
import './generation.css';

/**
 * Route generation states in the Overview right rail (docs/design/README.md §6–7) and the red failure
 * card (docs/design/README.md §12, docs/design/SPEC-elements.md §2.21).
 *
 * Components load nothing: the phase, snapshot and flags arrive as props, so the same cards
 * render in the state gallery. All counts come from `snapshot.stops[].status`.
 */

export interface GenerationCardProps {
    readonly route: UiRouteState;
    /** Files in the diff for the phase A progress line. `null` until the diff arrives. */
    readonly diffFiles?: number | null;
    /** Generation has run for over a minute: the "still working" line with cancellation (docs/design/SPEC-elements.md §3). */
    readonly longRunning?: boolean;
    readonly cancelling?: boolean;
    readonly retrying?: boolean;
    /** Endpoint failure (network, server), separate from generation failure. */
    readonly actionError?: string | null;
    readonly onOpenRoute: () => void;
    readonly onOpenDiff: () => void;
    readonly onRetry: () => void;
    readonly onCancel: () => void;
}

/** `null` means the generation card has nothing to say in this phase (generation has never started). */
export function GenerationCard({
    route,
    diffFiles = null,
    longRunning = false,
    cancelling = false,
    retrying = false,
    actionError = null,
    onOpenRoute,
    onOpenDiff,
    onRetry,
    onCancel,
}: GenerationCardProps) {
    const t = useT();
    const kind = generationCardKind(route);
    if (kind === 'failed' && route.failure !== null) {
        return (
            <RouteFailedCard
                failure={route.failure}
                rebuilding={route.snapshot !== null}
                retrying={retrying}
                actionError={actionError}
                onRetry={onRetry}
                onOpenDiff={onOpenDiff}
                compact
            />
        );
    }

    const snapshot = route.snapshot;
    if (kind === 'ready' && snapshot !== null) {
        const stops = snapshot.stops.length;
        return (
            <section className="gen-card" aria-label={t('route.gen.aria')}>
                <div className="gen-card__head">
                    <h2 className="gen-card__title">{t('route.gen.ready', stops)}</h2>
                </div>
                <button type="button" className="gen-card__cta" onClick={onOpenRoute}>
                    {t('route.gen.open')}
                </button>
            </section>
        );
    }

    if (kind === 'filling' && snapshot !== null) {
        const progress = generationProgress(snapshot);
        const rest = progress.total - progress.ready;
        return (
            <section className="gen-card" aria-label={t('route.gen.aria')}>
                <div className="gen-card__head">
                    <h2 className="gen-card__title">{t('route.gen.filling.title')}</h2>
                    <span className="gen-card__counter">
                        {t('route.gen.filling.counter', progress.ready, progress.total)}
                    </span>
                </div>

                <div className="gen-bar" aria-hidden="true">
                    {progress.slots.map((slot) => (
                        <span key={slot.id} className={`gen-bar__segment gen-bar__segment--${slot.status}`} />
                    ))}
                </div>

                <p className="gen-card__note">{t('route.gen.filling.note')}</p>

                <ul className="gen-plan">
                    {progress.slots.map((slot) => (
                        <li key={slot.id} className={`gen-plan__item gen-plan__item--${slot.status}`}>
                            <span className="gen-plan__number">{slot.planLabel}</span>
                            <span className="gen-plan__title">
                                <Markdown text={slot.title} profile="route" />
                            </span>
                            <span className="gen-plan__state">
                                {slot.status === 'ready' ? <Icon name="check" size={13} /> : null}
                                {t(PLAN_STATE[slot.status])}
                            </span>
                        </li>
                    ))}
                </ul>

                {longRunning ? (
                    <StillWorking
                        counter={t('route.gen.counter', progress.ready, progress.total)}
                        cancelling={cancelling}
                        onCancel={onCancel}
                    />
                ) : null}

                <button type="button" className="gen-card__cta" onClick={onOpenRoute}>
                    {t('route.gen.open')}
                </button>
                <p className="gen-card__hint">{t('route.gen.filling.hint', progress.ready, rest)}</p>
                {actionError === null ? null : (
                    <p className="gen-card__error" role="status">
                        {actionError}
                    </p>
                )}
            </section>
        );
    }

    if (kind !== 'reading') {
        return null;
    }

    return (
        <section className="gen-card" aria-label={t('route.gen.aria')}>
            <div className="gen-card__head">
                <span className="gen-card__spinner" aria-hidden="true" />
                <h2 className="gen-card__title">
                    {snapshot === null ? t('route.gen.reading.title') : t('route.gen.rebuild.title')}
                </h2>
                <span className="gen-card__counter">{t('route.gen.eta')}</span>
            </div>

            <ol className="gen-steps">
                <li className="gen-steps__item is-active">
                    {diffFiles === null ? t('route.gen.step.diff') : t('route.gen.step.diffFiles', diffFiles)}
                </li>
                <li className="gen-steps__item">{t('route.gen.step.plan')}</li>
                <li className="gen-steps__item">{t('route.gen.step.fill')}</li>
            </ol>

            <p className="gen-card__note">
                {snapshot === null ? t('route.gen.reading.note') : t('route.gen.rebuild.note')}
            </p>

            {longRunning ? <StillWorking counter={null} cancelling={cancelling} onCancel={onCancel} /> : null}

            <button type="button" className="gen-card__cta" onClick={onOpenRoute}>
                {snapshot === null ? t('route.gen.open.skeleton') : t('route.gen.open.previous')}
            </button>
            <p className="gen-card__hint">
                {snapshot === null ? t('route.gen.reading.hint') : t('route.gen.rebuild.hint')}
            </p>
            {actionError === null ? null : (
                <p className="gen-card__error" role="status">
                    {actionError}
                </p>
            )}
        </section>
    );
}

/** The task has run for over a minute (docs/design/SPEC-elements.md §3): an accurate status line and cancellation. */
function StillWorking({
    counter,
    cancelling,
    onCancel,
}: {
    counter: string | null;
    cancelling: boolean;
    onCancel: () => void;
}) {
    const t = useT();
    return (
        <p className="gen-card__still" role="status">
            {t('route.gen.still')}
            {counter === null ? '' : ` · ${counter}`}
            <button type="button" className="gen-card__cancel" disabled={cancelling} onClick={onCancel}>
                {cancelling ? t('route.gen.cancelling') : t('route.gen.cancel')}
            </button>
        </p>
    );
}

export interface RouteFailedCardProps {
    readonly failure: UiRouteFailure;
    readonly rebuilding?: boolean;
    readonly retrying?: boolean;
    readonly actionError?: string | null;
    readonly onRetry: () => void;
    readonly onOpenDiff: () => void;
    /** Overview rail variant without raw output or a footer. Those live on the route tab. */
    readonly compact?: boolean;
    /** Raw output expanded from the start for a deterministic state gallery frame. */
    readonly initialRawShown?: boolean;
}

/**
 * Generation failed (docs/design/README.md §12): a one-sentence reason, retry and the model's raw output.
 *
 * The design's "fix anchors and revalidate without the model" hint is omitted: revalidating
 * edited output is not implemented, and `rawOutput` is skeleton output, whose schema has no anchors.
 */
export function RouteFailedCard({
    failure,
    rebuilding = false,
    retrying = false,
    actionError = null,
    onRetry,
    onOpenDiff,
    compact = false,
    initialRawShown = false,
}: RouteFailedCardProps) {
    const t = useT();
    const [rawShown, setRawShown] = useState(initialRawShown);
    const raw = failure.rawOutput;

    return (
        <section
            className={`gen-failed${compact ? ' gen-failed--compact' : ''}`}
            role="region"
            aria-label={rebuilding ? t('route.failed.title.rebuild') : t('route.failed.title')}
        >
            <h2 className="gen-failed__title">
                {rebuilding ? t('route.failed.title.rebuild') : t('route.failed.title')}
            </h2>
            <p className="gen-failed__reason">{failure.message}</p>

            <div className="gen-failed__actions">
                <RetryButton retrying={retrying} onRetry={onRetry} />
                {compact || raw === null ? null : (
                    <button
                        type="button"
                        className="gen-failed__secondary"
                        aria-expanded={rawShown}
                        onClick={() => {
                            setRawShown(!rawShown);
                        }}
                    >
                        {rawShown ? t('route.failed.hideRaw') : t('route.failed.showRaw')}
                    </button>
                )}
            </div>

            {actionError === null ? null : (
                <p className="gen-failed__error" role="status">
                    {actionError}
                </p>
            )}

            {rawShown && raw !== null ? <pre className="gen-failed__raw">{raw}</pre> : null}

            {compact ? null : (
                <p className="gen-failed__footer">
                    {t('route.failed.footer')}
                    <button type="button" className="gen-failed__link" onClick={onOpenDiff}>
                        {t('route.readFullDiff')}
                    </button>
                </p>
            )}
        </section>
    );
}

/**
 * Partially filled route banner (docs/design/README.md §8). A condition banner that stays while
 * the route is being filled. Counts come from snapshot slot statuses.
 */
export function RouteFillingBanner({
    snapshot,
    onReadDiff,
}: {
    snapshot: RouteSnapshot;
    onReadDiff: () => void;
}) {
    const t = useT();
    const progress = generationProgress(snapshot);
    return (
        <div className="gen-filling" role="status">
            <span className="gen-filling__dot" aria-hidden="true" />
            <span className="gen-filling__text">{t('route.filling.banner', progress.ready, progress.total)}</span>
            <button type="button" className="gen-filling__link" onClick={onReadDiff}>
                {t('route.filling.readDiff')}
            </button>
        </div>
    );
}

/** Rebuilding a ready route: the old route stays usable until the new plan is accepted. */
export function RouteRegeneratingBanner({
    cancelling = false,
    onCancel,
}: {
    cancelling?: boolean;
    onCancel: () => void;
}) {
    const t = useT();
    return (
        <div className="gen-filling" role="status">
            <span className="gen-filling__dot" aria-hidden="true" />
            <span className="gen-filling__text">{t('route.regenerating.text')}</span>
            <button type="button" className="gen-filling__link" disabled={cancelling} onClick={onCancel}>
                {cancelling ? t('route.gen.cancelling') : t('route.gen.cancel')}
            </button>
        </div>
    );
}

/** Generation failure banner: highest priority in the slot (docs/design/SPEC-elements.md §2.21). */
export function GenerationFailedBanner({
    message,
    rebuilding = false,
    retrying = false,
    onRetry,
}: {
    message: string;
    rebuilding?: boolean;
    retrying?: boolean;
    onRetry: () => void;
}) {
    const t = useT();
    return (
        <div className="gen-banner" role="region" aria-label={t('route.failed.banner.aria')}>
            <span className="gen-banner__dot" aria-hidden="true" />
            <div className="gen-banner__body">
                <div className="gen-banner__title">
                    {rebuilding ? t('route.failed.banner.title.rebuild') : t('route.failed.banner.title')}
                </div>
                <div className="gen-banner__text">{message}</div>
            </div>
            <RetryButton retrying={retrying} onRetry={onRetry} />
        </div>
    );
}

/**
 * The generation endpoint failed: network, missing host adapter, small PR threshold.
 *
 * The reason usually appears beside the button that triggered it, in the red route card or
 * the Overview generation card. But "Build a route" is also available in the palette, on any tab
 * and in phases where neither card is on screen. Without the slot, such a request would fail
 * silently.
 */
export function RouteActionErrorBanner({ message }: { message: string }) {
    const t = useT();
    return (
        <div className="gen-banner gen-banner--plain" role="status" aria-label={t('route.actionFailed.aria')}>
            <span className="gen-banner__dot" aria-hidden="true" />
            <div className="gen-banner__body">
                <div className="gen-banner__title">{t('route.actionFailed.title')}</div>
                <div className="gen-banner__text">{message}</div>
            </div>
        </div>
    );
}

/** Loading retry button: the glyph spins in place and the width stays fixed (docs/design/SPEC-elements.md §1.1). */
function RetryButton({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
    const t = useT();
    return (
        <button type="button" className="gen-retry" disabled={retrying} onClick={onRetry}>
            <span className={`gen-retry__glyph${retrying ? ' is-spinning' : ''}`} aria-hidden="true" />
            {t('route.gen.retry')}
        </button>
    );
}

const PLAN_STATE: Readonly<Record<'queued' | 'filling' | 'ready' | 'failed', MessageKey>> = {
    ready: 'route.gen.plan.ready',
    filling: 'route.gen.plan.filling',
    queued: 'route.gen.plan.queued',
    failed: 'route.gen.plan.failed',
};
