/**
 * Tour card placement (SPEC-onboarding-2026-09-02 §3). Pure geometry: takes a
 * target rectangle and window dimensions, returns the ring, side, card coordinates and arrow
 * offset. No DOM here, so unit tests cover all four sides and clamps.
 *
 * Formulas come from the spec. The prototype (`Sherpa.dc.html`, `tourPlace`) matches them number for number.
 * Only the arrow differs: the prototype limits its offset from the ring start to 60/40px, while the spec
 * requires the target center, and the document precedence puts the spec above the prototype.
 */

/** Ring gap around the target. */
export const TOUR_PAD = 5;
/** Distance from the ring to the card. */
export const TOUR_GAP = 14;
export const TOUR_CARD_WIDTH = 350;
/** Estimated card height used to choose the side and clamp the top. */
export const TOUR_CARD_HEIGHT = 200;

/** Comfortable vertical zone: the first step measurement scrolls the page if the target is above or below it. */
export const TOUR_SCROLL_MARGIN_TOP = 150;
export const TOUR_SCROLL_MARGIN_BOTTOM = 180;

/** Remeasurement sequence after a step starts (§3): a cold load settles after the first frame. */
export const TOUR_RETRIES_MS: readonly number[] = [340, 640, 1000, 1600, 2400, 3400];

/** Duration of scrolling to the target. An instant jump under `prefers-reduced-motion`. */
export const TOUR_SCROLL_MS = 320;

export interface TourRect {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

export interface TourViewport {
    readonly width: number;
    readonly height: number;
}

export type TourSide = 'below' | 'above' | 'right' | 'left';

export interface TourRing {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

export interface TourPlacement {
    readonly ring: TourRing;
    readonly side: TourSide;
    /** Card coordinates in the `position: fixed` coordinate system. */
    readonly left: number;
    readonly top: number;
    /** Arrow offset along the side of the card facing the target. */
    readonly beak: number;
}

/** Target has moved off screen: no ring, card centered at the bottom (§4). */
export function offscreen(rect: TourRect, viewport: TourViewport): boolean {
    return (
        rect.top + rect.height < 8 ||
        rect.top > viewport.height - 8 ||
        rect.left + rect.width < 8 ||
        rect.left > viewport.width - 8
    );
}

/**
 * The first step measurement scrolls to a target outside the comfortable zone. The target top moves to
 * `TOUR_SCROLL_MARGIN_TOP` from the viewport top. Remeasuring after scrolling must not scroll again.
 */
export function needsScroll(rect: TourRect, viewport: TourViewport): boolean {
    return rect.top < TOUR_SCROLL_MARGIN_TOP || rect.top > viewport.height - TOUR_SCROLL_MARGIN_BOTTOM;
}

/**
 * Ring around the target: target plus `pad`, clamped to the window edges. Clipping on the left does not extend
 * the ring to the right (which would offset the outline around an edge-aligned target), and height is clamped
 * to the viewport, otherwise the ring around a tall target would extend off screen.
 */
export function ringOf(rect: TourRect, viewport: TourViewport): TourRing {
    const left = Math.max(4, rect.left - TOUR_PAD);
    const top = Math.max(-2, rect.top - TOUR_PAD);
    const cutLeft = left - (rect.left - TOUR_PAD);
    return {
        left,
        top,
        width: Math.min(rect.width + TOUR_PAD * 2 - cutLeft, viewport.width - left - 4),
        height: Math.min(rect.height + TOUR_PAD * 2, viewport.height - 24),
    };
}

/** Card side: below by default, then above, right and finally left. */
export function sideOf(ring: TourRing, viewport: TourViewport): TourSide {
    if (ring.top + ring.height + TOUR_GAP + TOUR_CARD_HEIGHT < viewport.height - 12) {
        return 'below';
    }
    if (ring.top - TOUR_GAP - TOUR_CARD_HEIGHT > 12) {
        return 'above';
    }
    if (ring.left + ring.width + TOUR_GAP + TOUR_CARD_WIDTH < viewport.width - 12) {
        return 'right';
    }
    return 'left';
}

/** Full step placement: ring, side, card coordinates and arrow. */
export function placeTour(rect: TourRect, viewport: TourViewport): TourPlacement {
    const ring = ringOf(rect, viewport);
    const side = sideOf(ring, viewport);

    let left: number;
    let top: number;
    if (side === 'below') {
        left = clamp(ring.left, 16, viewport.width - TOUR_CARD_WIDTH - 16);
        top = ring.top + ring.height + TOUR_GAP;
    } else if (side === 'above') {
        left = clamp(ring.left, 16, viewport.width - TOUR_CARD_WIDTH - 16);
        top = ring.top - TOUR_GAP - TOUR_CARD_HEIGHT;
    } else if (side === 'right') {
        left = ring.left + ring.width + TOUR_GAP;
        top = ring.top;
    } else {
        left = Math.max(12, ring.left - TOUR_GAP - TOUR_CARD_WIDTH);
        top = ring.top;
    }
    top = Math.min(Math.max(14, top), Math.max(14, viewport.height - TOUR_CARD_HEIGHT - 14));

    /*
     * The arrow points at the target center (§3), not the ring center: the ring is clipped at the window edge,
     * but must still point at the middle of the target itself. The only limit is the rounded
     * card corners: the arrow stays 14px from them, even when the target center is farther away.
     */
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const beak =
        side === 'below' || side === 'above'
            ? clamp(centerX - left - 4.5, 14, TOUR_CARD_WIDTH - 23)
            : clamp(centerY - top - 4.5, 14, TOUR_CARD_HEIGHT - 23);

    return { ring, side, left, top, beak: Math.round(beak) };
}

/** Scroll easing curve, the spec's "ease-in-out cubic". */
export function easeInOutCubic(progress: number): number {
    return progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(min, value), max);
}
