import { describe, expect, it } from 'vitest';

import { easeInOutCubic, needsScroll, offscreen, placeTour, ringOf } from './placement.js';

/**
 * Tour card geometry, docs/design/SPEC-onboarding-2026-09-02.md §3. The numbers match the reference implementation
 * (`Sherpa.dc.html`, `tourPlace`): a mismatch here is a mismatch with the design.
 */

/** Acceptance viewport: all expectations below are calculated for it. */
const VIEWPORT = { width: 1440, height: 900 };

describe('ring', () => {
    it('outlines the target with a 5px gap', () => {
        expect(ringOf({ left: 100, top: 200, width: 300, height: 100 }, VIEWPORT)).toEqual({
            left: 95,
            top: 195,
            width: 310,
            height: 110,
        });
    });

    it('does not extend the ring rightward to compensate for clipping at the left edge', () => {
        const ring = ringOf({ left: -20, top: 200, width: 100, height: 40 }, VIEWPORT);

        expect(ring.left).toBe(4);
        // 100 + 2·5 minus 29px clipped on the left: the right edge of the ring stays put.
        expect(ring.width).toBe(81);
    });

    it('clamps a tall target to the viewport so the ring stays on screen', () => {
        expect(ringOf({ left: 100, top: 0, width: 300, height: 2000 }, VIEWPORT).height).toBe(876);
    });
});

describe('card side and coordinates', () => {
    it('sits below the target by default with the arrow pointing at its center', () => {
        const placement = placeTour({ left: 100, top: 200, width: 300, height: 100 }, VIEWPORT);

        expect(placement.side).toBe('below');
        expect(placement.left).toBe(95);
        expect(placement.top).toBe(319);
        // Target center is 250, minus the card left edge and half the arrow.
        expect(placement.beak).toBe(151);
    });

    it('sits above the target when there is no room below', () => {
        const placement = placeTour({ left: 100, top: 700, width: 300, height: 150 }, VIEWPORT);

        expect(placement.side).toBe('above');
        expect(placement.top).toBe(481);
        expect(placement.beak).toBe(151);
    });

    it('points at the center of a wide target rather than the ring edge', () => {
        // Coverage bar spanning the view width: the center is far from the target start.
        const placement = placeTour({ left: 40, top: 120, width: 1200, height: 40 }, VIEWPORT);

        expect(placement.side).toBe('below');
        expect(placement.left).toBe(35);
        // Center is 640. The arrow reaches the far card clamp instead of staying at its left corner.
        expect(placement.beak).toBe(327);
    });

    it('moves right of a tall target and points at its center as far as the rounded corners allow', () => {
        const placement = placeTour({ left: 100, top: 0, width: 300, height: 880 }, VIEWPORT);

        expect(placement.side).toBe('right');
        expect(placement.left).toBe(419);
        // Card top is clamped 14px from the window edge. Target center is below its bottom, so the arrow hits the lower clamp.
        expect(placement.top).toBe(14);
        expect(placement.beak).toBe(177);
    });

    it('moves left when there is no room on the right', () => {
        const placement = placeTour({ left: 1100, top: 0, width: 300, height: 880 }, VIEWPORT);

        expect(placement.side).toBe('left');
        expect(placement.left).toBe(731);
        expect(placement.beak).toBe(177);
    });

    it('still points at the target when the card is against the right edge', () => {
        const placement = placeTour({ left: 1300, top: 100, width: 100, height: 50 }, VIEWPORT);

        expect(placement.side).toBe('below');
        // 1440 − 350 − 16: the card cannot move any farther right.
        expect(placement.left).toBe(1074);
        expect(placement.beak).toBe(272);
    });

    it('never places the arrow beyond the rounded corners of the card', () => {
        const nearLeft = placeTour({ left: 0, top: 200, width: 20, height: 20 }, VIEWPORT);
        const farRight = placeTour({ left: 1439, top: 200, width: 1, height: 20 }, VIEWPORT);

        expect(nearLeft.beak).toBeGreaterThanOrEqual(14);
        expect(farRight.beak).toBeLessThanOrEqual(327);
    });
});

describe('scrolling to the target', () => {
    it('scrolls only when the target is outside the comfortable zone', () => {
        expect(needsScroll({ left: 0, top: 100, width: 10, height: 10 }, VIEWPORT)).toBe(true);
        expect(needsScroll({ left: 0, top: 800, width: 10, height: 10 }, VIEWPORT)).toBe(true);
        expect(needsScroll({ left: 0, top: 300, width: 10, height: 10 }, VIEWPORT)).toBe(false);
    });

    it('a target outside the window uses fallback placement without a ring', () => {
        expect(offscreen({ left: 100, top: 910, width: 10, height: 10 }, VIEWPORT)).toBe(true);
        expect(offscreen({ left: 100, top: -20, width: 10, height: 10 }, VIEWPORT)).toBe(true);
        expect(offscreen({ left: 1450, top: 100, width: 10, height: 10 }, VIEWPORT)).toBe(true);
        expect(offscreen({ left: 100, top: 100, width: 10, height: 10 }, VIEWPORT)).toBe(false);
    });

    it('uses a symmetric scroll easing curve that reaches both endpoints', () => {
        expect(easeInOutCubic(0)).toBe(0);
        expect(easeInOutCubic(1)).toBe(1);
        expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
        expect(easeInOutCubic(0.25)).toBeCloseTo(1 - easeInOutCubic(0.75), 10);
    });
});
