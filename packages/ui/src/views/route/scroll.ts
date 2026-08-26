/**
 * Scrolling within the route (README, "Interactions & behaviour"): clicking a file chip goes
 * to its card in ~320ms with a −150px offset from the target's top. Use container `scrollTop`
 * because `scrollIntoView` offers no duration, offset or cancellation.
 */

/** Offset from the top edge keeps the target clear of the sticky toolbar. */
export const JUMP_OFFSET = 150;

/** README «Motion»: jump scroll ~320ms ease-in-out cubic. */
export const JUMP_DURATION = 320;

/** ease-in-out cubic, the same profile as `--motion-jump-ease`. */
export function easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Container scroll position that places the target `JUMP_OFFSET` below its top edge. */
export function targetScrollTop(container: HTMLElement, target: HTMLElement): number {
    const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const top = container.scrollTop + delta - JUMP_OFFSET;
    return Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
}

/** Stop section in viewport coordinates, exactly what anchor selection needs. */
export interface StopBox {
    readonly stopId: string;
    readonly top: number;
    readonly bottom: number;
}

/** Scroll anchor: stop and its offset from the container's top edge. */
export interface StopAnchor {
    readonly stopId: string;
    readonly offset: number;
}

/**
 * Top visible stop. `line` is the sticky toolbar's bottom edge. A stop whose tail is
 * entirely behind it is invisible to the reviewer and cannot be an anchor (SPEC §2.5). The offset
 * is measured from the container edge `containerTop`, so restoration returns the stop exactly
 * where the reviewer was reading, even if it starts beneath the toolbar.
 */
export function pickTopStop(containerTop: number, line: number, boxes: Iterable<StopBox>): StopAnchor | null {
    for (const box of boxes) {
        if (box.bottom > line) {
            return { stopId: box.stopId, offset: box.top - containerTop };
        }
    }
    return null;
}

/** Returns a cancellation function so competing jumps do not pull the container in 2 directions. */
export function animateScrollTo(container: HTMLElement, to: number, duration = JUMP_DURATION): () => void {
    const from = container.scrollTop;
    if (Math.abs(to - from) < 1 || duration <= 0) {
        container.scrollTop = to;
        return () => undefined;
    }

    const started = performance.now();
    let frame = requestAnimationFrame(function step(now: number) {
        const progress = Math.min((now - started) / duration, 1);
        container.scrollTop = from + (to - from) * easeInOutCubic(progress);
        if (progress < 1) {
            frame = requestAnimationFrame(step);
        }
    });

    return () => {
        cancelAnimationFrame(frame);
    };
}
