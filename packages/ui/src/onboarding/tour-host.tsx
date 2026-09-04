import { TourLayer } from './tour-layer.tsx';
import type { TourRunOptions } from './tour-store.js';
import { useTourRun } from './tour-store.js';

/**
 * Tour host: mounted while the tour runs, holds the pass state (the current step). Mounting
 * starts the pass, reading the starting step from settings in the state initializer.
 *
 * Separate from `TourLayer` (ring, card, measurement), so the layer knows nothing about persistence
 * and renders from props in the state gallery.
 */
export interface TourHostProps extends TourRunOptions {
    /** See `TourLayerProps.epoch`. */
    readonly epoch: string;
}

export function TourHost({ epoch, ...options }: TourHostProps) {
    const run = useTourRun(options);
    return (
        <TourLayer
            step={run.step}
            index={run.index}
            total={run.steps.length}
            epoch={epoch}
            onNext={run.next}
            onBack={run.back}
            onSkip={run.skip}
        />
    );
}
