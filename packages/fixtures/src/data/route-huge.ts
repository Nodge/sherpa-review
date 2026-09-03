import type { RouteSectionResult, RouteSkeletonResult, RouteTier } from '@sherpa/protocol';

import { HUGE_COLLAPSED_FILE_PATH, hugeFiles } from './huge.js';
import type { RouteBrokenResults, RouteRawResults } from './route.js';

/**
 * Route for the `huge` performance fixture: 25 stops across 100 files. Used to measure the
 * Route view with a long list of stops (requirements §6). There is no substantive PR analysis here,
 * and text is built from a template using the files in each stop.
 *
 * Anchors use the same ranges that generated the hunks, so they fall exactly
 * on changed lines. Generated files have no anchors, leaving their lines to "Other".
 */

export const HUGE_STOP_COUNT = 25;
/** Files per stop: 25 stops cover exactly the 100 fixture files. */
const FILES_PER_STOP = 4;

const SUBJECTS = [
    'storage adapters',
    'order repositories',
    'DTO mappers',
    'platform endpoints',
    'module tests',
] as const;

const TIER_ORDER = ['high', 'medium', 'low'] as const;

/** Tier by plan position: the first stops cover the core move, the last cover generated wiring. */
function tierAt(stopIndex: number): Exclude<RouteTier, 'other'> {
    if (stopIndex < 5) {
        return 'high';
    }
    return stopIndex < 15 ? 'medium' : 'low';
}

interface HugeStopSpec {
    planIndex: number;
    tier: Exclude<RouteTier, 'other'>;
    title: string;
    intent: string;
    paragraph: string;
    bridge: string | null;
    anchors: RouteSectionResult['stops'][number]['anchors'];
}

function modulesLabel(paths: readonly string[]): string {
    const modules = [...new Set(paths.map((path) => /\/(mod-\d+)\//.exec(path)?.[1] ?? path))];
    const first = modules[0] ?? 'mod-01';
    const last = modules.at(-1) ?? first;
    return first === last ? `Module ${first}` : `Modules ${first}–${last}`;
}

function stopSpecs(): HugeStopSpec[] {
    const files = hugeFiles();
    const specs: HugeStopSpec[] = [];

    for (let stopIndex = 0; stopIndex < HUGE_STOP_COUNT; stopIndex += 1) {
        const group = files
            .slice(stopIndex * FILES_PER_STOP, (stopIndex + 1) * FILES_PER_STOP)
            // The model does not analyse generated files, so their lines stay in "Other".
            .filter((entry) => !entry.file.generated);
        const subject = SUBJECTS[stopIndex % SUBJECTS.length] ?? SUBJECTS[0];
        const nextSubject = SUBJECTS[(stopIndex + 1) % SUBJECTS.length] ?? SUBJECTS[0];
        const label = modulesLabel(group.map((entry) => entry.file.path));

        specs.push({
            planIndex: stopIndex + 1,
            tier: tierAt(stopIndex),
            title: `${label}: ${subject}`,
            intent: `What moved to the platform layer: ${subject}, ${String(group.length)} files.`,
            paragraph:
                `${label}: ${subject} moved to the platform layer, with one interface for all modules. ` +
                `The implementation stays in the module. As a result, the caller no longer selects the ` +
                `implementation by module name, but receives it from the platform.`,
            bridge: stopIndex === HUGE_STOP_COUNT - 1 ? null : `Next: ${nextSubject}.`,
            anchors: group.flatMap((entry) =>
                entry.ranges.map((range) => ({
                    path: entry.file.path,
                    side: range.side,
                    start: range.start,
                    end: range.end,
                })),
            ),
        });
    }

    return specs;
}

const SUMMARY = [
    'The PR extracts the platform layer from the module tree: storage adapters, repositories, ' +
        'mappers, and endpoints move to `src/platform`, leaving only the implementation in each module.',
    'The change is mechanical and repetitive: a hundred files, twenty modules, each with the same ' +
        'set of five files. Generated files are not placed in the route, since there is nothing to read line by line.',
].join('\n\n');

function skeletonOf(specs: readonly HugeStopSpec[]): RouteSkeletonResult {
    return {
        summary: SUMMARY,
        stops: specs.map((spec) => ({ title: spec.title, tier: spec.tier, intent: spec.intent })),
        // Tour: tiers by importance, then reverse order within each tier, to differ from the plan order.
        tourOrder: TIER_ORDER.flatMap((tier) =>
            specs
                .filter((spec) => spec.tier === tier)
                .map((spec) => spec.planIndex)
                .reverse(),
        ),
    };
}

function sectionsOf(specs: readonly HugeStopSpec[]): RouteSectionResult[] {
    return specs.map((spec) => ({
        stops: [
            {
                planIndex: spec.planIndex,
                paragraph: spec.paragraph,
                ...(spec.bridge === null ? {} : { bridge: spec.bridge }),
                anchors: spec.anchors,
            },
        ],
    }));
}

/** Broken outputs for negative tests: they pass schemas but fail semantic checks. */
function brokenOf(skeleton: RouteSkeletonResult): RouteBrokenResults {
    return {
        sectionUnknownFile: {
            stops: [
                {
                    planIndex: 1,
                    paragraph: 'The platform layer now has its own adapter registry.',
                    anchors: [
                        { path: 'services/orders/src/platform/mod-99/registry.ts', side: 'new', start: 1, end: 40 },
                    ],
                },
            ],
        },
        sectionRangeOutsideChanges: {
            stops: [
                {
                    planIndex: 2,
                    paragraph: 'The end of the new service describes migration from the old adapter.',
                    // The file has 2412 added lines, with no changed lines beyond them.
                    anchors: [{ path: HUGE_COLLAPSED_FILE_PATH, side: 'new', start: 3000, end: 3010 }],
                },
            ],
        },
        skeletonTourOrderNotPermutation: {
            ...skeleton,
            // Stop 02 is listed twice, and stop 01 is missing.
            tourOrder: Array.from({ length: HUGE_STOP_COUNT }, (_, index) => (index === 0 ? 2 : index + 1)),
        },
    };
}

/** Complete raw model outputs. Stop contents are computed once, since generating a hundred files is costly. */
export function makeHugeRawResults(): RouteRawResults {
    const specs = stopSpecs();
    const skeleton = skeletonOf(specs);
    return { skeleton, sections: sectionsOf(specs), broken: brokenOf(skeleton) };
}
