import { useCallback, useEffect, useRef, useState } from 'react';

import { useT } from '../i18n/index.js';
import { useShortcut } from '../shortcuts/context.tsx';
import type { TourPlacement, TourRect } from './placement.js';
import {
    easeInOutCubic,
    needsScroll,
    offscreen,
    placeTour,
    TOUR_RETRIES_MS,
    TOUR_SCROLL_MARGIN_TOP,
    TOUR_SCROLL_MS,
} from './placement.js';
import { TOUR_CARD_BODY_ID, TourCard } from './tour-card.tsx';
import { TourRing } from './tour-ring.tsx';
import type { TourStep } from './tour-model.js';
import { TOUR_SCAFFOLD_SELECTOR } from './tour-scaffold.tsx';
import './tour.css';

/**
 * Tour layer: ring, card, position measurement and keyboard (docs/design/SPEC-onboarding-2026-09-02.md §3, §7).
 * Mounted only while the tour runs. `tour-store.ts` holds the state.
 *
 * Measurement lives here because it deals with the DOM: each measurement finds the step target by `data-tour`
 * again, while pure functions in `placement.ts` calculate the geometry.
 */

export interface TourLayerProps {
    readonly step: TourStep;
    readonly index: number;
    readonly total: number;
    /**
     * Step target "epoch": changing it (placeholder → route, first filled
     * stop appearing, view change) makes the step remeasure. An explicit signal instead of watching
     * the DOM makes remeasurement deterministic and visible in tests. It must change rarely because
     * each change triggers remeasurement, which no longer touches the reviewer's scroll position.
     */
    readonly epoch: string;
    readonly onNext: () => void;
    readonly onBack: () => void;
    readonly onSkip: () => void;
}

export function TourLayer({ step, index, total, epoch, onNext, onBack, onSkip }: TourLayerProps) {
    const t = useT();
    const cardRef = useRef<HTMLDivElement | null>(null);
    const stepId = step.id;
    const selector = step.selector;
    const fixed = step.fixed;
    /*
     * Keep the previous position until a new measurement succeeds: between a step change (or target epoch change)
     * and the first measurement, the card moves to its new target over .18s instead of flashing at the fallback position at the
     * bottom center, where `top` would switch px↔auto and jump without animation (§4).
     */
    const [placement, setPlacement] = useState<TourPlacement | null>(null);
    /** Step whose initial measurement has run: only it may adjust scrolling (§3). */
    const scrolledFor = useRef<string | null>(null);
    /** Measurement key: when it changes, the effect finds the target again. */
    const measureKey = `${stepId}|${epoch}`;

    useEffect(() => {
        let cancelled = false;
        /** Scrolling is in progress: do not redraw the card until it ends (§4, "no jitter"). */
        let scrolling = false;
        /** Position found: stop the remeasurement sequence as soon as it succeeds. */
        let placed = false;
        // Zero is an unused timer and frame ID, so cancelling it is safe without checks.
        let retryTimer = 0;
        let frame = 0;
        let moveFrame = 0;
        /** Element borrowing `aria-describedby` pointing to the card body (§7). */
        let described: HTMLElement | null = null;
        let previousDescription: string | null = null;

        const describe = (element: HTMLElement | null): void => {
            if (described === element) {
                return;
            }
            if (described !== null) {
                if (previousDescription === null) {
                    described.removeAttribute('aria-describedby');
                } else {
                    described.setAttribute('aria-describedby', previousDescription);
                }
            }
            described = element;
            previousDescription = element === null ? null : element.getAttribute('aria-describedby');
            element?.setAttribute('aria-describedby', TOUR_CARD_BODY_ID);
        };

        const scrollTo = (target: HTMLElement, rect: TourRect, done: () => void): void => {
            const scroller = scrollerOf(target);
            const documentScroller =
                scroller === document.scrollingElement ||
                scroller === document.documentElement ||
                scroller === document.body;
            const base = documentScroller ? 0 : scroller.getBoundingClientRect().top;
            const to = Math.max(0, scroller.scrollTop + rect.top - base - TOUR_SCROLL_MARGIN_TOP);
            const from = scroller.scrollTop;
            const distance = to - from;
            if (Math.abs(distance) < 2) {
                done();
                return;
            }
            if (reducedMotion()) {
                scroller.scrollTop = to;
                done();
                return;
            }
            scrolling = true;
            const started = performance.now();
            const tick = (): void => {
                if (cancelled) {
                    return;
                }
                const progress = Math.min(1, (performance.now() - started) / TOUR_SCROLL_MS);
                scroller.scrollTop = from + distance * easeInOutCubic(progress);
                if (progress < 1) {
                    frame = requestAnimationFrame(tick);
                    return;
                }
                scrolling = false;
                done();
            };
            frame = requestAnimationFrame(tick);
        };

        /**
         * `first` is the only measurement allowed to scroll to the target. `after` is the measurement
         * after scrolling, also used for timer remeasurement. Scrolling again would cause recursion.
         */
        const place = (mode: 'first' | 'after' | 'passive'): void => {
            if (cancelled || (scrolling && mode !== 'after')) {
                return;
            }
            const target = anchorOf(selector);
            if (target === null) {
                describe(null);
                placed = false;
                setPlacement(null);
                return;
            }
            const box = target.getBoundingClientRect();
            const rect: TourRect = { left: box.left, top: box.top, width: box.width, height: box.height };
            const viewport = { width: window.innerWidth, height: window.innerHeight };
            if (mode === 'first' && !fixed && needsScroll(rect, viewport)) {
                scrollTo(target, rect, () => {
                    place('after');
                });
                return;
            }
            describe(target);
            if (offscreen(rect, viewport)) {
                placed = false;
                setPlacement(null);
                return;
            }
            placed = true;
            setPlacement(placeTour(rect, viewport));
        };

        const retry = (attempt: number): void => {
            const delay = TOUR_RETRIES_MS[attempt];
            if (delay === undefined) {
                return;
            }
            retryTimer = window.setTimeout(() => {
                if (cancelled) {
                    return;
                }
                if (!placed) {
                    place('after');
                }
                if (!placed) {
                    retry(attempt + 1);
                }
            }, delay);
        };

        const onMove = (): void => {
            if (moveFrame !== 0) {
                return;
            }
            moveFrame = requestAnimationFrame(() => {
                moveFrame = 0;
                place('passive');
            });
        };

        // First measurement runs on the next tick so the step markup (placeholder, open chat panel)
        // is in place before it is measured.
        const startTimer = window.setTimeout(() => {
            // A target epoch change triggers remeasurement, not a new step: it does not scroll, otherwise
            // a stop arriving over SSE would drag the route back to the step target.
            const initial = scrolledFor.current !== stepId;
            scrolledFor.current = stepId;
            place(initial ? 'first' : 'after');
        }, 0);
        retry(0);

        window.addEventListener('scroll', onMove, true);
        window.addEventListener('resize', onMove);
        window.addEventListener('load', onMove);
        // jsdom has no `document.fonts`, but the type hides this, hence the explicit cast.
        const fonts = document.fonts as FontFaceSet | undefined;
        void fonts?.ready.then(onMove, () => undefined);

        return () => {
            cancelled = true;
            window.removeEventListener('scroll', onMove, true);
            window.removeEventListener('resize', onMove);
            window.removeEventListener('load', onMove);
            clearTimeout(retryTimer);
            clearTimeout(startTimer);
            cancelAnimationFrame(frame);
            cancelAnimationFrame(moveFrame);
            describe(null);
        };
    }, [fixed, measureKey, selector, stepId]);

    /*
     * Focus the card when a step starts (§7), so tour arrow keys have a target. Repeat
     * on the next tick because step 06 opens the chat panel, whose composer takes focus
     * after our effects. Leave focus alone on remeasurement: the tour is non-blocking,
     * and the reviewer may already have moved into the interface.
     */
    useEffect(() => {
        cardRef.current?.focus();
        const timer = window.setTimeout(() => {
            cardRef.current?.focus();
        }, 0);
        return () => {
            clearTimeout(timer);
        };
    }, [stepId]);

    /*
     * Arrow keys and Enter belong to the tour only while the card itself has focus (§7). Tab
     * to a button and the keys belong to that button: the registry suppresses the key with `preventDefault`,
     * so Enter on "Skip tour" would otherwise move forward instead of exiting the tour.
     */
    const focusOnCard = useCallback(() => document.activeElement === cardRef.current, []);
    useShortcut({
        id: 'tour.next',
        keys: ['arrowright', 'enter'],
        label: 'shortcut.tour.next',
        scope: 'global',
        section: 'navigation',
        when: focusOnCard,
        action: onNext,
    });
    useShortcut({
        id: 'tour.back',
        keys: ['arrowleft'],
        label: 'shortcut.tour.back',
        scope: 'global',
        section: 'navigation',
        when: focusOnCard,
        action: onBack,
    });

    return (
        <>
            {placement === null ? null : <TourRing ring={placement.ring} />}
            <TourCard
                step={step}
                index={index}
                total={total}
                placement={placement}
                cardRef={cardRef}
                onSkip={onSkip}
                onBack={onBack}
                onNext={onNext}
            />
            <span className="visually-hidden" role="status" aria-live="polite">
                {t('tour.live', index + 1, total, t(step.title))}
            </span>
        </>
    );
}

/**
 * Step target. The tour placeholder is an opaque layer above the invitation or generation skeleton,
 * which may have its own target with the same name (coverage bar). In that case, search the placeholder:
 * it comes second in document order, but the ring must outline the visible target.
 */
function anchorOf(selector: string): HTMLElement | null {
    return (
        document.querySelector<HTMLElement>(`${TOUR_SCAFFOLD_SELECTOR} ${selector}`) ??
        document.querySelector<HTMLElement>(selector)
    );
}

/** Nearest ancestor with actual vertical scrolling. In our UI, this is the view's `main` (§3). */
function scrollerOf(element: HTMLElement): HTMLElement {
    let node = element.parentElement;
    while (node !== null && node !== document.body) {
        const overflow = getComputedStyle(node).overflowY;
        if (/(auto|scroll)/.test(overflow) && node.scrollHeight > node.clientHeight + 4) {
            return node;
        }
        node = node.parentElement;
    }
    return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function reducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
