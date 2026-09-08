import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useUiSettings, useUiSettingsLoaded, useUiSettingsStore } from '../settings/context.tsx';
import { useShortcut } from '../shortcuts/context.tsx';
import type { TourStep, TourStepId } from './tour-model.js';
import {
    canonicalIndex,
    nextStep,
    prevStep,
    stepAt,
    stepAtCanonical,
    stepIndex,
    TOUR_STEP_COUNT,
    tourSteps,
} from './tour-model.js';

/**
 * Onboarding tour state (docs/design/SPEC-onboarding-2026-09-02.md §5–§6).
 *
 * Persistence uses `settings.onboarding`: `step` is written on each transition, `completedAt` on
 * "Skip tour" and "Start reviewing". An unfinished tour resumes from the same step on any PR
 * and after a server restart. `localStorage` cannot do this because each PR has its own port.
 *
 * The tour runs exactly while `useTourActive` returns `true`. The pass (current step) lives
 * in the mounted layer's state: mounting the layer starts the pass, unmounting
 * ends it. There is therefore no separate "time to start" effect.
 */

/**
 * Whether the tour is active: unfinished and data ready. It starts as soon as the UI first opens,
 * without waiting for a route, because the placeholder supplies missing step targets (`tour-scaffold.tsx`).
 *
 * Settings must be real instead of defaults: rendering starts after the loading timeout,
 * and the default `completedAt` is empty. Showing the tour from defaults is already wrong, and the first
 * transition would overwrite a completed tour on the server with "not completed".
 */
export function useTourActive(dataReady: boolean): boolean {
    const { onboarding } = useUiSettings();
    const loaded = useUiSettingsLoaded();
    return dataReady && loaded && onboarding.completedAt === null;
}

/**
 * "Replay the onboarding tour" palette command (§6): resets the completion flag and step number. Always
 * available, including outside the tour, since it is the only way back after "Skip tour".
 * `onReplay` restarts an active pass: the layer is recreated and starts at 01.
 */
export function useTourReplayCommand(onReplay: () => void): void {
    const settings = useUiSettingsStore();
    useShortcut({
        id: 'tour.replay',
        keys: [],
        group: 'palette.group.sherpa',
        label: 'shortcut.tour.replay',
        scope: 'global',
        section: 'navigation',
        consequence: 'shortcut.tour.replay.consequence',
        consequenceArg: TOUR_STEP_COUNT,
        action: () => {
            settings.update({ onboarding: { completedAt: null, step: 0 } });
            onReplay();
        },
    });
}

/** One tour pass: current step and whether it included the chat step. */
interface TourRun {
    readonly stepId: TourStepId;
    /** Agent was connected when the pass started, otherwise it has no chat step at all (§5). */
    readonly startedWithAgent: boolean;
    /** The chat step has already been shown, so keep it even if the agent dies (§5). */
    readonly visitedChat: boolean;
}

export interface TourRunOptions {
    /** Agent is connected right now: this determines the chat panel step (§5). */
    readonly agentConnected: boolean;
    /** Step 06 opens the chat panel and closes it when moving to 07. */
    readonly onOpenChat: () => void;
    readonly onCloseChat: () => void;
}

export interface TourRunState {
    /** Steps in the current pass: seven without an agent. */
    readonly steps: readonly TourStep[];
    readonly step: TourStep;
    /** Zero-based current step number. */
    readonly index: number;
    readonly next: () => void;
    readonly back: () => void;
    /** "Skip tour" and "Start reviewing" are the only ways to close permanently (§6). */
    readonly skip: () => void;
}

/**
 * Tour pass. Read the starting step from settings once, on mount, to
 * resume an unfinished tour where it was left.
 */
export function useTourRun(options: TourRunOptions): TourRunState {
    const settings = useUiSettingsStore();
    const { agentConnected } = options;
    const [run, setRun] = useState<TourRun>(() => {
        const initial = stepAtCanonical(tourSteps(agentConnected), settings.getSnapshot().onboarding.step);
        return { stepId: initial.id, startedWithAgent: agentConnected, visitedChat: initial.id === 'chat' };
    });

    /*
     * Agent died during the tour: keep a chat step already shown, omit one not yet shown. An agent
     * appearing during the tour does not restore the step, otherwise the counter would visibly jump.
     */
    const withChat = run.startedWithAgent && (agentConnected || run.visitedChat);
    const steps = useMemo(() => tourSteps(withChat), [withChat]);
    const step = steps.find((candidate) => candidate.id === run.stepId) ?? stepAt(steps, 0);
    const index = stepIndex(steps, step.id);

    // Persist the canonical step number: the next visit may build a pass of a different
    // length (no agent), where the number from this pass would point to a different step.
    const goTo = useCallback(
        (target: TourStep) => {
            setRun((current) => ({
                ...current,
                stepId: target.id,
                visitedChat: current.visitedChat || target.id === 'chat',
            }));
            settings.update({ onboarding: { completedAt: null, step: canonicalIndex(target.id) } });
        },
        [settings],
    );
    const finish = useCallback(() => {
        settings.update({ onboarding: { completedAt: new Date().toISOString(), step: 0 } });
    }, [settings]);

    const next = useCallback(() => {
        const target = nextStep(steps, step.id);
        if (target === null) {
            finish();
            return;
        }
        goTo(target);
    }, [finish, goTo, step.id, steps]);
    const back = useCallback(() => {
        const target = prevStep(steps, step.id);
        if (target !== null) {
            goTo(target);
        }
    }, [goTo, step.id, steps]);

    // The only exception to "the tour does not switch anything" (§2): the chat step
    // opens the panel and closes it when leaving the step, including when completing the tour.
    const chatOpenRef = useRef(options.onOpenChat);
    const chatCloseRef = useRef(options.onCloseChat);
    useEffect(() => {
        chatOpenRef.current = options.onOpenChat;
        chatCloseRef.current = options.onCloseChat;
    });
    const onChatStep = step.id === 'chat';
    useEffect(() => {
        if (!onChatStep) {
            return;
        }
        chatOpenRef.current();
        return () => {
            chatCloseRef.current();
        };
    }, [onChatStep]);

    return { steps, step, index, next, back, skip: finish };
}
