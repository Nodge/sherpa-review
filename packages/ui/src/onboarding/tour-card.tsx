import type { RefObject } from 'react';

import { useT } from '../i18n/index.js';
import type { TourPlacement } from './placement.js';
import type { TourStep } from './tour-model.js';

export const TOUR_CARD_TITLE_ID = 'tour-card-title';
export const TOUR_CARD_BODY_ID = 'tour-card-body';

export interface TourCardProps {
    readonly step: TourStep;
    /** Zero-based step number and current list length: seven when offline (§5). */
    readonly index: number;
    readonly total: number;
    /** `null` means no target or an off-screen target: card centered at the bottom without an arrow (§4). */
    readonly placement: TourPlacement | null;
    readonly cardRef: RefObject<HTMLDivElement | null>;
    readonly onSkip: () => void;
    readonly onBack: () => void;
    readonly onNext: () => void;
}

/**
 * Tour card (docs/design/SPEC-onboarding-2026-09-02.md §1, §4): counter, kicker, title, body and footer. No
 * lists, links, images or progress dots inside. One step, one thought.
 *
 * `aria-modal="false"`: the screen reader reads the step, but focus is not trapped in the card because the tour
 * is non-blocking (§7). The tour layer focuses the card and releases focus when leaving.
 */
export function TourCard({ step, index, total, placement, cardRef, onSkip, onBack, onNext }: TourCardProps) {
    const t = useT();
    const last = index === total - 1;

    return (
        <div
            ref={cardRef}
            className={`tour-card${placement === null ? ' tour-card--fallback' : ''}`}
            role="dialog"
            aria-modal="false"
            aria-labelledby={TOUR_CARD_TITLE_ID}
            aria-describedby={TOUR_CARD_BODY_ID}
            tabIndex={-1}
            style={
                placement === null
                    ? undefined
                    : {
                          left: `${String(Math.round(placement.left))}px`,
                          top: `${String(Math.round(placement.top))}px`,
                      }
            }
        >
            {placement === null ? null : (
                <span
                    className={`tour-card__beak tour-card__beak--${placement.side}`}
                    aria-hidden="true"
                    style={
                        placement.side === 'below' || placement.side === 'above'
                            ? { left: `${String(placement.beak)}px` }
                            : { top: `${String(placement.beak)}px` }
                    }
                />
            )}

            <div className="tour-card__head">
                <span className="tour-card__counter">{t('tour.counter', index + 1, total)}</span>
                <span className="tour-card__kicker">{t('tour.kicker')}</span>
            </div>
            <div className="tour-card__title" id={TOUR_CARD_TITLE_ID}>
                {t(step.title)}
            </div>
            <div className="tour-card__body" id={TOUR_CARD_BODY_ID}>
                {t(step.body)}
            </div>
            <div className="tour-card__footer">
                <button type="button" className="tour-card__skip" onClick={onSkip}>
                    {t('tour.skip')}
                </button>
                <span className="tour-card__spacer" />
                {index === 0 ? null : (
                    <button type="button" className="tour-card__back" onClick={onBack}>
                        {t('tour.back')}
                    </button>
                )}
                <button type="button" className="tour-card__next" onClick={onNext}>
                    {t(last ? 'tour.start' : 'tour.next')}
                </button>
            </div>
        </div>
    );
}
