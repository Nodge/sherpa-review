import type { RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { flashRow } from '../../diff-view/line-target.js';
import type { RoutePreset } from '../../session/session-store.js';
import type { JumpStep } from './scroll.js';
import {
    animateScrollTo,
    cssEscape,
    JUMP_DURATION,
    JUMP_STEPS,
    jumpTarget,
    pickTopStop,
    targetScrollTop,
} from './scroll.js';
import { stopBoxes } from './stop-dom.js';

export type RequestJump = (
    stopId: string,
    fileId: string | null,
    line?: number | null,
    side?: 'old' | 'new' | null,
    highlight?: boolean,
) => void;

export interface RouteJump {
    readonly containerRef: RefObject<HTMLElement | null>;
    /** Container ref callback also holds the selection popover host. */
    readonly setContainer: (element: HTMLElement | null) => void;
    readonly popoverHost: HTMLElement | null;
    /** Scroll correction is in progress: while the counter is nonzero, a scroll event is not a reviewer gesture. */
    readonly settling: RefObject<number>;
    readonly topStopRef: RefObject<{ stopId: string; offset: number } | null>;
    readonly keyboardStopRef: RefObject<string | null>;
    readonly flashStopId: string | null;
    readonly jumpStopId: string | null;
    readonly updateTopStop: () => void;
    readonly requestJump: RequestJump;
    readonly stopJump: () => void;
}

/**
 * Route scrolling: jump to a stop, card or line in stages with correction, flash the target
 * and anchor the viewport when the preset changes. All of these change the container's `scrollTop`, so one hook
 * owns the geometry and cancellation.
 */
export function useRouteJump(preset: RoutePreset): RouteJump {
    const containerRef = useRef<HTMLElement | null>(null);
    const [popoverHost, setPopoverHost] = useState<HTMLElement | null>(null);
    const setContainer = useCallback((element: HTMLElement | null) => {
        containerRef.current = element;
        setPopoverHost(element);
    }, []);
    /** The top stop in the viewport and its offset from the container edge anchor a preset change. */
    const topStopRef = useRef<{ stopId: string; offset: number } | null>(null);
    const settling = useRef(0);
    const [flashStopId, setFlashStopId] = useState<string | null>(null);
    /** The target of an unfinished jump: its diff column must stay in the DOM while the staged search runs inside it. */
    const [jumpStopId, setJumpStopId] = useState<string | null>(null);

    const updateTopStop = useCallback(() => {
        const container = containerRef.current;
        if (container === null) {
            return;
        }
        const top = container.getBoundingClientRect().top;
        // The sticky toolbar covers the container's top strip, so readable content starts below it.
        const toolbar = container.querySelector<HTMLElement>('.route-toolbar');
        const line = toolbar === null ? top : Math.max(top, toolbar.getBoundingClientRect().bottom);
        const anchor = pickTopStop(top, line, stopBoxes(container));
        if (anchor !== null) {
            topStopRef.current = anchor;
        }
    }, []);
    /**
     * The stop last reached with the keyboard. `j`/`k`/`n`/`p` cannot count from only
     * the top visible stop: a jump places its target 150px below the edge, so the previous stop
     * remains the "top" stop at that point. The keys would bounce between two neighbours.
     * Reviewer scrolling clears the anchor, so navigation counts from what is on screen again.
     */
    const keyboardStopRef = useRef<string | null>(null);

    // Correction and flashing survive rerenders. Only the next jump or leaving the view cancels them.
    // Cancelling them on every dependency change would interrupt scrolling halfway through.
    const running = useRef<JumpRun | null>(null);
    const stopJump = useCallback(() => {
        const current = running.current;
        if (current === null) {
            return;
        }
        running.current = null;
        current.cancel();
        if (current.frame !== null) {
            cancelAnimationFrame(current.frame);
        }
        for (const timer of current.timers) {
            clearTimeout(timer);
        }
        settling.current = Math.max(0, settling.current - 1);
        setJumpStopId(null);
    }, []);

    /**
     * Jump to a stop, file card or line (README "Interactions"): scroll the dedicated
     * container directly to −150px from the target top, and flash the target.
     *
     * The target is almost never ready in the same frame: a filter may have hidden the stop,
     * a card may be deferred by lazy rendering until its stop appears onscreen (SPEC §2.9), and a line may
     * be waiting for file parsing. So the jump proceeds in stages, "section → card → line". Each
     * stage found immediately pulls scrolling towards it (reaching the section makes the view show it,
     * so deferred cards render). Later stages are sought frame by frame until the deadline. If it cannot reach the target,
     * it stays at the last stage reached, a visible fallback instead of doing nothing.
     *
     * `side` is required with `line`: without the gutter side, an added line with the same number
     * would intercept a jump to a deleted line.
     */
    const requestJump = useCallback(
        (
            stopId: string,
            fileId: string | null,
            line: number | null = null,
            side: 'old' | 'new' | null = null,
            highlight = true,
        ) => {
            stopJump();
            const container = containerRef.current;
            if (container === null) {
                return;
            }

            settling.current += 1;
            // Keep the jump target mounted while the staged search looks for its card and line.
            setJumpStopId(stopId);
            const run: JumpRun = { cancel: () => undefined, timers: [], frame: null, reached: 'none' };
            running.current = run;
            const deadline = Date.now() + JUMP_SEARCH_MS;
            // The last targeting time determines the remaining correction duration.
            let aimedAt = Date.now();

            const goTo = (step: JumpStep, element: HTMLElement): void => {
                if (JUMP_STEPS[step] <= JUMP_STEPS[run.reached]) {
                    return;
                }
                run.reached = step;
                run.cancel();
                aimedAt = Date.now();
                run.cancel = animateScrollTo(container, targetScrollTop(container, element));
            };
            /**
             * Recalculate the target while approaching it. Marking a stop does not collapse it in a single frame
             * (lazy rendering, ResizeObserver, late parsing). The document above the target keeps
             * shrinking during the animation, so calculating once causes an overshoot. Correction fits
             * into what remains of ~320ms (README "Motion") since the last aim, but lasts at least
             * `REAIM_MIN_DURATION`: the target often appears hundreds of milliseconds after the search
             * starts, so time remaining "since the jump began" would turn the correction into a teleport.
             */
            const reaim = (): void => {
                if (running.current !== run) {
                    return;
                }
                const again = jumpTarget(container, stopId, fileId, line, side);
                if (again === null || JUMP_STEPS[again.step] < JUMP_STEPS[run.reached]) {
                    return;
                }
                const duration = Math.max(REAIM_MIN_DURATION, JUMP_DURATION - (Date.now() - aimedAt));
                run.cancel();
                aimedAt = Date.now();
                run.cancel = animateScrollTo(container, targetScrollTop(container, again.element), duration);
            };
            const finish = (): void => {
                run.frame = null;
                run.timers.push(
                    setTimeout(() => {
                        // Our correction has ended: the next scroll counts as a reviewer gesture again.
                        if (running.current === run) {
                            running.current = null;
                            settling.current = Math.max(0, settling.current - 1);
                            setJumpStopId(null);
                        }
                    }, JUMP_DURATION + SETTLE_TAIL),
                );
            };
            /** Target found: correct it twice more, on the next frame and after `ANCHOR_SETTLE`. */
            const settle = (): void => {
                run.frame = requestAnimationFrame(() => {
                    run.frame = null;
                    reaim();
                    run.timers.push(
                        setTimeout(() => {
                            reaim();
                            finish();
                        }, ANCHOR_SETTLE),
                    );
                });
            };

            const step = (): void => {
                if (running.current !== run) {
                    return;
                }
                const target = jumpTarget(container, stopId, fileId, line, side);
                if (target !== null) {
                    if (run.reached === 'none' && highlight) {
                        setFlashStopId(stopId);
                        run.timers.push(
                            setTimeout(() => {
                                setFlashStopId(null);
                            }, FLASH_MS),
                        );
                    }
                    goTo(target.step, target.element);
                    // The final stage depends on the request: only look for a line if one was requested.
                    const done =
                        target.step === 'row' ||
                        (target.step === 'card' && line === null) ||
                        (target.step === 'section' && fileId === null);
                    if (target.step === 'row' && highlight) {
                        flashRow(target.element);
                    }
                    if (done) {
                        settle();
                        return;
                    }
                }
                if (Date.now() >= deadline) {
                    finish();
                    return;
                }
                run.frame = requestAnimationFrame(step);
            };

            // Start the first attempt on the next frame: the same handler requests stop expansion
            // and filter clearing, so the target is absent from the markup until the rerender.
            run.frame = requestAnimationFrame(step);
        },
        [stopJump],
    );

    // Our scroll adjustment does not count as a reviewer gesture while anchor correction is running: the browser
    // dispatches scroll events in the next task, so a timer closes the window.
    const anchoring = useRef<{ frames: number[]; timers: ReturnType<typeof setTimeout>[] } | null>(null);
    const endAnchoring = useCallback(() => {
        const run = anchoring.current;
        if (run === null) {
            return;
        }
        anchoring.current = null;
        for (const frame of run.frames) {
            cancelAnimationFrame(frame);
        }
        for (const timer of run.timers) {
            clearTimeout(timer);
        }
        settling.current = Math.max(0, settling.current - 1);
    }, []);
    useEffect(
        () => () => {
            stopJump();
            endAnchoring();
        },
        [endAnchoring, stopJump],
    );

    /**
     * Changing the preset anchors the viewport to the top stop (SPEC §2.5): the same stop id stays
     * on screen without resetting scrolling to the start. A layout effect restores it before
     * the new order is painted, without animation: the reading position stays the same.
     */
    const presetRef = useRef(preset);
    useAnchorEffect(() => {
        if (presetRef.current === preset) {
            return;
        }
        presetRef.current = preset;
        const anchor = topStopRef.current;
        if (anchor === null || containerRef.current === null) {
            return;
        }
        const apply = (): void => {
            const container = containerRef.current;
            const section = container?.querySelector<HTMLElement>(`[data-stop="${cssEscape(anchor.stopId)}"]`) ?? null;
            if (container === null || section === null) {
                return;
            }
            const delta = section.getBoundingClientRect().top - container.getBoundingClientRect().top;
            container.scrollTop += delta - anchor.offset;
        };

        // An unfinished correction from the previous jump would pull the container towards the old target.
        stopJump();
        endAnchoring();
        apply();
        settling.current += 1;
        const run: { frames: number[]; timers: ReturnType<typeof setTimeout>[] } = { frames: [], timers: [] };
        anchoring.current = run;
        // Neighbouring stops render their cards after entering the viewport and grow above
        // the anchor after reordering. So the position is confirmed a few more times.
        run.frames.push(
            requestAnimationFrame(() => {
                apply();
                run.frames.push(requestAnimationFrame(apply));
            }),
        );
        run.timers.push(
            setTimeout(() => {
                apply();
                // The last scroll adjustment is ours too: its event arrives in the next task,
                // so the correction window must stay open until then, or kept-in-view would be cleared.
                run.timers.push(setTimeout(endAnchoring, SETTLE_TAIL));
            }, ANCHOR_SETTLE),
        );
    }, [endAnchoring, preset, stopJump]);

    return {
        containerRef,
        setContainer,
        popoverHost,
        settling,
        topStopRef,
        keyboardStopRef,
        flashStopId,
        jumpStopId,
        updateTopStop,
        requestJump,
        stopJump,
    };
}

/**
 * Adjust the scroll anchor before painting the frame, or the new order would flash at the wrong position.
 * Static rendering (tests, SSR) has no layout effects: use a regular effect there so React
 * does not warn about a layout effect on the server.
 */
const useAnchorEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

const FLASH_MS = 900;
/** Allow time after the animation: the browser dispatches scroll events after the final step. */
const SETTLE_TAIL = 50;

interface JumpRun {
    /** Cancel the current scroll: the next stage takes over halfway through. */
    cancel: () => void;
    timers: ReturnType<typeof setTimeout>[];
    /** Frame for the next target search. `null` means the search has ended. */
    frame: number | null;
    reached: JumpStep;
}

/**
 * How long to wait for the jump target to appear. A filter may have hidden the section, lazy rendering may
 * defer the card until the stop enters the viewport, and the line may be waiting for file parsing.
 * Past the deadline, the jump stays at the last stage reached.
 */
const JUMP_SEARCH_MS = 1500;
/**
 * How long to keep the preset-change anchor: allow lazy rendering of neighbouring stops to finish
 * (the visibility observer and its rerender), but do not keep it long enough to fight
 * the reviewer's own scrolling.
 */
const ANCHOR_SETTLE = 120;
/** Minimum jump correction duration: adjusting the target still moves to it instead of teleporting. */
const REAIM_MIN_DURATION = 120;
