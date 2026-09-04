import type { RouteSectionResult, RouteSkeletonResult } from '@sherpa/protocol';

import { MODEL_STOPS, P, rawAnchors } from './route-medium.js';

/**
 * English raw model output set for the `medium` fixture (M5-T4): the same PR and anchors,
 * with text in generation language `en`. Data for the validator golden corpus and gallery: without it,
 * tests of the English voice stop list and English validator annotations would use invented data.
 *
 * The plan matches the Russian set in contents and order, keeping stop numbers and `tourOrder` consistent
 * with the coverage fixture. There are three sections: 01 (prose and bridge), 02 (multiple anchors), and 04 (digest
 * with two dropped assertions, showing the validator annotation in English).
 */

const SUMMARY_EN = [
    'The pull request introduces a 30-minute edit window for scheduled delivery orders: after the',
    'window closes, the order can no longer be edited, and the API answers with a machine-readable',
    'refusal instead of a free-form string.',
    '',
    'The window itself becomes a domain concept with an injectable clock, the edit policy stops',
    'counting hours on its own, and the payment audit records every accepted edit.',
].join('\n');

/** Plan titles and intents follow the stops in the Russian set to keep the numbers consistent. */
const PLAN_EN: readonly { title: string; intent: string }[] = [
    {
        title: 'The edit window became a domain concept',
        intent: 'The new EditWindow class and an injectable Clock: where the 30-minute rule lives and why it is testable.',
    },
    {
        title: 'The policy decides by `EditWindow`, not by the clock',
        intent: 'EditPolicy moved onto EditWindow and machine-readable refusal codes; the order model became strict.',
    },
    {
        title: 'The API answers with a refusal code and an audit record',
        intent: 'Handlers, schemas and the PCI audit: what the outside world sees when the window is closed.',
    },
    {
        title: 'Tests of the window and of the handlers',
        intent: 'The behavioural contract of the window, of the policy and of the API, plus what stayed unchecked.',
    },
    {
        title: 'Documentation and logging of the new rule',
        intent: 'Docs, README and the logging of the edit window: low-signal changes that still belong to the story.',
    },
    {
        title: 'Lock file and generated schema',
        intent: 'Mechanical changes: the lock file and the generated PSP schema, folded by default.',
    },
];

/** The file is absent from the diff: the validator drops its 2 digest assertions (SPEC §4.3). */
const FACTORIES_PATH = 'services/orders/src/domain/__tests__/factories.ts';

/** English digest for stop 04: the same anchor layout, including the two dropped anchors. */
const DIGEST_EN: readonly {
    kind: 'new' | 'changed' | 'weakened' | 'uncovered';
    text: string;
    test: { path: string; line: number } | null;
}[] = [
    { kind: 'new', text: 'The window is open right after the order is placed.', test: { path: P.windowTest, line: 10 } },
    {
        kind: 'new',
        text: 'One millisecond past 30 minutes the window is closed.',
        test: { path: P.windowTest, line: 17 },
    },
    {
        kind: 'new',
        text: 'An express slot (`scheduled: false`) has no window at all.',
        test: { path: P.windowTest, line: 24 },
    },
    {
        kind: 'new',
        text: 'Orders for the open-window cases come from the makeOrder factory with a scheduled slot by default.',
        test: { path: FACTORIES_PATH, line: 12 },
    },
    {
        kind: 'new',
        text: 'Dispatch closes the window early, with reason `dispatch`.',
        test: { path: P.windowTest, line: 44 },
    },
    {
        kind: 'new',
        text: 'Dispatch after the deadline does not close the window — the deadline wins.',
        test: { path: P.windowTest, line: 57 },
    },
    {
        kind: 'new',
        text: 'Fresh products shorten the window to 10 minutes, pharmacy to 5, and a mixed cart takes the shortest.',
        test: { path: P.windowTest, line: 64 },
    },
    {
        kind: 'changed',
        text: 'A closed window answers 409 with {error, remainingMs}; the same test used to expect 400 for a slotless order.',
        test: { path: P.handlersTest, line: 19 },
    },
    {
        kind: 'changed',
        text: 'The makeSlot factory learned to return an express slot, and the missing window is checked on it.',
        test: { path: FACTORIES_PATH, line: 24 },
    },
    {
        kind: 'changed',
        text: 'The audit of an accepted edit is checked by record contents (kind, orderId) instead of array length.',
        test: { path: P.handlersTest, line: 76 },
    },
    {
        kind: 'weakened',
        text: 'The test "reports the remaining time while the window is open" asserts status 204 only; the remaining time its name promises is never checked.',
        test: { path: P.handlersTest, line: 25 },
    },
    {
        kind: 'weakened',
        text: 'The express order is compared by the reason field alone: neighbouring cases compare the whole decision, here allowed is not asserted.',
        test: { path: P.policyTest, line: 42 },
    },
    {
        kind: 'uncovered',
        text: 'The express wording ("Express delivery cannot be rescheduled") is not checked: explain is exercised for the closed window only.',
        test: { path: P.window, line: 92 },
    },
    {
        kind: 'uncovered',
        text: 'PAN masking in the reauthorize log and the recordedAt field of PCI audit records are uncovered — the diff has no payment tests.',
        test: null,
    },
];

/** Prose for the stops to fill, keyed by plan index. */
const PROSE_EN: ReadonlyMap<number, { paragraph: string; bridge: string | null }> = new Map([
    [
        1,
        {
            paragraph:
                'The `EditWindow` class and an injectable `Clock` appeared: the window opens when the order is placed and closes after `EDIT_WINDOW_MS`, while dispatch closes it early. Categories shorten the window — fresh products to 10 minutes, pharmacy to 5 — and a cart takes the shortest one. As a result, the answer to "can this order still be edited" is computed in exactly one place and depends on a clock that tests replace with `FrozenClock`.',
            bridge: 'Next: how the edit policy stopped counting hours on its own.',
        },
    ],
    [
        2,
        {
            paragraph:
                '`EditPolicy` no longer takes a number of hours — it takes an `EditWindow` and returns a decision with a machine-readable refusal code (`edit-window-closed`, `already-dispatched`, `not-scheduled`) instead of a free-form string. In `Order` the `slot` and `scheduled` fields became required, `items` and `dispatchedAt` appeared, and the duplicate `editable` flag is gone. Every caller now has to handle three refusal reasons, and reading "editable" around the policy is no longer possible.',
            bridge: 'Below: what the outside world sees — response codes, the audit and the docs.',
        },
    ],
    [
        4,
        {
            paragraph:
                'The tests state the contract of the window, of the policy and of the API: when the window is open, when dispatch closes it early, and what the handler answers once it is closed. Two assertions got weaker along the way, and the payment path stayed uncovered.',
            bridge: null,
        },
    ],
]);

export function makeMediumSkeletonResultEn(): RouteSkeletonResult {
    return {
        summary: SUMMARY_EN,
        stops: MODEL_STOPS.map((spec, index) => {
            const plan = PLAN_EN[index];
            if (plan === undefined) {
                throw new Error(`English plan is missing stop ${String(spec.planIndex)}`);
            }
            return { title: plan.title, tier: spec.tier, intent: plan.intent };
        }),
        tourOrder: MODEL_STOPS.map((spec) => spec.planIndex),
    };
}

/** One section per stop in `PROSE_EN`, in plan order. */
export function makeMediumSectionResultsEn(): RouteSectionResult[] {
    return MODEL_STOPS.filter((spec) => PROSE_EN.has(spec.planIndex)).map((spec) => {
        const prose = PROSE_EN.get(spec.planIndex);
        if (prose === undefined) {
            throw new Error(`no English prose for stop ${String(spec.planIndex)}`);
        }
        return {
            stops: [
                {
                    planIndex: spec.planIndex,
                    paragraph: prose.paragraph,
                    ...(prose.bridge === null ? {} : { bridge: prose.bridge }),
                    anchors: rawAnchors(spec),
                    ...(spec.planIndex === 4
                        ? {
                              tests: DIGEST_EN.map((entry) =>
                                  entry.test === null
                                      ? { kind: entry.kind, text: entry.text }
                                      : {
                                            kind: entry.kind,
                                            text: entry.text,
                                            testPath: entry.test.path,
                                            testLine: entry.test.line,
                                        },
                              ),
                          }
                        : {}),
                },
            ],
        };
    });
}
