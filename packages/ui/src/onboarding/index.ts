/**
 * Onboarding tour (docs/design/SPEC-onboarding-2026-09-02.md). Exports three things: tour state
 * (`useTour`), its screen layer (`TourLayer`) and a placeholder for the route tab
 * when no route exists (`TourScaffold`). Geometry and the step list are pure modules covered by unit tests.
 */

export type { TourPlacement, TourRect, TourRing, TourSide, TourViewport } from './placement.js';
export {
    easeInOutCubic,
    needsScroll,
    offscreen,
    placeTour,
    ringOf,
    sideOf,
    TOUR_CARD_HEIGHT,
    TOUR_CARD_WIDTH,
    TOUR_GAP,
    TOUR_PAD,
    TOUR_RETRIES_MS,
    TOUR_SCROLL_MARGIN_BOTTOM,
    TOUR_SCROLL_MARGIN_TOP,
    TOUR_SCROLL_MS,
} from './placement.js';
export type { TourAnchorEpoch, TourStep, TourStepId } from './tour-model.js';
export {
    canonicalIndex,
    nextStep,
    prevStep,
    stepAt,
    stepAtCanonical,
    stepIndex,
    tourAnchorEpoch,
    tourStepCount,
    tourSteps,
} from './tour-model.js';
export type { TourRunOptions, TourRunState } from './tour-store.js';
export { useTourActive, useTourReplay, useTourReplayCommand, useTourRun } from './tour-store.js';
export type { TourHostProps } from './tour-host.tsx';
export { TourHost } from './tour-host.tsx';
export { TourCard } from './tour-card.tsx';
export { TourLayer } from './tour-layer.tsx';
export { TourRing as TourRingView } from './tour-ring.tsx';
export { TourScaffold } from './tour-scaffold.tsx';
