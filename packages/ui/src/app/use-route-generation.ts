import type { Locale, UiRouteState, UiTask } from '@sherpa/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cancelTask, fillRouteStop, generateReviewRoute } from '../api.js';
import type { Translate } from '../i18n/index.js';
import {
    generationIsLong,
    openRouteTasks,
    routeActionErrorInPlace,
    routeGenerationAvailable,
    routeViewKind,
} from '../route/generation.js';
import type { SessionStore } from '../session/session-store.js';
import type { ViewId } from '../session/views.js';
import type { RouteActionFailure } from './review-state.js';
import { EMPTY_TASKS, errorMessage } from './review-state.js';

export interface UseRouteGenerationOptions {
    readonly route: UiRouteState | null;
    readonly token: string;
    readonly uiLocale: Locale;
    readonly t: Translate;
    readonly session: SessionStore;
    readonly view: ViewId;
    readonly tasks: readonly UiTask[] | undefined;
    readonly tourActive: boolean;
    /** Callback to review endpoints: a "snapshot is stale" response refreshes the route. */
    readonly refreshRoute: () => void;
}

/** Route generation: endpoints, the long-running task and the default view for a small PR. */
export function useRouteGeneration({
    route,
    token,
    uiLocale,
    t,
    session,
    view,
    tasks,
    tourActive,
    refreshRoute,
}: UseRouteGenerationOptions) {
    const routePhase = route?.phase ?? null;
    const routeKind = routeViewKind(route);
    const routeTasks = useMemo(() => openRouteTasks(tasks ?? EMPTY_TASKS), [tasks]);
    const [generating, setGenerating] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    /**
     * Store the reason with the phase that produced it. When the server reports something new,
     * the old endpoint complaint is stale and disappears without a separate reset.
     */
    const [routeActionFailure, setRouteActionFailure] = useState<RouteActionFailure | null>(null);
    const routeActionError = routeActionFailure?.phase === routePhase ? routeActionFailure.message : null;
    /** Phase where generation was requested. The button keeps loading until the phase changes. */
    const generationFrom = useRef<string | null>(null);
    /**
     * Mirror `generating` for the repeated-start guard. React state updates by the next
     * render, but two consecutive calls (palette, button) can happen in the same render.
     */
    const generationInFlight = useRef(false);
    const stopGenerating = useCallback(() => {
        generationInFlight.current = false;
        setGenerating(false);
    }, []);
    useEffect(() => {
        if (generating && generationFrom.current !== routePhase) {
            stopGenerating();
        }
    }, [generating, routePhase, stopGenerating]);
    const startGeneration = useCallback(() => {
        if (
            !routeGenerationAvailable({
                phase: routePhase,
                smallPr: route?.smallPr === true,
                generating: generationInFlight.current,
            })
        ) {
            return;
        }
        generationInFlight.current = true;
        generationFrom.current = routePhase;
        setGenerating(true);
        setRouteActionFailure(null);
        void generateReviewRoute(token, uiLocale).then(
            (outcome) => {
                // Generation has started. The SSE phase change releases the button, not the endpoint response.
                if (outcome !== 'started') {
                    stopGenerating();
                }
                if (outcome === 'small_pr') {
                    setRouteActionFailure({ phase: routePhase, message: t('route.smallPr.notGenerated') });
                }
            },
            (error: unknown) => {
                stopGenerating();
                setRouteActionFailure({ phase: routePhase, message: errorMessage(error) });
            },
        );
    }, [route?.smallPr, routePhase, stopGenerating, t, token, uiLocale]);
    const fillStop = useCallback(
        (planIndex: number) => {
            const snapshotId = route?.snapshot?.snapshotId;
            if (routePhase !== 'ready' || snapshotId === undefined) {
                return;
            }

            setRouteActionFailure(null);
            void fillRouteStop(token, { snapshotId, planIndex }).then(
                (outcome) => {
                    if (outcome === 'stale_snapshot' || outcome === 'not_unfilled') {
                        refreshRoute();
                    }
                },
                (error: unknown) => {
                    setRouteActionFailure({ phase: routePhase, message: errorMessage(error) });
                },
            );
        },
        [refreshRoute, route?.snapshot?.snapshotId, routePhase, token],
    );
    const cancelGeneration = useCallback(() => {
        const ids = routeTasks.map((task) => task.id);
        if (ids.length === 0) {
            return;
        }
        setCancelling(true);
        setRouteActionFailure(null);
        void Promise.all(ids.map((id) => cancelTask(token, id))).then(
            () => {
                setCancelling(false);
            },
            (error: unknown) => {
                setCancelling(false);
                setRouteActionFailure({ phase: routePhase, message: errorMessage(error) });
            },
        );
    }, [routePhase, routeTasks, token]);

    // The clock ticks only while the agent has work to do. "Still working" depends on elapsed time.
    const [now, setNow] = useState(() => Date.now());
    const hasRouteTasks = routeTasks.length > 0;
    useEffect(() => {
        if (!hasRouteTasks) {
            return;
        }
        const timer = setInterval(() => {
            setNow(Date.now());
        }, LONG_GENERATION_TICK);
        return () => {
            clearInterval(timer);
        };
    }, [hasRouteTasks]);
    const longRunning = generationIsLong(routeTasks, now);

    /**
     * A small PR opens in Full diff (docs/design/SPEC-elements.md §4.1). Never override the reviewer's view choice,
     * whether from the URL or by hand, so decide once and only for the default.
     *
     * Wait for a running tour. It starts on the Route, and switching the tab underneath it would send
     * its first steps to fallback positions. Defer the decision until the tour ends, without cancelling it.
     */
    const smallPrRedirected = useRef(false);
    useEffect(() => {
        if (smallPrRedirected.current || tourActive || routePhase !== 'none' || route?.smallPr !== true) {
            return;
        }
        smallPrRedirected.current = true;
        if (!session.viewPinned()) {
            session.setView('diff');
        }
    }, [route?.smallPr, routePhase, session, tourActive]);

    const actionErrorInPlace = routeActionErrorInPlace(view, route);
    const generateAvailable = routeGenerationAvailable({
        phase: routePhase,
        smallPr: route?.smallPr === true,
        generating,
    });

    return {
        routePhase,
        routeKind,
        generating,
        cancelling,
        routeActionError,
        startGeneration,
        fillStop,
        cancelGeneration,
        now,
        longRunning,
        actionErrorInPlace,
        generateAvailable,
    };
}

/** How often to recalculate "Still working". The threshold is coarse, so second-level precision is unnecessary. */
const LONG_GENERATION_TICK = 5000;
