import { describe, expect, it } from 'vitest';

import {
    canonicalIndex,
    nextStep,
    prevStep,
    stepAt,
    stepAtCanonical,
    stepIndex,
    TOUR_STEP_COUNT,
    tourAnchorEpoch,
    tourSteps,
} from './tour-model.js';

/** Step order and contents follow onboarding spec §2. Omitting the chat step follows §5. */
describe('tour model', () => {
    it('takes eight steps in the order of the reviewer journey', () => {
        expect(TOUR_STEP_COUNT).toBe(8);
        expect(tourSteps(true).map((step) => step.id)).toEqual([
            'narrative',
            'fold',
            'stopdiff',
            'progress',
            'presets',
            'chat',
            'fulldiff',
            'ship',
        ]);
    });

    it('omits the chat step without an agent and shifts the remaining steps', () => {
        const offline = tourSteps(false);

        expect(offline).toHaveLength(7);
        expect(offline.map((step) => step.id)).not.toContain('chat');
        // Counter `/ 07`: the full diff step becomes sixth instead of seventh.
        expect(stepIndex(offline, 'fulldiff')).toBe(5);
        expect(stepIndex(tourSteps(true), 'fulldiff')).toBe(6);
    });

    it('scrolls to the target for the first three steps but not the sticky ones', () => {
        const byId = new Map(tourSteps(true).map((step) => [step.id, step.fixed]));

        expect([byId.get('narrative'), byId.get('fold'), byId.get('stopdiff')]).toEqual([false, false, false]);
        expect([byId.get('progress'), byId.get('presets'), byId.get('chat')]).toEqual([true, true, true]);
        expect([byId.get('fulldiff'), byId.get('ship')]).toEqual([true, true]);
    });

    it('addresses the fold by prefix because its anchor includes the stop id', () => {
        expect(tourSteps(true)[1]?.selector).toBe('[data-tour^="fold-"]');
    });

    it('stops transitions at the list boundaries', () => {
        const steps = tourSteps(true);

        expect(nextStep(steps, 'narrative')?.id).toBe('fold');
        expect(prevStep(steps, 'fold')?.id).toBe('narrative');
        // The first step has no "Back", the last has "Start reviewing" instead of "Next".
        expect(prevStep(steps, 'narrative')).toBeNull();
        expect(nextStep(steps, 'ship')).toBeNull();
    });

    it('moves directly to the next step across the omitted step without an agent', () => {
        expect(nextStep(tourSteps(false), 'presets')?.id).toBe('fulldiff');
        expect(prevStep(tourSteps(false), 'fulldiff')?.id).toBe('presets');
    });

    it('clamps the persisted number because it may come from a pass of a different length', () => {
        const offline = tourSteps(false);

        expect(stepAt(offline, 7).id).toBe('ship');
        expect(stepAt(offline, -1).id).toBe('narrative');
        expect(stepAt(offline, 3).id).toBe('progress');
    });

    it('the anchor marker ignores each subsequent stop', () => {
        const base = {
            view: 'route',
            routeKind: 'workspace',
            anyStopFilled: true,
            chatOpen: false,
            completed: false,
        };

        // The first filled stop is an event. The second, third and seventh are not.
        expect(tourAnchorEpoch({ ...base, anyStopFilled: false })).not.toBe(tourAnchorEpoch(base));
        expect(tourAnchorEpoch(base)).toBe(tourAnchorEpoch({ ...base }));
        // Replacing the placeholder with the route, changing views and opening a panel all trigger remeasurement.
        expect(tourAnchorEpoch({ ...base, routeKind: 'reading' })).not.toBe(tourAnchorEpoch(base));
        expect(tourAnchorEpoch({ ...base, view: 'diff' })).not.toBe(tourAnchorEpoch(base));
        expect(tourAnchorEpoch({ ...base, chatOpen: true })).not.toBe(tourAnchorEpoch(base));
        expect(tourAnchorEpoch({ ...base, completed: true })).not.toBe(tourAnchorEpoch(base));
    });

    it('persists a canonical number regardless of whether the pass included the chat step', () => {
        // Full diff is step seven with an agent and six without one, but the persisted number is the same.
        expect(canonicalIndex('fulldiff')).toBe(6);
        expect(stepIndex(tourSteps(false), 'fulldiff')).toBe(5);

        expect(stepAtCanonical(tourSteps(true), 6).id).toBe('fulldiff');
        expect(stepAtCanonical(tourSteps(false), 6).id).toBe('fulldiff');
    });

    it('uses the next available step when the step is absent from this pass', () => {
        // The tour was left on the chat step, but there is no agent on the next visit.
        expect(stepAtCanonical(tourSteps(false), canonicalIndex('chat')).id).toBe('fulldiff');
        expect(stepAtCanonical(tourSteps(false), 99).id).toBe('ship');
        expect(stepAtCanonical(tourSteps(true), -3).id).toBe('narrative');
    });
});
