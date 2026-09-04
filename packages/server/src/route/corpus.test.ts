import type { RouteAnchor, RouteStop } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { asRawText, mediumDiff, mediumRawResults, mediumRawResultsEn } from './fixture-support.js';
import { routeStrings, validateSection as validateSectionIn, validateSkeleton as validateSkeletonIn } from './index.js';
import type { RouteValidation } from './types.js';
import { bannedPhrases } from './voice.js';

/**
 * Validator negative corpus. Add a case for every "model returned something odd" incident (requirements §7):
 * one entry in `CASES` with raw text and the expected errors. The validators below default to Russian,
 * the language of cases without an `en:` prefix, so its voice stop list and note wording stay covered.
 * The model reads the errors, so tests compare them verbatim. Text owned by
 * zod or `JSON.parse` can change with the runtime version, so it uses `patterns`.
 */

const WINDOW = 'services/orders/src/domain/edit-window.ts';
const CLOCK = 'services/orders/src/infra/clock.ts';
const README = 'services/orders/README.md';

function plan(): RouteStop[] {
    const skeleton = validateSkeleton(asRawText(mediumRawResults().skeleton));
    if (!skeleton.ok) {
        throw new Error(`fixture skeleton rejected: ${skeleton.errors.join(' | ')}`);
    }
    return skeleton.value.stops;
}

const validateSkeleton = (rawText: string, locale: 'ru' | 'en' = 'ru') => validateSkeletonIn(rawText, locale);
function planEn(): RouteStop[] {
    const skeleton = validateSkeleton(asRawText(mediumRawResultsEn().skeleton), 'en');
    if (!skeleton.ok) {
        throw new Error(`English fixture skeleton rejected: ${skeleton.errors.join(' | ')}`);
    }
    return skeleton.value.stops;
}

/** Plan with a filled stop: input for deduplication rules (SPEC §4.3). */
function planWith(planIndex: number, anchors: readonly Omit<RouteAnchor, 'fileId' | 'collapsed'>[]): RouteStop[] {
    const files = mediumDiff().files;
    return plan().map((stop) =>
        stop.planIndex === planIndex
            ? {
                  ...stop,
                  status: 'ready',
                  paragraph: 'Already accepted filling.',
                  anchors: anchors.map((anchor) => ({
                      ...anchor,
                      fileId: files.find((file) => file.path === anchor.path)?.fileId ?? 'no such file',
                      collapsed: false,
                  })),
              }
            : stop,
    );
}

function section(stops: unknown[]): string {
    return asRawText({ stops });
}

function anchoredStop(planIndex: number, anchors: unknown[], extra: Record<string, unknown> = {}): unknown {
    return { planIndex, paragraph: 'What changed → what follows.', anchors, ...extra };
}

/** One corpus entry: raw text and the response the validator must return. */
interface Case {
    readonly name: string;
    readonly run: () => RouteValidation<unknown>;
    /** Verbatim errors. */
    readonly errors?: readonly string[];
    /** Errors whose text belongs to zod or `JSON.parse`, checked by pattern. */
    readonly patterns?: readonly RegExp[];
}

const CASES: readonly Case[] = [
    {
        name: 'not JSON at all',
        run: () => validateSkeleton('the route is ready, with seven stops'),
        patterns: [/^Result is not valid JSON: .+\. Return a single JSON object matching the skeleton schema/],
    },
    {
        name: 'truncated JSON',
        run: () => validateSkeleton('{"summary": "The PR introduces a window", "stops": ['),
        patterns: [/^Result is not valid JSON: /],
    },
    {
        name: 'skeleton without stops',
        run: () => validateSkeleton(asRawText({ summary: 'The PR introduces a window', stops: [], tourOrder: [] })),
        patterns: [/^skeleton\.stops: /],
    },
    {
        name: 'skeleton with 41 stops',
        run: () =>
            validateSkeleton(
                asRawText({
                    summary: 'The PR introduces a window',
                    stops: Array.from({ length: 41 }, (_unused, index) => ({
                        title: `Stop ${String(index + 1)}`,
                        tier: 'low',
                        intent: 'Stop intent.',
                    })),
                    tourOrder: Array.from({ length: 41 }, (_unused, index) => index + 1),
                }),
            ),
        patterns: [/^skeleton\.stops: /],
    },
    {
        name: 'tourOrder is not a permutation of plan numbers',
        run: () => validateSkeleton(asRawText(mediumRawResults().broken.skeletonTourOrderNotPermutation)),
        errors: [
            'skeleton.tourOrder must list every plan number 1..6 exactly once (listed twice: 3; missing: 4). Reorder the numbers, do not add or drop stops.',
        ],
    },
    {
        name: 'section: anchor points to a file absent from the diff',
        run: () =>
            validateSection(
                asRawText(mediumRawResults().broken.sectionUnknownFile),
                plan(),
                [3],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0]: every anchor of stop 3 was dropped (anchor 1 ("services/orders/src/domain/order-state.ts" new 1-64): the file is not in this diff). Re-anchor the stop to lines this diff actually changes and call complete again.',
        ],
    },
    {
        name: 'section: range outside changed lines',
        run: () =>
            validateSection(
                asRawText(mediumRawResults().broken.sectionRangeOutsideChanges),
                plan(),
                [5],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0]: every anchor of stop 5 was dropped (anchor 1 ("services/orders/README.md" new 400-420): it covers no line changed on the new side). Re-anchor the stop to lines this diff actually changes and call complete again.',
        ],
    },
    {
        name: 'section: plan number belongs to another task',
        run: () =>
            validateSection(
                section([anchoredStop(3, [{ path: WINDOW, side: 'new', start: 1, end: 94 }])]),
                plan(),
                [1],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0].planIndex: stop 3 is not assigned to this task. Fill only these stops: 1.',
        ],
    },
    {
        name: 'section: plan number absent from the plan',
        run: () =>
            validateSection(
                section([anchoredStop(99, [{ path: WINDOW, side: 'new', start: 1, end: 94 }])]),
                plan(),
                [1],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0].planIndex: 99 is not a stop of the route plan (plan numbers are 1..6). Fill only the stops assigned to this task: 1.',
        ],
    },
    {
        name: 'section: attempts to fill the synthetic "Other" stop',
        run: () =>
            validateSection(
                section([anchoredStop(7, [{ path: WINDOW, side: 'new', start: 1, end: 94 }])]),
                plan(),
                [7],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0].planIndex: 7 is not a stop of the route plan (plan numbers are 1..6). Fill only the stops assigned to this task: 7.',
        ],
    },
    {
        name: 'section: end < start',
        run: () =>
            validateSection(
                section([anchoredStop(1, [{ path: WINDOW, side: 'new', start: 40, end: 12 }])]),
                plan(),
                [1],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0].anchors[0]: stop 1 has end (12) before start (40). An anchor is an inclusive range, so end must be >= start.',
        ],
    },
    {
        // The error path addresses the model JSON, not our processing order. The model submits stops
        // in any order it likes and uses this path to fix the result (rpc-design §3).
        name: 'section: invalid stop is not first in the model output',
        run: () =>
            validateSection(
                section([
                    anchoredStop(3, [{ path: WINDOW, side: 'new', start: 80, end: 40 }]),
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }]),
                ]),
                plan(),
                [1, 3],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0].anchors[0]: stop 3 has end (40) before start (80). An anchor is an inclusive range, so end must be >= start.',
        ],
    },
    {
        name: 'section: one stop filled twice',
        run: () =>
            validateSection(
                section([
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }]),
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 41, end: 94 }]),
                ]),
                plan(),
                [1],
                mediumDiff(),
            ),
        errors: ['section.stops[1].planIndex: stop 1 is filled twice in this result. Return one entry per stop.'],
    },
    {
        name: 'section: another stop takes the entire anchor and no other anchors remain',
        run: () =>
            validateSection(
                section([anchoredStop(2, [{ path: WINDOW, side: 'new', start: 10, end: 20 }])]),
                planWith(1, [{ path: WINDOW, side: 'new', start: 1, end: 94 }]),
                [2],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0]: every anchor of stop 2 was dropped (anchor 1 ("services/orders/src/domain/edit-window.ts" new 10-20): the range is already explained by stop 01). Re-anchor the stop to lines this diff actually changes and call complete again.',
        ],
    },
    {
        // When results compete for a range, the first accepted result wins (SPEC §4.3: keeps the first).
        // The competing stop number does not matter: the validator does not alter other fillings.
        // Orchestration (M2-T4) controls section acceptance order if it matters to route quality.
        name: 'section: a lower plan number cannot take a range from an accepted stop',
        run: () =>
            validateSection(
                section([anchoredStop(2, [{ path: WINDOW, side: 'new', start: 27, end: 56 }])]),
                planWith(5, [{ path: WINDOW, side: 'new', start: 1, end: 60 }]),
                [2],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0]: every anchor of stop 2 was dropped (anchor 1 ("services/orders/src/domain/edit-window.ts" new 27-56): the range is already explained by stop 05). Re-anchor the stop to lines this diff actually changes and call complete again.',
        ],
    },
    {
        name: 'section: empty stops array',
        run: () => validateSection(section([]), plan(), [1], mediumDiff()),
        patterns: [/^section\.stops: /],
    },
    {
        name: 'skeleton: filler phrase in summary',
        run: () =>
            validateSkeleton(
                asRawText({
                    ...mediumRawResults().skeleton,
                    summary: `${String(bannedPhrases('ru')[0])}: the PR introduces an edit window.`,
                }),
            ),
        errors: [
            `skeleton.summary: drop the filler phrase "${String(bannedPhrases('ru')[0])}" and state the fact directly (see Voice in the methodology).`,
        ],
    },
    {
        name: 'skeleton: emoji in stop title',
        run: () => {
            const skeleton = mediumRawResults().skeleton;
            const stops = skeleton.stops.map((stop, index) =>
                index === 0 ? { ...stop, title: `${stop.title} 🚀` } : stop,
            );
            return validateSkeleton(asRawText({ ...skeleton, stops }));
        },
        errors: [
            'skeleton.stops[0].title: contains emoji — route texts are plain prose (see Voice in the methodology).',
        ],
    },
    {
        name: 'section: filler phrase in paragraph',
        run: () =>
            validateSection(
                section([
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }], {
                        paragraph: `${String(bannedPhrases('ru')[1])}: the handler was rewritten.`,
                    }),
                ]),
                plan(),
                [1],
                mediumDiff(),
            ),
        errors: [
            `section.stops[0].paragraph: drop the filler phrase "${String(bannedPhrases('ru')[1])}" and state the fact directly (see Voice in the methodology).`,
        ],
    },
    {
        name: 'section: emoji in digest assertion',
        run: () =>
            validateSection(
                section([
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }], {
                        tests: [{ kind: 'new', text: 'Rejects edits after the window closes ✅', testPath: WINDOW, testLine: 12 }],
                    }),
                ]),
                plan(),
                [1],
                mediumDiff(),
            ),
        errors: [
            'section.stops[0].tests[0].text: contains emoji — route texts are plain prose (see Voice in the methodology).',
        ],
    },
    {
        // The change reason is reviewer-facing text just like the paragraph. Voice checks reject it
        // before stop classification so rejection does not depend on a previous snapshot being available.
        name: 'section: filler phrase in change reason',
        run: () =>
            validateSection(
                section([
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }], {
                        changeReason: `${String(bannedPhrases('ru')[4])}: the author rewrote the window calculation.`,
                    }),
                ]),
                plan(),
                [1],
                mediumDiff(),
            ),
        errors: [
            `section.stops[0].changeReason: drop the filler phrase "${String(bannedPhrases('ru')[4])}" and state the fact directly (see Voice in the methodology).`,
        ],
    },
    {
        name: 'en: filler phrase in summary',
        run: () =>
            validateSkeleton(
                asRawText({
                    ...mediumRawResultsEn().skeleton,
                    summary: 'It should be noted that the pull request adds an edit window.',
                }),
                'en',
            ),
        errors: [
            'skeleton.summary: drop the filler phrase "it should be noted" and state the fact directly (see Voice in the methodology).',
        ],
    },
    {
        name: 'en: emoji in stop title',
        run: () => {
            const skeleton = mediumRawResultsEn().skeleton;
            const stops = skeleton.stops.map((stop, index) =>
                index === 0 ? { ...stop, title: `${stop.title} 🚀` } : stop,
            );
            return validateSkeleton(asRawText({ ...skeleton, stops }), 'en');
        },
        errors: [
            'skeleton.stops[0].title: contains emoji — route texts are plain prose (see Voice in the methodology).',
        ],
    },
    {
        name: 'en: filler phrase in paragraph',
        run: () =>
            validateSection(
                section([
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }], {
                        paragraph: 'As we can see, the handler was rewritten.',
                    }),
                ]),
                planEn(),
                [1],
                mediumDiff(),
                { locale: 'en' },
            ),
        errors: [
            'section.stops[0].paragraph: drop the filler phrase "as we can see" and state the fact directly (see Voice in the methodology).',
        ],
    },
    {
        name: 'en: filler phrase in change reason',
        run: () =>
            validateSection(
                section([
                    anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }], {
                        paragraph: 'The handler was rewritten around the window.',
                        changeReason: 'Needless to say, the author rewrote the window computation.',
                    }),
                ]),
                planEn(),
                [1],
                mediumDiff(),
                { locale: 'en' },
            ),
        errors: [
            'section.stops[0].changeReason: drop the filler phrase "needless to say" and state the fact directly (see Voice in the methodology).',
        ],
    },
];

describe('route validator: negative corpus', () => {
    for (const testCase of CASES) {
        it(testCase.name, () => {
            const result = testCase.run();
            expect(result.ok).toBe(false);
            if (result.ok) {
                return;
            }
            if (testCase.errors !== undefined) {
                expect(result.errors).toEqual([...testCase.errors]);
            }
            if (testCase.patterns !== undefined) {
                expect(result.errors.length).toBe(testCase.patterns.length);
                testCase.patterns.forEach((pattern, index) => {
                    expect(result.errors[index]).toMatch(pattern);
                });
            }
        });
    }
});

describe('route validator: reduced functionality', () => {
    it('accepts JSON in a markdown fence', () => {
        for (const opening of ['```json', '```']) {
            const fenced = [opening, asRawText(mediumRawResults().skeleton), '```'].join('\n');
            const result = validateSkeleton(fenced);

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.value.stops.length).toBe(7);
            }
        }
    });

    it('rejects text that resembles a fence but is not one as invalid JSON', () => {
        const result = validateSkeleton('``` here is the route ```');

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors[0]).toMatch(/^Result is not valid JSON: /);
        }
    });

    it('lets the model send extra fields and strips them through the schema', () => {
        const raw = mediumRawResults().skeleton;
        const result = validateSkeleton(
            asRawText({
                ...raw,
                confidence: 0.9,
                stops: raw.stops.map((stop) => ({ ...stop, files: ['a.ts'] })),
            }),
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.stops[0]).not.toHaveProperty('files');
            expect(result.value.stops[0]?.title).toBe(raw.stops[0]?.title);
        }
    });

    it('preserves an anchor with context without clamping it to changed lines', () => {
        // README lines 25–27 and 43–52 changed on the new side. The 20–30 range includes context.
        const result = validateSection(
            section([anchoredStop(5, [{ path: README, side: 'new', start: 20, end: 30 }])]),
            plan(),
            [5],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.anchors).toEqual([
            {
                fileId: mediumDiff().files.find((file) => file.path === README)?.fileId,
                path: README,
                side: 'new',
                start: 20,
                end: 30,
                collapsed: false,
            },
        ]);
        expect(result.value[0]?.validationNotes).toEqual([]);
    });

    it('subtracts overlap with an accepted stop, trims the anchor and adds a reviewer note', () => {
        const result = validateSection(
            section([anchoredStop(2, [{ path: WINDOW, side: 'new', start: 40, end: 94 }])]),
            planWith(1, [{ path: WINDOW, side: 'new', start: 1, end: 50 }]),
            [2],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.anchors.map((anchor) => `${String(anchor.start)}-${String(anchor.end)}`)).toEqual([
            '51-94',
        ]);
        expect(result.value[0]?.validationNotes).toEqual([
            'Part of range `services/orders/src/domain/edit-window.ts` 40–94 is already explained by stop 01 — the anchor was trimmed.',
        ]);
    });

    it('splits the anchor in two when subtracting the middle of a range', () => {
        const result = validateSection(
            section([anchoredStop(2, [{ path: WINDOW, side: 'new', start: 1, end: 94 }])]),
            planWith(1, [{ path: WINDOW, side: 'new', start: 40, end: 50 }]),
            [2],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.anchors.map((anchor) => `${String(anchor.start)}-${String(anchor.end)}`)).toEqual([
            '1-39',
            '51-94',
        ]);
    });

    it('drops an anchor emptied by duplication and keeps its valid neighbor', () => {
        const result = validateSection(
            section([
                anchoredStop(2, [
                    { path: WINDOW, side: 'new', start: 10, end: 20 },
                    { path: CLOCK, side: 'new', start: 1, end: 33 },
                ]),
            ]),
            planWith(1, [{ path: WINDOW, side: 'new', start: 1, end: 94 }]),
            [2],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.anchors.map((anchor) => anchor.path)).toEqual([CLOCK]);
        expect(result.value[0]?.validationNotes).toEqual([
            'Range `services/orders/src/domain/edit-window.ts` 10–20 is already explained by stop 01.',
        ]);
    });

    it('drops a digest assertion without a test anchor and counts it', () => {
        const result = validateSection(
            section([
                anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 94 }], {
                    tests: [
                        { kind: 'new', text: 'The window closes after 30 minutes.' },
                        { kind: 'changed', text: 'A closed window returns 409.', testPath: WINDOW },
                    ],
                }),
            ]),
            plan(),
            [1],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.tests).toEqual([]);
        expect(result.value[0]?.droppedClaims).toBe(2);
        expect(result.value[0]?.validationNotes).toEqual([routeStrings('ru').claimsAnchorless(2)]);
    });

    it('drops a digest assertion anchored outside the diff and names the file', () => {
        const result = validateSection(
            section([
                anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 94 }], {
                    tests: [
                        {
                            kind: 'new',
                            text: 'The window closes after 30 minutes.',
                            testPath: 'services/orders/src/domain/__tests__/factories.ts',
                            testLine: 12,
                        },
                    ],
                }),
            ]),
            plan(),
            [1],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.droppedClaims).toBe(1);
        expect(result.value[0]?.validationNotes).toEqual([
            'One claim dropped: the anchor pointed at `services/orders/src/domain/__tests__/factories.ts`, which is not in this diff.',
        ]);
    });

    it('keeps uncovered with a path outside the diff in the digest without an anchor and drops nothing', () => {
        const result = validateSection(
            section([
                anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 94 }], {
                    tests: [
                        {
                            kind: 'uncovered',
                            text: 'PAN masking is uncovered.',
                            testPath: 'services/orders/src/payments/legacy.ts',
                            testLine: 4,
                        },
                    ],
                }),
            ]),
            plan(),
            [1],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.tests).toEqual([
            { kind: 'uncovered', text: 'PAN masking is uncovered.', anchor: null },
        ]);
        expect(result.value[0]?.droppedClaims).toBe(0);
        expect(result.value[0]?.validationNotes).toEqual([]);
    });

    it('adds a reviewer note for a dead anchor with a valid neighbor instead of rejecting the result', () => {
        const result = validateSection(
            section([
                anchoredStop(1, [
                    { path: WINDOW, side: 'new', start: 1, end: 94 },
                    { path: 'services/orders/src/domain/order-state.ts', side: 'new', start: 1, end: 10 },
                ]),
            ]),
            plan(),
            [1],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.anchors.map((anchor) => anchor.path)).toEqual([WINDOW]);
        expect(result.value[0]?.validationNotes).toEqual([
            'Anchor on `services/orders/src/domain/order-state.ts` dropped: the file is not in this diff.',
        ]);
    });

    it('keeps an anchor after an empty context line with the same numbering as the UI', () => {
        // Hosts trim trailing whitespace, so a context line arrives empty. It still counts as
        // a line. Otherwise the remaining hunk numbers diverge from what the model sees.
        const patch = [
            '--- a/clock.ts',
            '+++ b/clock.ts',
            '@@ -1,3 +1,3 @@',
            ' const a = 1;',
            '',
            '-const b = 2;',
            '+const b = 3;',
        ].join('\n');
        const diff = mediumDiff();
        const patched = {
            ...diff,
            files: diff.files.map((file) => (file.path === CLOCK ? { ...file, patch } : file)),
        };

        const result = validateSection(
            section([anchoredStop(1, [{ path: CLOCK, side: 'new', start: 3, end: 3 }])]),
            plan(),
            [1],
            patched,
        );

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value[0]?.anchors.map((anchor) => `${String(anchor.start)}-${String(anchor.end)}`)).toEqual([
            '3-3',
        ]);
        expect(result.value[0]?.validationNotes).toEqual([]);
    });

    it('does not conflict with itself when the same section is resubmitted', () => {
        const first = mediumRawResults().sections[0];
        const filled = planWith(1, [
            { path: WINDOW, side: 'new', start: 1, end: 94 },
            { path: CLOCK, side: 'new', start: 1, end: 33 },
        ]);
        const result = validateSection(asRawText(first), filled, [1], mediumDiff());

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value[0]?.anchors.length).toBe(2);
            expect(result.value[0]?.validationNotes).toEqual([]);
        }
    });
});

/**
 * The stop list belongs to the generation locale (M5-T4). A phrase in another language is not a violation,
 * so the validator does not reject a quotation from a discussion.
 */
describe('route validator: voice stop list in another language', () => {
    it('accepts a Russian filler phrase in English text', () => {
        const result = validateSection(
            section([
                anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }], {
                    paragraph: `The reviewer note said «${String(bannedPhrases('ru')[0])}» and the handler was rewritten.`,
                }),
            ]),
            planEn(),
            [1],
            mediumDiff(),
            { locale: 'en' },
        );

        expect(result.ok).toBe(true);
    });

    it('accepts an English filler phrase in Russian text', () => {
        const result = validateSection(
            section([
                anchoredStop(1, [{ path: WINDOW, side: 'new', start: 1, end: 40 }], {
                    paragraph: 'The author comment «it is worth noting» stayed in the code unchanged.',
                }),
            ]),
            plan(),
            [1],
            mediumDiff(),
        );

        expect(result.ok).toBe(true);
    });
});
