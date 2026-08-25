import type { RouteSectionResult, RouteStop } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { asRawText, mediumDiff, mediumRawResults, mediumReadySnapshot } from './fixture-support.js';
import { otherStopTitle, validateSkeleton } from './skeleton.js';
import { validateSkeleton } from './skeleton.js';
import { applyFilling, type RouteStopFilling } from './types.js';
import { bannedPhrases } from './voice.js';

/**
 * End-to-end golden test: raw model outputs (M2-T2 fixtures) → validator → ready snapshot stops.
 * The fixture and the live pipeline must agree verbatim. Otherwise the gallery, e2e and UI see
 * one set of data while the server builds another.
 */

function planStops(): RouteStop[] {
    const skeleton = validateSkeleton(asRawText(mediumRawResults().skeleton));
    if (!skeleton.ok) {
        throw new Error(`fixture skeleton rejected: ${skeleton.errors.join(' | ')}`);
    }
    return skeleton.value.stops;
}

/** Merge fillings into the plan, as RouteStore does in M2-T4. */
function merge(stops: readonly RouteStop[], fillings: readonly RouteStopFilling[]): RouteStop[] {
    const byIndex = new Map(fillings.map((filling) => [filling.planIndex, filling]));
    return stops.map((stop) => {
        const filling = byIndex.get(stop.planIndex);
        return filling === undefined || stop.tier === 'other' ? stop : applyFilling(stop, filling);
    });
}

function fill(stops: RouteStop[], section: RouteSectionResult, allowed: readonly number[]): RouteStop[] {
    const result = validateSection(asRawText(section), stops, allowed, mediumDiff());
    if (!result.ok) {
        throw new Error(`section rejected: ${result.errors.join(' | ')}`);
    }
    return merge(stops, result.value);
}

describe('route validator: end-to-end golden test on the medium fixture', () => {
    const raw = mediumRawResults();
    const snapshot = mediumReadySnapshot();

    it('expands the skeleton into a snapshot plan with ids, tiers, "Other" and tour order', () => {
        const skeleton = validateSkeleton(asRawText(raw.skeleton));
        expect(skeleton.ok).toBe(true);
        if (!skeleton.ok) {
            return;
        }

        expect(skeleton.value.summary).toBe(snapshot.summary);
        expect(skeleton.value.tourOrder).toEqual(snapshot.tourOrder);
        expect(skeleton.value.stops.map((stop) => stop.id)).toEqual(snapshot.stops.map((stop) => stop.id));
        expect(skeleton.value.stops.map((stop) => stop.tier)).toEqual(snapshot.stops.map((stop) => stop.tier));
        expect(skeleton.value.stops.map((stop) => stop.title)).toEqual(snapshot.stops.map((stop) => stop.title));
        expect(skeleton.value.stops.map((stop) => stop.status)).toEqual([
            'queued',
            'queued',
            'queued',
            'queued',
            'queued',
            'queued',
            // "Other" has nothing to fill, so it is ready immediately.
            'ready',
        ]);

        // Stop intent does not go into the snapshot. The section scheduler consumes it (T5).
        expect([...skeleton.value.intents.keys()]).toEqual([1, 2, 3, 4, 5, 6]);
        expect(skeleton.value.intents.get(4)).toBe(raw.skeleton.stops[3]?.intent);
        for (const stop of skeleton.value.stops) {
            expect(stop).not.toHaveProperty('intent');
        }
    });

    it('produces the fixture ready-snapshot stops verbatim from six sequential sections', () => {
        let stops = planStops();
        for (const section of raw.sections) {
            const planIndex = section.stops[0]?.planIndex ?? 0;
            stops = fill(stops, section, [planIndex]);
        }

        expect(stops).toEqual(snapshot.stops);
    });

    it('produces the same result from a batch of all six sections', () => {
        const batched: RouteSectionResult = { stops: raw.sections.flatMap((section) => section.stops) };
        const stops = fill(planStops(), batched, [1, 2, 3, 4, 5, 6]);

        expect(stops).toEqual(mediumReadySnapshot().stops);
    });

    it('stop 04 digest: 12 accepted assertions, 2 dropped and a Russian reviewer note', () => {
        const section = raw.sections.find((candidate) => candidate.stops[0]?.planIndex === 4);
        const result = validateSection(asRawText(section), planStops(), [4], mediumDiff());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        const [filling] = result.value;
        expect(filling?.tests.length).toBe(12);
        expect(filling?.droppedClaims).toBe(2);
        expect(filling?.validationNotes).toEqual([
            '2 claims dropped: the anchor pointed at `services/orders/src/domain/__tests__/factories.ts`, which is not in this diff.',
        ]);
        // `uncovered` stays in the digest without a test anchor because it describes behavior without coverage.
        expect(filling?.tests.filter((claim) => claim.anchor === null).map((claim) => claim.kind)).toEqual([
            'uncovered',
        ]);
    });

    it('resolves anchors to fileId in the active iteration and preserves the collapse directive', () => {
        const stops = planStops();
        const lock = raw.sections.find((candidate) => candidate.stops[0]?.planIndex === 6);
        const result = validateSection(asRawText(lock), stops, [6], mediumDiff());
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        const anchors = result.value[0]?.anchors ?? [];
        const lockFile = mediumDiff().files.find((file) => file.path === 'pnpm-lock.yaml');
        expect(anchors.map((anchor) => anchor.fileId)).toEqual([lockFile?.fileId, lockFile?.fileId]);
        expect(anchors.map((anchor) => anchor.collapsed)).toEqual([true, true]);
    });
});
