import type { MessageKey } from '../i18n/index.js';

/**
 * Onboarding tour model (SPEC-onboarding-2026-09-02 §2, §5): 8 steps, their anchors
 * and transitions. A pure module with no React or DOM, so step order, omitting the agent
 * step and the counter can be tested without a screen.
 *
 * Steps are addressed by ID instead of number: the offline list is one step shorter, so the same
 * step has a different number. Indexes appear only at the boundaries, in persistence and the counter.
 */

export type TourStepId = 'narrative' | 'fold' | 'stopdiff' | 'progress' | 'presets' | 'chat' | 'fulldiff' | 'ship';

export interface TourStep {
    readonly id: TourStepId;
    /** Anchor selector: `data-tour` on our elements (§2). */
    readonly selector: string;
    readonly title: MessageKey;
    readonly body: MessageKey;
    /**
     * The target is sticky or fixed (toolbar, chat panel, tab, action bar), so this step
     * never scrolls the page (§3, "Scroll to target").
     */
    readonly fixed: boolean;
}

/**
 * Order follows the reviewer journey (§2): what to read (01–03) → how to measure progress (04) → how to control
 * the order and ask questions (05–06) → way out (07) → completion (08).
 */
const STEPS: readonly TourStep[] = [
    {
        id: 'narrative',
        selector: '[data-tour="narrative"]',
        title: 'tour.step.narrative.title',
        body: 'tour.step.narrative.body',
        fixed: false,
    },
    {
        id: 'fold',
        selector: '[data-tour^="fold-"]',
        title: 'tour.step.fold.title',
        body: 'tour.step.fold.body',
        fixed: false,
    },
    {
        id: 'stopdiff',
        selector: '[data-tour="stopdiff"]',
        title: 'tour.step.stopdiff.title',
        body: 'tour.step.stopdiff.body',
        fixed: false,
    },
    {
        id: 'progress',
        selector: '[data-tour="progress"]',
        title: 'tour.step.progress.title',
        body: 'tour.step.progress.body',
        fixed: true,
    },
    {
        id: 'presets',
        selector: '[data-tour="presets"]',
        title: 'tour.step.presets.title',
        body: 'tour.step.presets.body',
        fixed: true,
    },
    {
        id: 'chat',
        selector: '[data-tour="chat"]',
        title: 'tour.step.chat.title',
        body: 'tour.step.chat.body',
        fixed: true,
    },
    {
        id: 'fulldiff',
        selector: '[data-tour="fulldiff"]',
        title: 'tour.step.fulldiff.title',
        body: 'tour.step.fulldiff.body',
        fixed: true,
    },
    {
        id: 'ship',
        selector: '[data-tour="ship"]',
        title: 'tour.step.ship.title',
        body: 'tour.step.ship.body',
        fixed: true,
    },
];

/** All 8 steps. The palette command counter uses this list. */
export const TOUR_STEP_COUNT = STEPS.length;

/** Inputs that determine anchor placement on screen. */
export interface TourAnchorEpoch {
    readonly view: string;
    /** Route tab state: the tour placeholder gives way to the real route. */
    readonly routeKind: string;
    /** Whether any filled stop exists, providing the anchors for steps 01–03. */
    readonly anyStopFilled: boolean;
    readonly chatOpen: boolean;
    readonly completed: boolean;
}

/**
 * Anchor placement marker: a change makes the tour remeasure the current step. Only major
 * events count. Each subsequent stop arriving does not, otherwise the tour would remeasure on every
 * streamed section and move the card under the reviewer's hands.
 */
export function tourAnchorEpoch(epoch: TourAnchorEpoch): string {
    return [
        epoch.view,
        epoch.routeKind,
        epoch.anyStopFilled ? 'filled' : '',
        epoch.chatOpen ? 'chat' : '',
        epoch.completed ? 'done' : '',
    ].join('|');
}

/**
 * Tour steps for the current agent state (§5): without an agent, the chat panel step is omitted,
 * the counter becomes `/ 07`, and the remaining step numbers shift.
 */
export function tourSteps(withChat: boolean): readonly TourStep[] {
    return withChat ? STEPS : STEPS.filter((step) => step.id !== 'chat');
}

/** Step position in the list. `-1` means absent from this list (the agent disconnected before reaching it). */
export function stepIndex(steps: readonly TourStep[], id: TourStepId): number {
    return steps.findIndex((step) => step.id === id);
}

/**
 * Persisted step number: its position in the full list. The pass list number cannot be used because
 * its length depends on the agent, and after a restart with a different agent state, the same number
 * would point to a different step.
 */
export function canonicalIndex(id: TourStepId): number {
    return STEPS.findIndex((step) => step.id === id);
}

/**
 * Pass step from the saved canonical number. The step may be absent from this pass (number
 * saved with an agent, now absent), so use the next available step in the overall order.
 */
export function stepAtCanonical(steps: readonly TourStep[], index: number): TourStep {
    const clamped = Math.min(Math.max(index, 0), STEPS.length - 1);
    return steps.find((step) => canonicalIndex(step.id) >= clamped) ?? stepAt(steps, steps.length - 1);
}

/** Step by clamped index: a number outside the list is clamped to its boundaries. */
export function stepAt(steps: readonly TourStep[], index: number): TourStep {
    const first = steps[0];
    if (first === undefined) {
        throw new Error('Sherpa: the tour step list is empty');
    }
    return steps[Math.min(Math.max(index, 0), steps.length - 1)] ?? first;
}

/** Next step. `null` means the current step is the last, so only completing the tour remains. */
export function nextStep(steps: readonly TourStep[], id: TourStepId): TourStep | null {
    const index = stepIndex(steps, id);
    return index === -1 ? null : (steps[index + 1] ?? null);
}

/** Previous step. `null` means the current step is the first and has no "Back" button (§4). */
export function prevStep(steps: readonly TourStep[], id: TourStepId): TourStep | null {
    const index = stepIndex(steps, id);
    return index <= 0 ? null : (steps[index - 1] ?? null);
}
