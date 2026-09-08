import { routeFixtures } from '@sherpa/fixtures';
import type { RouteSectionResult, RouteStop } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { IterationMap } from '../iterations/index.js';
import { buildIterationMap, identityMap } from '../iterations/index.js';
import {
    asRawText,
    mediumDiff,
    mediumDiffV2,
    mediumInterdiffV1V2,
    mediumRawResults,
    mediumRawResultsEn,
    mediumRawResultsV2,
    mediumReadySnapshot,
    mediumThreadsV2,
} from './fixture-support.js';
import { type SectionContext, validateSection } from './section.js';
import { otherStopTitle, validateSkeleton } from './skeleton.js';
import { routeStrings } from './strings.js';
import { applyFilling, type RouteStopFilling } from './types.js';
import { bannedPhrases } from './voice.js';

/**
 * End-to-end golden test: raw fixture model outputs → validator → completed snapshot stops.
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

/** Merge fillings into the plan, as `RouteStore` does. */
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

        // Stop intents do not go into the snapshot. The section scheduler consumes them.
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

/**
 * Second pass on the same fixture: v2 plan and sections against the v1→v2 slice. The server
 * classifies stops from anchors, and the model only explains. A mismatch with the fixture would mean
 * the UI badge and snapshot data disagree.
 */
describe('route validator: second pass after a push', () => {
    const knownThreadIds = new Set(mediumThreadsV2().map((thread) => thread.id));

    function mapV1V2(): IterationMap {
        return buildIterationMap({
            interdiff: mediumInterdiffV1V2(),
            fromBaseCommit: mediumDiff().baseCommit,
            toBaseCommit: mediumDiffV2().baseCommit,
        });
    }

    function planV2(): RouteStop[] {
        const skeleton = validateSkeleton(asRawText(mediumRawResultsV2().skeleton));
        if (!skeleton.ok) {
            throw new Error(`second-pass skeleton rejected: ${skeleton.errors.join(' | ')}`);
        }
        return skeleton.value.stops;
    }

    function fillV2(
        stops: RouteStop[],
        section: RouteSectionResult,
        allowed: readonly number[],
        context: SectionContext,
    ): RouteStop[] {
        const result = validateSection(asRawText(section), stops, allowed, mediumDiffV2(), context);
        if (!result.ok) {
            throw new Error(`second-pass section rejected: ${result.errors.join(' | ')}`);
        }
        return merge(stops, result.value);
    }

    function fillAll(context: SectionContext): RouteStop[] {
        let stops = planV2();
        for (const section of mediumRawResultsV2().sections) {
            const planIndex = section.stops[0]?.planIndex ?? 0;
            stops = fillV2(stops, section, [planIndex], context);
        }
        return stops;
    }

    it('computes classification on the server and matches the second-pass fixture', () => {
        const stops = fillAll({ map: mapV1V2(), knownThreadIds });
        const expected = routeFixtures('medium')?.secondPass?.snapshot?.stops ?? [];

        expect(stops.map((stop) => [stop.id, stop.change?.kind ?? null])).toEqual(
            expected.map((stop) => [stop.id, stop.change?.kind ?? null]),
        );
        expect(stops.map((stop) => stop.change?.reason ?? null)).toEqual(
            expected.map((stop) => stop.change?.reason ?? null),
        );
        expect(stops.find((stop) => stop.id === 's03')?.change?.threadIds).toEqual(['4820242']);
        expect(stops.find((stop) => stop.id === 's01')?.change).toBeNull();
    });

    it('drops the reason on an untouched stop and adds a reviewer note', () => {
        const section = withReason(sectionOfV2(1), 'The author rewrote this stop from scratch.');
        const [filling] = accept(section, [1], { map: mapV1V2(), knownThreadIds });

        expect(filling?.change).toBeNull();
        expect(filling?.validationNotes).toContain(
            'Change reason dropped: this stop did not move since the previous route.',
        );
    });

    it('removes an unknown thread reference from text and excludes it from threadIds', () => {
        const section = withReason(
            sectionOfV2(2),
            'The author addressed the linter comment [thread:999], the `default` branch was added.',
        );
        const [filling] = accept(section, [2], { map: mapV1V2(), knownThreadIds });

        expect(filling?.change?.kind).toBe('changed');
        expect(filling?.change?.reason).toBe('The author addressed the linter comment, the `default` branch was added.');
        expect(filling?.change?.threadIds).toEqual([]);
        expect(filling?.validationNotes).toContain('Link to unknown thread 999 removed.');
    });

    it('reduces a reason containing only a broken reference to null instead of an empty block', () => {
        const section = withReason(sectionOfV2(2), '[thread:999]');
        const [filling] = accept(section, [2], { map: mapV1V2(), knownThreadIds });

        expect(filling?.change).toEqual({ kind: 'changed', reason: null, threadIds: [] });
        expect(filling?.validationNotes).toContain('Link to unknown thread 999 removed.');
    });

    it('keeps references without a reason because they can lead the reviewer to a discussion on their own', () => {
        const section = withThreadIds(withReason(sectionOfV2(3), null), ['4820242']);
        const [filling] = accept(section, [3], { map: mapV1V2(), knownThreadIds });

        expect(filling?.change).toEqual({ kind: 'changed', reason: null, threadIds: ['4820242'] });
    });

    it('adds a known reference in the reason text to threadIds and removes it from text', () => {
        const section = withReason(sectionOfV2(3), 'The author reply explains the edit [thread:4820242].');
        const [filling] = accept(section, [3], { map: mapV1V2(), knownThreadIds });

        expect(filling?.change?.threadIds).toEqual(['4820242']);
        // The UI shows threads in a separate row next to the reason, so prose does not need the literal token.
        expect(filling?.change?.reason).toBe('The author reply explains the edit.');
        expect(filling?.validationNotes).toEqual([]);
    });

    it('accepts a result without a reason for a classified stop because the reason is optional', () => {
        const section = withReason(sectionOfV2(6), null);
        const [filling] = accept(section, [6], { map: mapV1V2(), knownThreadIds });

        expect(filling?.change).toEqual({ kind: 'new', reason: null, threadIds: [] });
    });

    it('drops reasons and skips classification when regenerating on the same iteration', () => {
        const stops = fillAll({ map: identityMap(), knownThreadIds });

        expect(stops.every((stop) => stop.change === null)).toBe(true);
        expect(stops.find((stop) => stop.id === 's02')?.validationNotes).toContain(
            'Change reason dropped: this stop did not move since the previous route.',
        );
    });

    it('skips classification and ignores reasons without a previous snapshot', () => {
        const stops = fillAll({ map: null, knownThreadIds: new Set() });

        expect(stops.every((stop) => stop.change === null)).toBe(true);
    });

    /** A second-pass section by plan number. */
    function sectionOfV2(planIndex: number): RouteSectionResult {
        const section = mediumRawResultsV2().sections.find(
            (candidate) => candidate.stops[0]?.planIndex === planIndex,
        );
        if (section === undefined) {
            throw new Error(`the fixture has no second-pass section for stop ${String(planIndex)}`);
        }
        return section;
    }

    /** The same result with a replaced reason. `null` means no reason at all. */
    function withReason(section: RouteSectionResult, reason: string | null): RouteSectionResult {
        return {
            stops: section.stops.map((stop) => {
                const { changeReason: _dropped, changeThreadIds: _ids, ...rest } = stop;
                return reason === null ? rest : { ...rest, changeReason: reason };
            }),
        };
    }

    /** The same result with an explicit thread list for every stop. */
    function withThreadIds(section: RouteSectionResult, ids: readonly string[]): RouteSectionResult {
        return { stops: section.stops.map((stop) => ({ ...stop, changeThreadIds: [...ids] })) };
    }

    function accept(
        section: RouteSectionResult,
        allowed: readonly number[],
        context: SectionContext,
    ): RouteStopFilling[] {
        const result = validateSection(asRawText(section), planV2(), allowed, mediumDiffV2(), context);
        if (!result.ok) {
            throw new Error(`section rejected: ${result.errors.join(' | ')}`);
        }
        return result.value;
    }
});

/**
 * The same pipeline with English generation. The language changes model text and server strings,
 * but leaves anchors and numbers intact. This test checks that so locale cannot silently break validation.
 */
describe('route validator: English generation', () => {
    const raw = mediumRawResultsEn();

    function planEn(): RouteStop[] {
        const skeleton = validateSkeleton(asRawText(raw.skeleton), 'en');
        if (!skeleton.ok) {
            throw new Error(`English skeleton rejected: ${skeleton.errors.join(' | ')}`);
        }
        return skeleton.value.stops;
    }

    it('gives the synthetic stop an English title and the plan the same numbers', () => {
        const stops = planEn();
        expect(stops.map((stop) => stop.planIndex)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(stops.at(-1)?.id).toBe('other');
        expect(stops.at(-1)?.title).toBe('Other — lines the model did not place');
        expect(stops.at(-1)?.title).not.toBe(otherStopTitle('ru'));
    });

    it('accepts sections with the same anchors as the Russian ones', () => {
        let stops = planEn();
        for (const section of raw.sections) {
            const planIndex = section.stops[0]?.planIndex ?? 0;
            const result = validateSection(asRawText(section), stops, [planIndex], mediumDiff(), { locale: 'en' });
            expect(result.ok).toBe(true);
            if (!result.ok) {
                return;
            }
            stops = merge(stops, result.value);
        }

        const ruStops = mediumReadySnapshot().stops;
        for (const planIndex of [1, 2, 4]) {
            const actual = stops.find((stop) => stop.planIndex === planIndex);
            const expected = ruStops.find((stop) => stop.planIndex === planIndex);
            expect(actual?.anchors).toEqual(expected?.anchors);
        }
    });

    it('writes validator digest notes in English', () => {
        const section = raw.sections.find((candidate) => candidate.stops[0]?.planIndex === 4);
        const result = validateSection(asRawText(section), planEn(), [4], mediumDiff(), { locale: 'en' });
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
    });

    it('allows a Russian filler phrase in English text', () => {
        const skeleton = validateSkeleton(
            asRawText({ ...raw.skeleton, summary: `${String(bannedPhrases('ru')[0])}. ${raw.skeleton.summary}` }),
            'en',
        );
        expect(skeleton.ok).toBe(true);
    });

    it('rejects English filler phrases and emoji', () => {
        const filler = validateSkeleton(
            asRawText({ ...raw.skeleton, summary: 'It is worth noting that the window is 30 minutes.' }),
            'en',
        );
        expect(filler.ok).toBe(false);
        if (!filler.ok) {
            expect(filler.errors).toEqual([
                'skeleton.summary: drop the filler phrase "it is worth noting" and state the fact directly (see Voice in the methodology).',
            ]);
        }

        const stops = raw.skeleton.stops.map((stop, index) =>
            index === 0 ? { ...stop, title: `${stop.title} 🚀` } : stop,
        );
        const emoji = validateSkeleton(asRawText({ ...raw.skeleton, stops }), 'en');
        expect(emoji.ok).toBe(false);
    });
});
