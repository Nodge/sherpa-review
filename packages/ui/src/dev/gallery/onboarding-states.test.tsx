import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ONBOARDING_STATES } from './onboarding-states.tsx';

/**
 * Tour gallery: registered states and their static markup. The card position
 * always uses the fallback here because measurement runs in an effect in the browser. Tests check text, counter,
 * footer contents and step targets in the scaffold.
 */
function markup(id: string): string {
    const state = ONBOARDING_STATES.find((candidate) => candidate.id === id);
    if (state === undefined) {
        throw new Error(`no state ${id}`);
    }
    return renderToStaticMarkup(<>{state.render()}</>);
}

describe('onboarding gallery', () => {
    it('registers exactly the ids declared in the file', () => {
        expect(ONBOARDING_STATES.map((state) => state.id)).toEqual([
            'tour-step-01-narrative',
            'tour-step-02-fold',
            'tour-step-03-stopdiff',
            'tour-step-04-progress',
            'tour-step-05-presets',
            'tour-step-06-chat',
            'tour-step-07-fulldiff',
            'tour-step-08-ship',
            'tour-offline-counter',
            'tour-fallback-missing',
            'tour-scaffold-reading',
            'tour-scaffold-progress',
            'tour-scaffold-invitation',
        ]);
    });

    it('the coverage strip anchor is duplicated above the generation skeleton and outlines the upper one in the scaffold', () => {
        const html = markup('tour-scaffold-progress');

        expect(html.match(/data-tour="progress"/gu)).toHaveLength(2);
        // The scaffold comes second in the markup, so the step takes its target rather than the skeleton target.
        expect(html.indexOf('tour-scaffold')).toBeGreaterThan(html.indexOf('data-tour="progress"'));
    });

    it('first step: 01 / 08 counter, kicker and spec text, no Back', () => {
        const html = markup('tour-step-01-narrative');

        expect(html).toContain('01 / 08');
        expect(html).toContain('HOW SHERPA WORKS');
        expect(html).toContain('The route decides what you read first');
        expect(html).toContain('Stops are ordered by how much they can hurt');
        expect(html).toContain('Skip tour');
        expect(html).toContain('tour-card__next');
        expect(html).not.toContain('tour-card__back');
    });

    it('the card has a screen reader label and description without trapping focus', () => {
        const html = markup('tour-step-01-narrative');

        expect(html).toContain('role="dialog"');
        expect(html).toContain('aria-modal="false"');
        expect(html).toContain('aria-labelledby="tour-card-title"');
        expect(html).toContain('aria-describedby="tour-card-body"');
        expect(html).toContain('aria-live="polite"');
        expect(html).toContain('step 1 of 8');
    });

    it('the last step is called Start reviewing and keeps Back', () => {
        const html = markup('tour-step-08-ship');

        expect(html).toContain('08 / 08');
        expect(html).toContain('Start reviewing');
        expect(html).toContain('tour-card__back');
        expect(html).not.toContain('>Next<');
    });

    it('without an agent the counter becomes / 07, and the full diff step is sixth', () => {
        const html = markup('tour-offline-counter');

        expect(html).toContain('06 / 07');
        expect(html).toContain('The classic reader stays one click away');
    });

    it('step anchors sit on real frame elements', () => {
        const html = markup('tour-step-01-narrative');

        expect(html).toContain('data-tour="narrative"');
        expect(html).toContain('data-tour="stopdiff"');
        expect(html).toContain('data-tour="progress"');
        expect(html).toContain('data-tour="presets"');
        expect(html).toContain('data-tour="fulldiff"');
        expect(html).toContain('data-tour="ship"');
        expect(html).toMatch(/data-tour="fold-s\d+"/u);
    });

    it('the agent step shows the chat panel, the only state the tour changes', () => {
        expect(markup('tour-step-06-chat')).toContain('data-tour="chat"');
        expect(markup('tour-step-05-presets')).not.toContain('data-tour="chat"');
    });

    it('the scaffold supplies stop and fold placeholders without invented numbers', () => {
        const html = markup('tour-scaffold-reading');

        expect(html).toContain('tour-scaffold');
        expect(html).toContain('The first stop of the route will appear here');
        expect(html).toContain('data-tour="fold-stub"');
        expect(html).toContain('a folded low-tier stop will sit here');
        // The placeholder is outside the route model: it has no `data-stop`, and navigation ignores it.
        expect(html).not.toContain('data-stop="tour-stub"');
    });

    it('missing target fallback places the card at bottom center without a ring', () => {
        const html = markup('tour-fallback-missing');

        expect(html).toContain('tour-card--fallback');
        expect(html).not.toContain('tour-ring');
        expect(html).not.toContain('data-tour="narrative"');
    });
});
