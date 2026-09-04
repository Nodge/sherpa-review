import type {
    RouteAnchor,
    RouteSectionResult,
    RouteSkeletonResult,
    RouteSnapshot,
    RouteStop,
    RouteTestClaim,
    RouteTestClaimKind,
    UiRouteState,
} from '@sherpa/protocol';

import { hashHex, makeFileId } from '../patch.js';
import { MEDIUM_BASE_COMMIT, MEDIUM_DIFF_ID, MEDIUM_HEAD_COMMIT } from './medium.js';

/**
 * Route for the `medium` fixture, the same "Enforce the 30-minute edit window…" PR (README §1–2).
 * The data is deterministic: the state gallery, e2e F1 and validator golden corpus (M2-T3) must
 * see the same numbers.
 *
 * The plan has 7 stops: 01–02 high, 03 medium, 04 medium (Behavioural test digest), 05–06 low,
 * 07 is synthetic "Other" (decision logged on 2026-08-25: id `other`, tier `other`, empty anchors,
 * with its contents, the uncovered ranges, computed by the UI).
 *
 * The handoff bar ("862 changed lines · 96% explained · 34 lines not explained") predates the images
 * from T23: anchors still cover the same 828 changed lines, but the added `countdown-icon.svg`
 * is invisible to the route (images always go to "Other"), leaving its 6 patch lines uncovered. Total: 868
 * changed lines, with 40 uncovered in four files: `CODEOWNERS` (5), `ci.yml` (12), the end of
 * generated `psp-schema.ts` (17), and the SVG (6).
 * UI coverage statistics count 38 of these (`psp-schema.ts` 15): two blank lines at its end outside
 * the anchors from the count (decision log, 2026-08-26).
 * By tier: high 196, medium 327, low 305 lines (the design counts 188/348/292 have the same bar proportions).
 * The `route.test.ts` test recalculates every count from diff patches rather than taking them on trust.
 *
 * An anchor covers only changed lines on one side. Its range contains no context,
 * so a file with small edits has many anchors (one per contiguous edit).
 */

export const SNAPSHOT_ID = 'route-medium-9f3c1ab';
const CREATED_AT = '2026-08-20T09:04:12.000Z';

/** File paths in the `medium` diff referenced by anchors. */
export const P = {
    window: 'services/orders/src/domain/edit-window.ts',
    clock: 'services/orders/src/infra/clock.ts',
    policy: 'services/orders/src/domain/policies/edit-policy.ts',
    order: 'services/orders/src/domain/order.ts',
    handlers: 'services/orders/src/api/handlers.ts',
    schemas: 'services/orders/src/api/schemas.ts',
    pciAudit: 'services/orders/src/payments/pci-audit.ts',
    cardToken: 'services/orders/src/payments/card-token.ts',
    logging: 'services/orders/src/infra/logging.ts',
    pspSchema: 'services/orders/src/payments/generated/psp-schema.ts',
    docs: 'services/orders/docs/edit-window.md',
    readme: 'services/orders/README.md',
    lock: 'pnpm-lock.yaml',
    policyTest: 'services/orders/src/domain/__tests__/edit-policy.test.ts',
    windowTest: 'services/orders/src/domain/__tests__/edit-window.test.ts',
    handlersTest: 'services/orders/src/api/__tests__/handlers.test.ts',
} as const;

/**
 * The file is outside the diff. Test files import helpers from it, but it has not changed.
 * The validator drops digest assertions anchored here (SPEC §4.3).
 */
const FACTORIES_PATH = 'services/orders/src/domain/__tests__/factories.ts';

function at(path: string, side: 'old' | 'new', start: number, end: number, collapsed = false): RouteAnchor {
    return { fileId: makeFileId(MEDIUM_DIFF_ID, path), path, side, start, end, collapsed };
}

function claim(
    kind: RouteTestClaimKind,
    text: string,
    anchor: { path: string; line: number } | null,
): RouteTestClaim {
    return {
        kind,
        text,
        anchor:
            anchor === null
                ? null
                : { fileId: makeFileId(MEDIUM_DIFF_ID, anchor.path), path: anchor.path, line: anchor.line },
    };
}

/**
 * A digest assertion as returned by the model. The anchor is a path and line in a test file.
 * With `dropped: true`, the validator drops it because the anchor points outside the diff. The snapshot
 * excludes that assertion and counts it only in `droppedClaims` (SPEC §4.3).
 */
export interface DigestEntry {
    kind: RouteTestClaimKind;
    text: string;
    test: { path: string; line: number } | null;
    dropped?: true;
}

/**
 * A stop in the model plan: the skeleton fields (title, tier, intent) plus section content.
 * `intent` is a draft description for filling tasks. The UI does not show it.
 */
export interface StopSpec {
    id: string;
    planIndex: number;
    tier: 'high' | 'medium' | 'low';
    title: string;
    intent: string;
    paragraph: string;
    bridge: string | null;
    anchors: RouteAnchor[];
    /** Digest as returned by the model. The snapshot and `droppedClaims` are computed from it. */
    digest: DigestEntry[];
    validationNotes: string[];
}

/** Payment assertion. The second iteration has its own text (`card-token.ts` left the PR). */
export const UNCOVERED_PAYMENTS: DigestEntry = {
    kind: 'uncovered',
    text: 'PAN masking in the reauthorize log and the recordedAt field in PCI audit records are uncovered. The diff has no payment tests.',
    test: null,
};

/**
 * Digest for stop 04: the model returned 14 assertions, and the validator accepted 12.
 * 6 `new`, 2 `changed`, 2 `weakened`, 2 `uncovered`. It dropped two whose anchors point
 * to `__tests__/factories.ts`, which is outside the diff.
 * By design, `uncovered` has no test anchor: one points to uncovered code,
 * the other has no anchor at all (the diff has no file to attach it to).
 */
const DIGEST: DigestEntry[] = [
    {
        kind: 'new',
        text: 'The window is open immediately after the order is placed. `isOpen` is true.',
        test: { path: P.windowTest, line: 10 },
    },
    {
        kind: 'new',
        text: 'After 30 minutes and one millisecond, the window is closed.',
        test: { path: P.windowTest, line: 17 },
    },
    {
        kind: 'new',
        text: 'An express slot (`scheduled: false`) has no window at all.',
        test: { path: P.windowTest, line: 24 },
    },
    {
        kind: 'new',
        text: 'For open-window cases, the makeOrder factory builds an order with a scheduled slot by default.',
        test: { path: FACTORIES_PATH, line: 12 },
        dropped: true,
    },
    {
        kind: 'new',
        text: 'Dispatch to the courier closes the window early with reason `dispatch`.',
        test: { path: P.windowTest, line: 44 },
    },
    {
        kind: 'new',
        text: 'Dispatch after the deadline does not close the window. The deadline takes precedence.',
        test: { path: P.windowTest, line: 57 },
    },
    {
        kind: 'new',
        text: 'Fresh food shortens the window to 10 minutes, pharmacy to 5. The shortest window wins in a mixed cart.',
        test: { path: P.windowTest, line: 64 },
    },
    {
        kind: 'changed',
        text: 'A closed window returns 409 with body {error, remainingMs}. The same test previously expected 400 for an "order without a slot".',
        test: { path: P.handlersTest, line: 19 },
    },
    {
        kind: 'changed',
        text: 'The makeSlot factory can now return an express slot, used to test the absence of a window.',
        test: { path: FACTORIES_PATH, line: 24 },
        dropped: true,
    },
    {
        kind: 'changed',
        text: 'The accepted-edit audit check compares record contents (kind, orderId) instead of array length.',
        test: { path: P.handlersTest, line: 76 },
    },
    {
        kind: 'weakened',
        text: 'The "reports the remaining time while the window is open" test only checks status 204. It does not assert the remaining time in the response, despite its name.',
        test: { path: P.handlersTest, line: 25 },
    },
    {
        kind: 'weakened',
        text: 'The express-order check only compares reason. Adjacent cases compare the whole decision, but this one does not assert allowed.',
        test: { path: P.policyTest, line: 42 },
    },
    {
        kind: 'uncovered',
        text: 'The express-delivery wording ("Express delivery cannot be rescheduled") is untested. Only the closed-window case checks explain.',
        test: { path: P.window, line: 92 },
    },
    UNCOVERED_PAYMENTS,
];

/** Assertions accepted by the validator. Dropped assertions have anchors outside the diff. */
export function acceptedClaims(entries: readonly DigestEntry[]): RouteTestClaim[] {
    return entries
        .filter((entry) => entry.dropped !== true)
        .map((entry) => claim(entry.kind, entry.text, entry.test));
}

export function droppedCount(entries: readonly DigestEntry[]): number {
    return entries.filter((entry) => entry.dropped === true).length;
}

/** Stops created by the model. The server synthesizes "Other", so it is absent from the skeleton. */
export const MODEL_STOPS: StopSpec[] = [
    {
        id: 's01',
        planIndex: 1,
        tier: 'high',
        title: 'The edit window becomes a domain concept',
        intent: 'The new EditWindow class and injectable Clock: where the 30-minute rule lives and why it is testable.',
        paragraph:
            'The new `EditWindow` class and injectable `Clock` time source open the window when the order is placed and close it after `EDIT_WINDOW_MS`, while dispatch to a courier closes it early. Categories shorten the window to 10 minutes for fresh food and 5 for pharmacy items, and the shortest window wins for the basket. As a consequence, whether an order can still be edited is computed in exactly one place and depends on a clock replaced by `FrozenClock` in tests.',
        bridge: 'Next, how the edit policy stopped doing its own time calculations.',
        anchors: [at(P.window, 'new', 1, 94), at(P.clock, 'new', 1, 33)],
        digest: [],
        validationNotes: [],
    },
    {
        id: 's02',
        planIndex: 2,
        tier: 'high',
        title: 'The policy decides through `EditWindow` instead of the clock',
        intent: 'EditPolicy now uses EditWindow and machine-readable rejection codes. The order model becomes strict.',
        paragraph:
            '`EditPolicy` no longer accepts a number of hours. It receives `EditWindow` and returns a decision with a machine-readable rejection code (`edit-window-closed`, `already-dispatched`, `not-scheduled`) instead of a free-form string. In `Order`, `slot` and `scheduled` became required, `items` and `dispatchedAt` were added, and the duplicate `editable` flag was removed. As a result, every caller must handle three rejection reasons, and reading "editable" can no longer bypass the policy.',
        bridge: 'Below, what callers see: response codes, audit records and documentation.',
        anchors: [
            at(P.policy, 'old', 2, 2),
            at(P.policy, 'new', 2, 2),
            at(P.policy, 'old', 6, 6),
            at(P.policy, 'new', 6, 6),
            at(P.policy, 'new', 8, 9),
            at(P.policy, 'old', 25, 25),
            at(P.policy, 'new', 27, 27),
            at(P.policy, 'old', 28, 34),
            at(P.policy, 'new', 30, 43),
            at(P.policy, 'new', 45, 56),
            at(P.order, 'old', 16, 16),
            at(P.order, 'new', 16, 18),
            at(P.order, 'old', 37, 38),
            at(P.order, 'new', 39, 40),
            at(P.order, 'new', 42, 46),
            at(P.order, 'new', 62, 76),
        ],
        digest: [],
        validationNotes: [],
    },
    {
        id: 's03',
        planIndex: 3,
        tier: 'medium',
        title: 'API boundary: rejection codes, audit records and documented rules',
        intent: 'Endpoint HTTP contracts, request and response schemas, PCI audit records, PAN masking and a new rules document.',
        paragraph:
            'The `patchOrder` and `getEditWindow` endpoints now validate the body against a schema, map rejection codes to HTTP statuses (409 for a closed window or dispatched order, 400 for express delivery) and return the remaining time with a human-readable explanation. PCI audit records gained `remainingMs` and `recordedAt`, the `reauthorize` log masks PAN, and the move to PSP v4 replaced `pan` with `token` in the request. As a consequence, the response contract grew and is fully described in the new `docs/edit-window.md`, while the client countdown is officially advisory: the server recalculates the window itself.',
        bridge: 'The model collected checks for all this in the digest at the next stop.',
        anchors: [
            at(P.handlers, 'old', 2, 2),
            at(P.handlers, 'new', 2, 4),
            at(P.handlers, 'old', 5, 5),
            at(P.handlers, 'new', 7, 9),
            at(P.handlers, 'old', 42, 45),
            at(P.handlers, 'new', 46, 54),
            at(P.handlers, 'old', 49, 49),
            at(P.handlers, 'new', 58, 59),
            at(P.handlers, 'old', 70, 70),
            at(P.handlers, 'new', 80, 91),
            at(P.schemas, 'old', 9, 9),
            at(P.schemas, 'new', 9, 11),
            at(P.schemas, 'new', 14, 15),
            at(P.schemas, 'new', 30, 38),
            at(P.pciAudit, 'old', 18, 18),
            at(P.pciAudit, 'new', 18, 24),
            at(P.pciAudit, 'old', 21, 22),
            at(P.pciAudit, 'new', 27, 33),
            at(P.cardToken, 'old', 45, 45),
            at(P.cardToken, 'new', 45, 49),
            at(P.cardToken, 'old', 47, 47),
            at(P.cardToken, 'new', 51, 51),
            at(P.cardToken, 'new', 53, 56),
            at(P.logging, 'old', 31, 31),
            at(P.logging, 'new', 31, 31),
            at(P.logging, 'old', 34, 37),
            at(P.logging, 'new', 34, 37),
            at(P.logging, 'new', 52, 53),
            at(P.logging, 'new', 55, 61),
            // Only the replacement of `pan` with `token` is marked in the generated PSP schema.
            // The rest of the file stays in "Other", as intended.
            at(P.pspSchema, 'new', 3, 3),
            at(P.pspSchema, 'new', 7, 8),
            at(P.docs, 'new', 1, 52),
        ],
        digest: [],
        validationNotes: [],
    },
    {
        id: 's04',
        planIndex: 4,
        tier: 'medium',
        title: 'Behaviour under test: 12 assertions',
        intent: 'Behavioural test digest: what window, policy and endpoint tests cover, where an assertion weakened and where behaviour remains untested.',
        paragraph:
            'The window tests were written from scratch, and the policy and endpoint tests were rewritten for the new rejection codes. They cover the 30-minute boundary, early dispatch, express delivery without a window and category overrides. Two assertions check less than their names promise, while PAN masking and the `recordedAt` write are uncovered. As a result, tests support the window behaviour, while the payment changes rely on reading the code.',
        bridge: 'The rest of the diff is maintenance: README and dependency updates.',
        anchors: [
            at(P.policyTest, 'old', 5, 5),
            at(P.policyTest, 'new', 5, 7),
            at(P.policyTest, 'old', 7, 7),
            at(P.policyTest, 'new', 9, 10),
            at(P.policyTest, 'new', 28, 54),
            at(P.windowTest, 'new', 1, 92),
            at(P.handlersTest, 'old', 19, 21),
            at(P.handlersTest, 'new', 19, 27),
            at(P.handlersTest, 'new', 29, 51),
            at(P.handlersTest, 'old', 47, 47),
            at(P.handlersTest, 'new', 76, 85),
        ],
        digest: DIGEST,
        validationNotes: [
            `2 claims dropped: the anchor pointed at \`${FACTORIES_PATH}\`, which is not in this diff.`,
        ],
    },
    {
        id: 's05',
        planIndex: 5,
        tier: 'low',
        title: '`README.md` catches up with the domain layout',
        intent: 'The domain and test sections: new files, the removed config setting and the FrozenClock rule.',
        paragraph:
            'The domain section names `edit-window.ts` and `infra/clock.ts` and no longer references the `checkout.edit_window_hours` config setting. The test section requires `FrozenClock` instead of `Date.now()` in `domain/`. As a result, the clock rule and the window test command are where readers look first.',
        bridge: 'Last come the generated lockfile lines.',
        anchors: [
            at(P.readme, 'old', 25, 26),
            at(P.readme, 'new', 25, 27),
            at(P.readme, 'old', 42, 42),
            at(P.readme, 'new', 43, 52),
            at(P.docs, 'new', 53, 115),
        ],
        digest: [],
        validationNotes: [],
    },
    {
        id: 's06',
        planIndex: 6,
        tier: 'low',
        title: 'Lockfile update',
        intent: 'Generated changes from the move to PSP v4: the lockfile was rebuilt in full, with nothing to read line by line.',
        paragraph:
            '`pnpm-lock.yaml` was rebuilt in full: 217 added lines against 9 deleted, generated by the move to PSP v4. As a result, there is nothing to read line by line. What matters is that the same package manager rebuilt it, so both anchors are marked collapsed.',
        bridge: null,
        anchors: [at(P.lock, 'old', 15, 23, true), at(P.lock, 'new', 15, 231, true)],
        digest: [],
        validationNotes: [],
    },
];

/** Separate summary paragraphs. The second pass rebuilds only the one describing the contract. */
export const SUMMARY_PARTS = [
    'The PR introduces a 30-minute edit window for scheduled delivery as a domain concept. It adds `EditWindow` and an injectable `Clock`. `EditPolicy` stops doing its own time calculations and returns a machine-readable rejection code, while the order model loses optional fields and the duplicate `editable` flag.',
    'The external contract grew: `patchOrder` validates the body against a schema and returns 409 or 400 with the remaining time and a human-readable explanation, while `getEditWindow` returns the full decision. PCI audit records gained the remaining time and recording timestamp, PAN is masked in the `reauthorize` log, and the generated PSP schema moved from `pan` to `token`.',
    'The rules are described in the new `docs/edit-window.md` along with the rollout order behind the `checkout_edit_window` flag. Window tests were written from scratch, and policy and endpoint tests were rewritten. The route leaves out the `CODEOWNERS` ownership rules, generated `ci.yml` and the tail of the generated PSP schema.',
];

export const SUMMARY = SUMMARY_PARTS.join('\n\n');

/**
 * Full tour order: entry point (API boundary and rules) → definitions (window, policy)
 * → consequences (README, dependencies) → verification (test digest), with "Other" last.
 */
export const TOUR_ORDER = ['s03', 's01', 's02', 's05', 's06', 's04', 'other'];

/** Synthetic "Other": the server sets the title, and the UI computes content from uncovered ranges. */
export function otherStop(): RouteStop {
    return {
        id: 'other',
        planIndex: MODEL_STOPS.length + 1,
        tier: 'other',
        title: 'Other: the model did not place these lines',
        status: 'ready',
        paragraph: null,
        bridge: null,
        anchors: [],
        tests: [],
        droppedClaims: 0,
        validationNotes: [],
        provenance: null,
        // Classify stops after a push in M4-T7.
        change: null,
    };
}

export function filledStop(spec: StopSpec): RouteStop {
    return {
        id: spec.id,
        planIndex: spec.planIndex,
        tier: spec.tier,
        title: spec.title,
        status: 'ready',
        paragraph: spec.paragraph,
        bridge: spec.bridge,
        anchors: spec.anchors,
        tests: acceptedClaims(spec.digest),
        droppedClaims: droppedCount(spec.digest),
        validationNotes: spec.validationNotes,
        provenance: null,
        change: null,
    };
}

/** Planned slot before filling: the skeleton fixes its title and number, but it has no content yet. */
function plannedStop(spec: StopSpec, status: 'queued' | 'filling'): RouteStop {
    return {
        id: spec.id,
        planIndex: spec.planIndex,
        tier: spec.tier,
        title: spec.title,
        status,
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

/** Canonical JSON: keys are sorted alphabetically so the fingerprint ignores field order in literals. */
export function canonical(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(',')}]`;
    }
    if (typeof value === 'object' && value !== null) {
        return `{${Object.entries(value)
            .sort(([left], [right]) => (left < right ? -1 : 1))
            .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function snapshot(stops: RouteStop[], hashed: boolean): RouteSnapshot {
    const base: RouteSnapshot = {
        snapshotId: SNAPSHOT_ID,
        commit: MEDIUM_HEAD_COMMIT,
        baseCommit: MEDIUM_BASE_COMMIT,
        diffId: MEDIUM_DIFF_ID,
        createdAt: CREATED_AT,
        provenance: { harness: 'claude-code', model: 'claude-opus-5', locale: null },
        // Second pass through snapshots in M4-T6.
        previousSnapshotId: null,
        carried: null,
        summary: SUMMARY,
        stops,
        tourOrder: TOUR_ORDER,
        contentHash: null,
    };
    // The hash is computed from the completed snapshot alone. It is absent during filling.
    return hashed ? { ...base, contentHash: hashHex(canonical(base), 16) } : base;
}

function readySnapshot(): RouteSnapshot {
    return snapshot([...MODEL_STOPS.map(filledStop), otherStop()], true);
}

/**
 * Partially filled route exactly as in README §7: 01, 02 and 05 are ready, "3 of 7 ready",
 * the indicators are not filled left to right. 06 is in progress, 03 and 04 are queued, "Other" is ready at once.
 */
function fillingSnapshot(): RouteSnapshot {
    const ready = new Set(['s01', 's02', 's05']);
    const stops = MODEL_STOPS.map((spec) => {
        if (ready.has(spec.id)) {
            return filledStop(spec);
        }
        return plannedStop(spec, spec.id === 's06' ? 'filling' : 'queued');
    });
    return snapshot([...stops, otherStop()], false);
}

/**
 * Raw model output that failed validation: two stops reference a file
 * that is not in the diff. Shown in "Open raw output" (README §12), this is model output,
 * not a validator report.
 */
const FAILED_RAW_OUTPUT = `{
  "summary": "The PR introduces a 30-minute edit window for scheduled delivery…",
  "stops": [
    {
      "planIndex": 1,
      "paragraph": "Order state moved into a separate module…",
      "anchors": [
        { "path": "services/orders/src/domain/order-state.ts", "side": "new", "start": 1, "end": 64 }
      ]
    },
    {
      "planIndex": 2,
      "paragraph": "The edit policy reads order state…",
      "anchors": [
        { "path": "services/orders/src/domain/order-state.ts", "side": "new", "start": 66, "end": 91 },
        { "path": "services/orders/src/domain/policies/edit-policy.ts", "side": "new", "start": 30, "end": 43 }
      ]
    }
  ]
}`;

/** Route states for the `medium` fixture gallery: one per `uiRoutePhaseSchema` phase. */
export function makeMediumRouteStates(): Record<'none' | 'reading' | 'filling' | 'ready' | 'failed', UiRouteState> {
    // Route staleness is handled in M4-T4.
    return {
        none: { phase: 'none', smallPr: false, snapshot: null, failure: null, stale: null },
        reading: { phase: 'reading', smallPr: false, snapshot: null, failure: null, stale: null },
        filling: { phase: 'filling', smallPr: false, snapshot: fillingSnapshot(), failure: null, stale: null },
        ready: { phase: 'ready', smallPr: false, snapshot: readySnapshot(), failure: null, stale: null },
        failed: {
            phase: 'failed',
            smallPr: false,
            snapshot: null,
            stale: null,
            failure: {
                message:
                    'Generation stopped at validation: 2 stops reference services/orders/src/domain/order-state.ts, which is not in this diff.',
                rawOutput: FAILED_RAW_OUTPUT,
            },
        },
    };
}

/** Skeleton as seen by the model: it has no "Other", which the server synthesizes on acceptance. */
export function makeMediumSkeletonResult(): RouteSkeletonResult {
    return {
        summary: SUMMARY,
        stops: MODEL_STOPS.map((spec) => ({ title: spec.title, tier: spec.tier, intent: spec.intent })),
        // The same tour as in the snapshot, with planned numbers and without synthetic "Other".
        tourOrder: TOUR_ORDER.filter((id) => id !== 'other').map((id) => {
            const spec = MODEL_STOPS.find((candidate) => candidate.id === id);
            if (spec === undefined) {
                throw new Error(`tourOrder references stop ${id}, which is missing from the plan`);
            }
            return spec.planIndex;
        }),
    };
}

/** The model returns anchors by `path`. The validator resolves `fileId` against the active iteration. */
export function rawAnchors(spec: StopSpec): RouteSectionResult['stops'][number]['anchors'] {
    return spec.anchors.map(({ path, side, start, end, collapsed }) =>
        collapsed ? { path, side, start, end, collapsed } : { path, side, start, end },
    );
}

/**
 * The full digest as returned by the model, including assertions the validator will drop.
 * The snapshot must compute `droppedClaims` from these, instead of hardcoding it.
 */
export function rawClaims(entries: readonly DigestEntry[]): NonNullable<RouteSectionResult['stops'][number]['tests']> {
    // For `uncovered`, `testPath` contains a code anchor. This assertion has no test anchor.
    return entries.map((entry) =>
        entry.test === null
            ? { kind: entry.kind, text: entry.text }
            : { kind: entry.kind, text: entry.text, testPath: entry.test.path, testLine: entry.test.line },
    );
}

function sectionOf(spec: StopSpec): RouteSectionResult {
    return {
        stops: [
            {
                planIndex: spec.planIndex,
                paragraph: spec.paragraph,
                ...(spec.bridge === null ? {} : { bridge: spec.bridge }),
                anchors: rawAnchors(spec),
                ...(spec.digest.length === 0 ? {} : { tests: rawClaims(spec.digest) }),
            },
        ],
    };
}

/** One section per planned stop, in plan order. The e2e fake worker submits them one by one. */
export function makeMediumSectionResults(): RouteSectionResult[] {
    return MODEL_STOPS.map(sectionOf);
}

/**
 * Broken model outputs for validator negative tests (M2-T3). They satisfy the protocol
 * schemas but break semantics, so they do not go through `parse` during construction.
 */
export function makeMediumBrokenResults(): {
    sectionUnknownFile: RouteSectionResult;
    sectionRangeOutsideChanges: RouteSectionResult;
    skeletonTourOrderNotPermutation: RouteSkeletonResult;
} {
    return {
        sectionUnknownFile: {
            stops: [
                {
                    planIndex: 3,
                    paragraph: 'Order state moved into a separate module, and the policy reads it from there.',
                    anchors: [
                        { path: 'services/orders/src/domain/order-state.ts', side: 'new', start: 1, end: 64 },
                    ],
                },
            ],
        },
        sectionRangeOutsideChanges: {
            stops: [
                {
                    planIndex: 5,
                    paragraph: 'README describes the new domain layout.',
                    // The file has 52 lines, and none changed in this range.
                    anchors: [{ path: P.readme, side: 'new', start: 400, end: 420 }],
                },
            ],
        },
        skeletonTourOrderNotPermutation: {
            ...makeMediumSkeletonResult(),
            // Stop 3 appears twice, and stop 4 is missing entirely.
            tourOrder: [3, 1, 2, 5, 6, 3],
        },
    };
}
