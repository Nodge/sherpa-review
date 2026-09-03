import type { RouteSectionResult, RouteSkeletonResult, UiRoutePhase, UiRouteState } from '@sherpa/protocol';
import { routeSectionResultSchema, routeSkeletonResultSchema, uiRouteStateSchema } from '@sherpa/protocol';

import type { FixtureName } from './index.js';
import {
    makeMediumBrokenResults,
    makeMediumSectionResults,
    makeMediumSkeletonResult,
    makeMediumRouteStates,
} from './route-medium.js';
import { makeHugeRawResults } from './route-huge.js';
import {
    makeMediumBrokenResultsV2,
    makeMediumSecondPassState,
    makeMediumSectionResultsV2,
    makeMediumSkeletonResultV2,
} from './route-medium-v2.js';

/**
 * Fixture route data: generation states for the gallery and raw model outputs
 * for the e2e fake worker and validator golden corpus (M2-T3).
 *
 * Served like `fixtureData`: protocol schema validation during construction, a per-process cache,
 * and a `structuredClone` copy for callers (consumers mutate them).
 */

/** Invalid outputs satisfy protocol schemas but break semantics, for negative tests. */
export interface RouteBrokenResults {
    /** Anchor to a file outside the diff. */
    sectionUnknownFile: RouteSectionResult;
    /** Range outside the changed lines of a file. */
    sectionRangeOutsideChanges: RouteSectionResult;
    /** `tourOrder` is not a permutation of planned numbers: one stop appears twice, another is missing. */
    skeletonTourOrderNotPermutation: RouteSkeletonResult;
}

export interface RouteRawResults {
    skeleton: RouteSkeletonResult;
    /** One section per stop in the model plan, in plan order (the plan has no "Other"). */
    sections: RouteSectionResult[];
    broken: RouteBrokenResults;
}

export interface RouteFixtures {
    /** One state per phase. The key matches the `phase` value. */
    states: Partial<Record<UiRoutePhase, UiRouteState>>;
    /** null means the fixture has no prepared model outputs (the gallery does not need them). */
    rawResults: RouteRawResults | null;
    /** Model outputs for the second iteration: the same stops plus "why this stop changed". */
    rawResultsV2: RouteRawResults | null;
    /** Ready route for the second pass (README §9). null means the fixture has no second iteration. */
    secondPass: UiRouteState | null;
}

/**
 * Validation failure in `edge`: anchors shifted when a file was renamed. The
 * Generation failed state (README §12) uses real anchor drift, not a made-up error.
 */
function edgeFailedState(): UiRouteState {
    return {
        phase: 'failed',
        smallPr: false,
        snapshot: null,
        // Route staleness is handled in M4-T4.
        stale: null,
        failure: {
            message:
                'Generation stopped at validation: stop 02 references services/orders/src/infra/clock.ts, which is not in this iteration. The file was renamed to infra/time/clock.ts.',
            rawOutput: `{
  "stops": [
    {
      "planIndex": 2,
      "paragraph": "The clock moved into a separate time package, and the time source is injected…",
      "anchors": [
        { "path": "services/orders/src/infra/clock.ts", "side": "new", "start": 1, "end": 24 },
        { "path": "services/orders/src/infra/time/index.ts", "side": "new", "start": 1, "end": 3 }
      ]
    }
  ]
}`,
        },
    };
}

const BUILDERS: Partial<Record<FixtureName, () => RouteFixtures>> = {
    medium: () => ({
        states: makeMediumRouteStates(),
        rawResults: {
            skeleton: makeMediumSkeletonResult(),
            sections: makeMediumSectionResults(),
            broken: makeMediumBrokenResults(),
        },
        rawResultsV2: {
            skeleton: makeMediumSkeletonResultV2(),
            sections: makeMediumSectionResultsV2(),
            broken: makeMediumBrokenResultsV2(),
        },
        secondPass: makeMediumSecondPassState(),
    }),
    // PR below the route threshold: no generation task is enqueued (requirements §3.6).
    small: () => ({
        states: { none: { phase: 'none', smallPr: true, snapshot: null, failure: null, stale: null } },
        rawResults: null,
        rawResultsV2: null,
        secondPass: null,
    }),
    edge: () => ({
        states: { failed: edgeFailedState() },
        rawResults: null,
        rawResultsV2: null,
        secondPass: null,
    }),
    // No route: `large` is used in UI virtualization tests, and no one has run generation for it.
    large: () => ({
        states: { none: { phase: 'none', smallPr: false, snapshot: null, failure: null, stale: null } },
        rawResults: null,
        rawResultsV2: null,
        secondPass: null,
    }),
    // Performance fixture: no prepared states. e2e builds a 25-stop route through the fake worker.
    huge: () => ({
        states: { none: { phase: 'none', smallPr: false, snapshot: null, failure: null, stale: null } },
        rawResults: makeHugeRawResults(),
        rawResultsV2: null,
        secondPass: null,
    }),
};

/**
 * The same schemas as at the UI input. Catch route data errors during fixture construction,
 * instead of in the gallery three tasks later. Invalid outputs skip schemas because they are invalid on purpose.
 */
function validate(fixtures: RouteFixtures): RouteFixtures {
    const states: Partial<Record<UiRoutePhase, UiRouteState>> = {};
    for (const [phase, state] of Object.entries(fixtures.states) as [UiRoutePhase, UiRouteState][]) {
        const parsed = uiRouteStateSchema.parse(state);
        if (parsed.phase !== phase) {
            throw new Error(`route state is stored under key ${phase}, but has phase ${parsed.phase}`);
        }
        states[phase] = parsed;
    }

    return {
        states,
        rawResults: validateRaw(fixtures.rawResults),
        rawResultsV2: validateRaw(fixtures.rawResultsV2),
        secondPass: fixtures.secondPass === null ? null : uiRouteStateSchema.parse(fixtures.secondPass),
    };
}

/** Invalid outputs skip `parse` because they are invalid on purpose. */
function validateRaw(raw: RouteRawResults | null): RouteRawResults | null {
    return raw === null
        ? null
        : {
              skeleton: routeSkeletonResultSchema.parse(raw.skeleton),
              sections: raw.sections.map((section) => routeSectionResultSchema.parse(section)),
              broken: raw.broken,
          };
}

const built = new Map<FixtureName, RouteFixtures | null>();

/** Build from scratch, bypassing the cache. The determinism test compares two builds. */
export function buildRouteFixtures(name: FixtureName): RouteFixtures | null {
    const builder = BUILDERS[name];
    return builder === undefined ? null : validate(builder());
}

/** Fresh copy of route data. null means the fixture has none. */
export function routeFixtures(name: FixtureName): RouteFixtures | null {
    let fixtures = built.get(name);
    if (fixtures === undefined) {
        fixtures = buildRouteFixtures(name);
        built.set(name, fixtures);
    }
    return fixtures === null ? null : structuredClone(fixtures);
}
