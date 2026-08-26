import type { RouteSnapshot, UiRouteFailure, UiRouteState } from '@sherpa/protocol';
import { useState } from 'react';

import { generationCardKind, generationProgress } from '../../route/generation.js';
import { formatCount, plural } from '../../text.js';
import './generation.css';

/**
 * Route generation states in the Overview right rail (README §6–7) and the red failure
 * card (README §12, SPEC §2.21).
 *
 * Components load nothing: the phase, snapshot and flags arrive as props, so the same cards
 * render in the state gallery. All counts come from `snapshot.stops[].status`.
 */

export interface GenerationCardProps {
    readonly route: UiRouteState;
    /** Files in the diff for the phase A progress line. `null` until the diff arrives. */
    readonly diffFiles?: number | null;
    /** Generation has run for over a minute: "still working" line with cancellation (SPEC §3). */
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
    const kind = generationCardKind(route);
    if (kind === 'failed' && route.failure !== null) {
        return (
            <RouteFailedCard
                failure={route.failure}
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
            <section className="gen-card" aria-label="Route generation">
                <div className="gen-card__head">
                    <h2 className="gen-card__title">
                        Route ready · {formatCount(stops)}{' '}
                        {plural(stops, 'stop', 'stops', 'stops')}
                    </h2>
                </div>
                <button type="button" className="gen-card__cta" onClick={onOpenRoute}>
                    Open the route
                </button>
            </section>
        );
    }

    if (kind === 'filling' && snapshot !== null) {
        const progress = generationProgress(snapshot);
        const rest = progress.total - progress.ready;
        return (
            <section className="gen-card" aria-label="Route generation">
                <div className="gen-card__head">
                    <h2 className="gen-card__title">Filling the route</h2>
                    <span className="gen-card__counter">
                        {formatCount(progress.ready)} of {formatCount(progress.total)} ready
                    </span>
                </div>

                <div className="gen-bar" aria-hidden="true">
                    {progress.slots.map((slot) => (
                        <span key={slot.id} className={`gen-bar__segment gen-bar__segment--${slot.status}`} />
                    ))}
                </div>

                <p className="gen-card__note">
                    The plan is fixed — stops are validated independently and light up out of order.
                </p>

                <ul className="gen-plan">
                    {progress.slots.map((slot) => (
                        <li key={slot.id} className={`gen-plan__item gen-plan__item--${slot.status}`}>
                            <span className="gen-plan__number">{slot.planLabel}</span>
                            <span className="gen-plan__title">{slot.title}</span>
                            <span className="gen-plan__state">{PLAN_STATE[slot.status]}</span>
                        </li>
                    ))}
                </ul>

                {longRunning ? (
                    <StillWorking
                        counter={`${formatCount(progress.ready)} of ${formatCount(progress.total)}`}
                        cancelling={cancelling}
                        onCancel={onCancel}
                    />
                ) : null}

                <button type="button" className="gen-card__cta" onClick={onOpenRoute}>
                    Open the route
                </button>
                <p className="gen-card__hint">
                    {formatCount(progress.ready)} {plural(progress.ready, 'stop', 'stops', 'stops')}{' '}
                    are ready to read, {formatCount(rest)} are{' '}
                    {plural(rest, 'placeholder', 'placeholders', 'placeholders')}
                </p>
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
        <section className="gen-card" aria-label="Route generation">
            <div className="gen-card__head">
                <span className="gen-card__spinner" aria-hidden="true" />
                <h2 className="gen-card__title">Reading the diff, planning the route</h2>
                <span className="gen-card__counter">~40 c</span>
            </div>

            <ol className="gen-steps">
                <li className="gen-steps__item is-active">
                    {diffFiles === null
                        ? 'Reading the entire diff'
                        : `Reading all ${formatCount(diffFiles)} ${plural(diffFiles, 'file', 'files', 'files')} in the diff`}
                </li>
                <li className="gen-steps__item">Deciding how many stops to make and in what order</li>
                <li className="gen-steps__item">Filling stops one at a time</li>
            </ol>

            <p className="gen-card__note">
                The plan comes first. Until it exists, there is no stop count to show. The diff is already open below. Nothing
                waits for the agent.
            </p>

            {longRunning ? <StillWorking counter={null} cancelling={cancelling} onCancel={onCancel} /> : null}

            <button type="button" className="gen-card__cta" onClick={onOpenRoute}>
                Open the route skeleton
            </button>
            <p className="gen-card__hint">placeholders for now, stops appear as they become ready</p>
            {actionError === null ? null : (
                <p className="gen-card__error" role="status">
                    {actionError}
                </p>
            )}
        </section>
    );
}

/** Task running for over a minute (SPEC §3): an honest status line and cancellation. */
function StillWorking({
    counter,
    cancelling,
    onCancel,
}: {
    counter: string | null;
    cancelling: boolean;
    onCancel: () => void;
}) {
    return (
        <p className="gen-card__still" role="status">
            still working{counter === null ? '' : ` · ${counter}`}
            <button type="button" className="gen-card__cancel" disabled={cancelling} onClick={onCancel}>
                {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
        </p>
    );
}

export interface RouteFailedCardProps {
    readonly failure: UiRouteFailure;
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
 * Generation failed (README §12): a one-sentence reason, retry and raw model output.
 *
 * The handoff hint to "fix anchors and revalidate without the model" does not apply: revalidating
 * edited output is not implemented in M2, and `rawOutput` is skeleton output, whose schema has no anchors.
 */
export function RouteFailedCard({
    failure,
    retrying = false,
    actionError = null,
    onRetry,
    onOpenDiff,
    compact = false,
    initialRawShown = false,
}: RouteFailedCardProps) {
    const [rawShown, setRawShown] = useState(initialRawShown);
    const raw = failure.rawOutput;

    return (
        <section
            className={`gen-failed${compact ? ' gen-failed--compact' : ''}`}
            role="region"
            aria-label="Route generation failed"
        >
            <h2 className="gen-failed__title">Route generation failed</h2>
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
                        {rawShown ? 'Hide the raw output' : 'Show the raw output'}
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
                    The reader below is untouched, the full diff is available.
                    <button type="button" className="gen-failed__link" onClick={onOpenDiff}>
                        Read the full diff
                    </button>
                </p>
            )}
        </section>
    );
}

/**
 * Partially filled route banner (README §8). A condition banner: stays while
 * the route is being filled. Counts come from snapshot slot statuses.
 */
export function RouteFillingBanner({
    snapshot,
    onReadDiff,
}: {
    snapshot: RouteSnapshot;
    onReadDiff: () => void;
}) {
    const progress = generationProgress(snapshot);
    return (
        <div className="gen-filling" role="status">
            <span className="gen-filling__dot" aria-hidden="true" />
            <span className="gen-filling__text">
                Filling the route · {formatCount(progress.ready)} of {formatCount(progress.total)}{' '}
                {plural(progress.total, 'stop ready', 'stops ready', 'stops ready')} · stops
                appear out of order
            </span>
            <button type="button" className="gen-filling__link" onClick={onReadDiff}>
                Meanwhile you can read the full diff →
            </button>
        </div>
    );
}

/** Generation failure banner: priority 400, above the disconnected agent (SPEC §2.21). */
export function GenerationFailedBanner({
    message,
    retrying = false,
    onRetry,
}: {
    message: string;
    retrying?: boolean;
    onRetry: () => void;
}) {
    return (
        <div className="gen-banner" role="region" aria-label="Route generation failed">
            <span className="gen-banner__dot" aria-hidden="true" />
            <div className="gen-banner__body">
                <div className="gen-banner__title">Route generation failed.</div>
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
    return (
        <div className="gen-banner gen-banner--plain" role="status" aria-label="Route action failed">
            <span className="gen-banner__dot" aria-hidden="true" />
            <div className="gen-banner__body">
                <div className="gen-banner__title">Route action failed.</div>
                <div className="gen-banner__text">{message}</div>
            </div>
        </div>
    );
}

/** Loading retry button: the glyph spins in place without changing width (SPEC §1.1). */
function RetryButton({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
    return (
        <button type="button" className="gen-retry" disabled={retrying} onClick={onRetry}>
            <span className={`gen-retry__glyph${retrying ? ' is-spinning' : ''}`} aria-hidden="true" />
            Retry
        </button>
    );
}

const PLAN_STATE: Readonly<Record<'queued' | 'filling' | 'ready' | 'failed', string>> = {
    ready: '✓ ready',
    filling: 'filling',
    queued: 'queued',
    failed: 'unfilled',
};
