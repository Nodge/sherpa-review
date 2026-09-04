import type { Locale, RouteProvenance, RouteSnapshot, RouteStopStatus, UiRouteState, UiTask } from '@sherpa/protocol';

import type { MessageKey, Translate } from '../i18n/index.js';
import type { ViewId } from '../session/views.js';
import { planLabel } from './route-model.js';

/**
 * Route generation state model (README §6–8, SPEC §3): what the generation
 * card and route view skeleton show. This pure module uses neither React nor network.
 *
 * All counts come from `snapshot.stops[].status`. "N of M", the segment bar and the plan list must
 * describe the same set of slots. "3 of 7" in README illustrates its data,
 * not a constant.
 */

/**
 * What the "Route" tab renders (README §6–8, §12, SPEC §4.1). The decision lives outside App:
 * There are 5 phases, snapshots can be partial, and phase selection must be testable without a server.
 *
 * An available snapshot always takes precedence over the phase. The old route stays usable
 * during a rebuild and after its failure. A phase without its data falls back to the invitation instead of an empty screen.
 */
export type RouteViewKind = 'workspace' | 'reading' | 'failed' | 'small-pr' | 'invitation';

export function routeViewKind(route: UiRouteState | null): RouteViewKind {
    if (route === null) {
        return 'invitation';
    }
    if (route.snapshot !== null) {
        return 'workspace';
    }
    if (route.phase === 'reading') {
        return 'reading';
    }
    if (route.phase === 'failed' && route.failure !== null) {
        return 'failed';
    }
    return route.smallPr ? 'small-pr' : 'invitation';
}

/** Shared guard for every route generation entry point. */
export function routeGenerationAvailable({
    phase,
    smallPr,
    generating,
}: {
    readonly phase: UiRouteState['phase'] | null;
    readonly smallPr: boolean;
    readonly generating: boolean;
}): boolean {
    return !smallPr && !generating && (phase === 'none' || phase === 'ready' || phase === 'failed');
}

/**
 * What the generation card in the Overview rail renders. `null` means it has nothing to show in this phase
 * (the route has not been started, or the phase arrived without its data).
 */
export type GenerationCardKind = 'failed' | 'ready' | 'filling' | 'reading' | null;

export function generationCardKind(route: UiRouteState | null): GenerationCardKind {
    if (route === null) {
        return null;
    }
    if (route.phase === 'failed' && route.failure !== null) {
        return 'failed';
    }
    if (route.phase === 'ready' && route.snapshot !== null) {
        return 'ready';
    }
    if (route.phase === 'filling' && route.snapshot !== null) {
        return 'filling';
    }
    return route.phase === 'reading' ? 'reading' : null;
}

/**
 * Whether the screen has a place for a generation endpoint error next to the action that triggered it.
 * There are 2 such places: the red card in the Route tab and the generation card in the Overview rail
 * (a ready route has no error row because there is nothing to repeat). For all other view and phase
 * combinations, the banner slot handles the error. Otherwise, "Build the route" from the palette in phase
 * `none` would fail silently.
 */
export function routeActionErrorInPlace(view: ViewId, route: UiRouteState | null): boolean {
    if (view === 'route') {
        return routeViewKind(route) === 'failed';
    }
    if (view !== 'overview') {
        return false;
    }
    const kind = generationCardKind(route);
    return kind === 'failed' || kind === 'filling' || kind === 'reading';
}

export interface GenerationSlot {
    readonly id: string;
    /** Number fixed by the plan: `01`. */
    readonly planLabel: string;
    readonly title: string;
    readonly status: RouteStopStatus;
}

export interface GenerationProgress {
    readonly slots: readonly GenerationSlot[];
    /** Slots ready to read. Synthetic "Other" is ready immediately because it really is readable. */
    readonly ready: number;
    readonly total: number;
}

export function generationProgress(snapshot: RouteSnapshot): GenerationProgress {
    const slots = snapshot.stops.map((stop) => ({
        id: stop.id,
        planLabel: planLabel(stop.planIndex),
        title: stop.title,
        status: stop.status,
    }));
    return {
        slots,
        ready: slots.filter((slot) => slot.status === 'ready').length,
        total: slots.length,
    };
}

/** The snapshot is still being built: at least one slot is neither ready nor failed. */
export function snapshotFilling(snapshot: RouteSnapshot): boolean {
    return snapshot.stops.some((stop) => stop.status === 'queued' || stop.status === 'filling');
}

/** Open route generation tasks: these are what "Cancel" cancels (SPEC §3). */
export function openRouteTasks(tasks: readonly UiTask[]): readonly UiTask[] {
    return tasks.filter(
        (task) =>
            (task.type === 'route.skeleton' || task.type === 'route.section') &&
            (task.status === 'queued' || task.status === 'leased'),
    );
}

/** "Still working" threshold from SPEC §3: the task has run for over a minute. */
export const LONG_GENERATION_MS = 60_000;

/** The oldest open route task has passed the threshold. */
export function generationIsLong(tasks: readonly UiTask[], now: number): boolean {
    return openRouteTasks(tasks).some((task) => now - Date.parse(task.createdAt) >= LONG_GENERATION_MS);
}

/**
 * Summary arrives as markdown. Here it splits into paragraphs at blank lines, and the
 * `route` profile renderer handles markup within each paragraph (inline code only).
 */
export function summaryParagraphs(summary: string): readonly string[] {
    return summary
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph !== '');
}

/**
 * Language used to build the route (M5-T4). Pre-M5 snapshots carry `null` in provenance,
 * and are in Russian.
 */
export function snapshotLocale(provenance: RouteProvenance): Locale {
    return provenance.locale ?? 'en';
}

/** Route language name in the UI dictionary: nominative for the pill, prepositional for the phrase. */
export function localeNameKey(locale: Locale): MessageKey {
    return locale === 'ru' ? 'route.locale.name.ru' : 'route.locale.name.en';
}

export function localeOnKey(locale: Locale): MessageKey {
    return locale === 'ru' ? 'route.locale.on.ru' : 'route.locale.on.en';
}

/**
 * Snapshot provenance in one line: "claude-code · sonnet-5 · 9f3c1ab" (README §6).
 * The language appears only when it differs from the tab's language. A match needs no label.
 */
export function provenanceLine(snapshot: RouteSnapshot, t: Translate, uiLocale: Locale): string {
    const locale = snapshotLocale(snapshot.provenance);
    return [
        snapshot.provenance.harness,
        snapshot.provenance.model,
        snapshot.commit.slice(0, 7),
        locale === uiLocale ? null : t(localeNameKey(locale)),
    ]
        .filter((part): part is string => part !== null && part !== '')
        .join(' · ');
}
