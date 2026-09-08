import type { TourRing as TourRingGeometry } from './placement.js';

/**
 * Ring around the highlighted element (docs/design/SPEC-onboarding-2026-09-02.md §1). Intercepts nothing:
 * `pointer-events: none`, clicking the outlined element works and does not close the tour (§4).
 */
export function TourRing({ ring }: { ring: TourRingGeometry }) {
    return (
        <div
            className="tour-ring"
            aria-hidden="true"
            style={{
                left: `${String(Math.round(ring.left))}px`,
                top: `${String(Math.round(ring.top))}px`,
                width: `${String(Math.round(ring.width))}px`,
                height: `${String(Math.round(ring.height))}px`,
            }}
        />
    );
}
