import type { Locale, RouteStop } from '@sherpa/protocol';
import { routeSkeletonResultSchema } from '@sherpa/protocol';

import { markupErrors } from './paragraph-markup.js';
import { parseResult } from './raw-result.js';
import { routeStrings } from './strings.js';
import type { AcceptedSkeleton, RouteValidation } from './types.js';
import { voiceErrors } from './voice.js';

/**
 * Accept a `route.skeleton` task result: raw text → stop plan.
 *
 * The skeleton has no anchors, so it needs no diff. Semantic checks are limited to the plan:
 * `tourOrder` must be a permutation of plan numbers 1..N to build a full tour.
 * The server assigns stop ids and the synthetic "Other" stop.
 */

/** Synthetic stop id: the model does not know about it, the server adds it. */
export const OTHER_STOP_ID = 'other';

/** Synthetic stop title in the generation language (`strings.ts`). */
export function otherStopTitle(locale: Locale): string {
    return routeStrings(locale).otherStopTitle;
}

/** Planned stop id convention: `s01`..`sNN` by plan number. */
export function stopId(planIndex: number): string {
    return `s${String(planIndex).padStart(2, '0')}`;
}

/**
 * `locale` is the generation language of the model result (which selects the voice stop list)
 * and the synthetic stop title. Defaults to English, which is also how
 * `provenance.locale: null` is read in old-format snapshots.
 */
export function validateSkeleton(rawText: string, locale: Locale = 'en'): RouteValidation<AcceptedSkeleton> {
    const parsed = parseResult(rawText, routeSkeletonResultSchema, 'skeleton');
    if (!parsed.ok) {
        return parsed;
    }

    const result = parsed.value;
    const tourError = tourOrderError(result.tourOrder, result.stops.length);
    // Voice checks apply only to reviewer-facing text. `intent` goes to the section model.
    // Summary uses the stop description vocabulary without the length budget.
    const errors = [
        ...(tourError === null ? [] : [tourError]),
        ...voiceErrors('skeleton.summary', result.summary, locale),
        ...markupErrors('skeleton.summary', 'summary', result.summary),
        ...result.stops.flatMap((stop, index) =>
            voiceErrors(`skeleton.stops[${String(index)}].title`, stop.title, locale),
        ),
    ];
    if (errors.length > 0) {
        return { ok: false, errors };
    }

    const stops: RouteStop[] = result.stops.map((stop, index) => ({
        id: stopId(index + 1),
        planIndex: index + 1,
        tier: stop.tier,
        title: stop.title,
        status: 'queued',
        paragraph: null,
        bridge: null,
        anchors: [],
        tests: [],
        droppedClaims: 0,
        validationNotes: [],
        provenance: null,
        // Section acceptance computes stop classification because the plan has no anchors yet.
        change: null,
    }));

    return {
        ok: true,
        value: {
            summary: result.summary,
            stops: [...stops, otherStop(stops.length + 1, locale)],
            tourOrder: [...result.tourOrder.map(stopId), OTHER_STOP_ID],
            intents: new Map(result.stops.map((stop, index) => [index + 1, stop.intent])),
        },
    };
}

/**
 * "Other" has nothing to fill. Its status is `ready` immediately, with no anchors. The UI computes its content (uncovered
 * ranges). The UI hides the stop until the route is complete and when there are no
 * uncovered lines (`docs/design/SPEC-elements.md §4.3`).
 */
function otherStop(planIndex: number, locale: Locale): RouteStop {
    return {
        id: OTHER_STOP_ID,
        planIndex,
        tier: 'other',
        title: otherStopTitle(locale),
        status: 'ready',
        paragraph: null,
        bridge: null,
        anchors: [],
        tests: [],
        droppedClaims: 0,
        validationNotes: [],
        provenance: null,
        change: null,
    };
}

/** Parses `tourOrder` as a permutation of 1..N. Reports duplicates, gaps and numbers outside the plan. */
function tourOrderError(tourOrder: readonly number[], planSize: number): string | null {
    const seen = new Set<number>();
    const duplicated = new Set<number>();
    const outOfRange = new Set<number>();
    for (const value of tourOrder) {
        if (value < 1 || value > planSize) {
            outOfRange.add(value);
            continue;
        }
        if (seen.has(value)) {
            duplicated.add(value);
        }
        seen.add(value);
    }
    const missing = [];
    for (let index = 1; index <= planSize; index += 1) {
        if (!seen.has(index)) {
            missing.push(index);
        }
    }
    if (duplicated.size === 0 && outOfRange.size === 0 && missing.length === 0) {
        return null;
    }

    const clauses = [
        ...(duplicated.size > 0 ? [`listed twice: ${sortedList(duplicated)}`] : []),
        ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
        ...(outOfRange.size > 0 ? [`outside the plan: ${sortedList(outOfRange)}`] : []),
    ];
    return `skeleton.tourOrder must list every plan number 1..${String(planSize)} exactly once (${clauses.join('; ')}). Reorder the numbers, do not add or drop stops.`;
}

function sortedList(values: ReadonlySet<number>): string {
    return [...values].sort((left, right) => left - right).join(', ');
}
