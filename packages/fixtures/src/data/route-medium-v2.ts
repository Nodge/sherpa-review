import type {
    RouteAnchor,
    RouteSectionResult,
    RouteSkeletonResult,
    RouteSnapshot,
    RouteStop,
    RouteStopChange,
    UiRouteState,
} from '@sherpa/protocol';

import { hashHex, makeFileId } from '../patch.js';
import { MEDIUM_BASE_COMMIT, MEDIUM_DIFF_ID_V2, MEDIUM_HEAD_COMMIT_V2 } from './medium.js';
import type { DigestEntry, StopSpec } from './route-medium.js';
import {
    acceptedClaims,
    canonical,
    droppedCount,
    makeMediumBrokenResults,
    makeMediumSkeletonResult,
    MODEL_STOPS,
    otherStop,
    P,
    rawAnchors,
    rawClaims,
    SNAPSHOT_ID,
    SUMMARY_PARTS,
    TOUR_ORDER,
    UNCOVERED_PAYMENTS,
} from './route-medium.js';

/**
 * Route for the same `medium` fixture after the second push (`docs/design/README.md §9`): the same plan, with three stops
 * rebuilt. Stops 02 and 03 changed, and 06 is entirely new. Progress was carried over from the first snapshot:
 * three of the six stops with anchors remain viewed.
 *
 * Anchors recalculated for the second iteration: `edit-policy.ts` and `handlers.ts` gained a few
 * lines, `card-token.ts` left the PR, and `api/rejection-status.ts` appeared.
 */

const SNAPSHOT_ID_V2 = 'route-medium-a71d4e2';
const CREATED_AT_V2 = '2026-08-21T11:12:40.000Z';

/**
 * How many marked stops from the first pass survived the push. The denominator counts stops with anchors:
 * six model stops. Carryover cannot cover "Other". Three changed, leaving three.
 */
const CARRIED = { kept: 3, total: 6, zeroReason: null } as const;

/**
 * Second-pass summary: only the external-contract paragraph was rebuilt, with the new rejection-body
 * builder and PAN masking removed from the PR along with `card-token.ts`. The push left the other paragraphs untouched.
 */
const SUMMARY_V2 = SUMMARY_PARTS.map((part, index) =>
    index === 1
        ? 'The external contract expanded: `patchOrder` validates the body against a schema and returns 409 or 400 with a human-readable explanation, `getEditWindow` returns the full decision, and the new `api/rejection-status.ts` builds the rejection body. Remaining time is returned only for a closed window. PCI audit records gained remaining time and a recorded timestamp, and the generated PSP schema switched from `pan` to `token`. PAN masking left the PR along with `card-token.ts`.'
        : part,
).join('\n\n');

/** Stop intents in the second-pass plan: 03 no longer lists payment changes. */
const INTENT_V2: Record<string, string> = {
    s03: 'HTTP contract for endpoints, the new rejection-body builder, request and response schemas, PCI audit records, and the rules document.',
};

/** Second-pass digest: only `recordedAt` remains uncovered, since the PR no longer has PAN masking. */
function digestV2(entries: readonly DigestEntry[]): DigestEntry[] {
    return entries.map((entry) =>
        entry === UNCOVERED_PAYMENTS
            ? {
                  ...entry,
                  text: 'The recordedAt field in PCI audit records is uncovered. The diff contains no payment tests.',
              }
            : entry,
    );
}

function at(path: string, side: 'old' | 'new', start: number, end: number, collapsed = false): RouteAnchor {
    return { fileId: makeFileId(MEDIUM_DIFF_ID_V2, path), path, side, start, end, collapsed };
}

/** Unchanged stop: the same ranges, with `fileId` resolved against the new iteration. */
function reanchor(anchors: readonly RouteAnchor[]): RouteAnchor[] {
    return anchors.map((anchor) => ({ ...anchor, fileId: makeFileId(MEDIUM_DIFF_ID_V2, anchor.path) }));
}

interface StopChangeSpec {
    kind: RouteStopChange['kind'];
    reason: string;
    threadIds?: string[];
    paragraph: string;
    anchors: RouteAnchor[];
}

/**
 * What the second push did to each affected stop. `changed` means some ranges were touched,
 * `new` means all: the lockfile was rebuilt entirely, with no lines left from the old block. In v2, the lockfile
 * has anchors only on the `new` side: the iterations share a base, so the old side carries over unchanged,
 * and an anchor there would make the stop `changed`.
 */
const CHANGED: Record<string, StopChangeSpec> = {
    s02: {
        kind: 'changed',
        reason: 'The author addressed the linter comment: `switch` gained a `default` branch, and the rejection reasons became the `EDIT_REJECTIONS` constant.',
        paragraph:
            '`EditPolicy` still receives `EditWindow` and returns a decision with a machine-readable rejection code, but the code list is now an explicit `EDIT_REJECTIONS` constant, and `switch` ends with a `default` branch checking `never`. `Order` is unchanged: `slot` and `scheduled` are required, and the duplicate `editable` flag remains removed. Consequence: a new rejection code cannot be added silently, since the compiler requires the policy to handle it.',
        anchors: [
            at(P.policy, 'old', 2, 2),
            at(P.policy, 'new', 2, 2),
            at(P.policy, 'old', 6, 6),
            at(P.policy, 'new', 6, 6),
            at(P.policy, 'new', 8, 11),
            at(P.policy, 'old', 25, 25),
            at(P.policy, 'new', 29, 29),
            at(P.policy, 'old', 28, 34),
            at(P.policy, 'new', 32, 49),
            at(P.policy, 'new', 51, 62),
            at(P.order, 'old', 16, 16),
            at(P.order, 'new', 16, 18),
            at(P.order, 'old', 37, 38),
            at(P.order, 'new', 39, 40),
            at(P.order, 'new', 42, 46),
            at(P.order, 'new', 62, 76),
        ],
    },
    s03: {
        kind: 'changed',
        reason: 'Following the comment from Iris, remaining time moved to `api/rejection-status.ts` and is returned only for `edit-window-closed`. PAN masking left the PR along with `card-token.ts`, while the audit and PSP schema remain.',
        threadIds: ['4820242'],
        paragraph:
            'The new `api/rejection-status.ts` builds the rejection body: `remainingMs` is returned only for `edit-window-closed` and is no longer in responses for other reasons. The `patchOrder` and `getEditWindow` endpoints still validate the body against a schema, PCI audit records receive `recordedAt`, and the generated PSP schema stays on v4 with `token` instead of `pan`. The only payment change removed from the PR was PAN masking in the `reauthorize` log, along with `card-token.ts`. Consequence: the response contract is more precise, and the PCI scope of the PR narrows to the audit and generated schema.',
        anchors: [
            at(P.handlers, 'old', 2, 2),
            at(P.handlers, 'new', 2, 5),
            at(P.handlers, 'old', 5, 5),
            at(P.handlers, 'new', 8, 10),
            at(P.handlers, 'old', 42, 45),
            at(P.handlers, 'new', 47, 52),
            at(P.handlers, 'old', 49, 49),
            at(P.handlers, 'new', 56, 57),
            at(P.handlers, 'old', 70, 70),
            at(P.handlers, 'new', 78, 89),
            at('services/orders/src/api/rejection-status.ts', 'new', 1, 19),
            at(P.schemas, 'old', 9, 9),
            at(P.schemas, 'new', 9, 11),
            at(P.schemas, 'new', 14, 15),
            at(P.schemas, 'new', 30, 38),
            at(P.pciAudit, 'old', 18, 18),
            at(P.pciAudit, 'new', 18, 24),
            at(P.pciAudit, 'old', 21, 22),
            at(P.pciAudit, 'new', 27, 33),
            at(P.logging, 'old', 31, 31),
            at(P.logging, 'new', 31, 31),
            at(P.logging, 'old', 34, 37),
            at(P.logging, 'new', 34, 37),
            at(P.logging, 'new', 52, 53),
            at(P.logging, 'new', 55, 61),
            at(P.pspSchema, 'new', 3, 3),
            at(P.pspSchema, 'new', 7, 8),
            at(P.docs, 'new', 1, 52),
        ],
    },
    s06: {
        kind: 'new',
        reason: 'The lockfile was rebuilt: no lines remain from the previous block, and there is still nothing to read line by line.',
        paragraph:
            '`pnpm-lock.yaml` was rebuilt for the second time in a row, with no lines left from the previous pass. The entire stop range is new. Consequence: comparing it with the previous snapshot is pointless. Only the new side has anchors, and it is marked collapsed.',
        anchors: [at(P.lock, 'new', 15, 231, true)],
    },
};

/**
 * Stops with no anchors touched by the push but stale text: `card-token.ts` left the PR,
 * taking its untested PAN masking with it (`digestV2` updates this in the digest).
 * These stops have no classification.
 */
const REPHRASED: Record<string, string> = {
    s04: 'Window tests were written from scratch, and policy and endpoint tests were rewritten for the new rejection codes. They cover the 30-minute boundary, early dispatch, express delivery without a window, and category overrides. Two assertions check less than their names promise, while writing `recordedAt` in the PCI audit is not covered at all. Consequence: tests support the window behaviour, while audit writes can only be checked by reading the code.',
};

function changeOf(id: string): RouteStopChange | null {
    const spec = CHANGED[id];
    if (spec === undefined) {
        return null;
    }
    return { kind: spec.kind, reason: spec.reason, threadIds: spec.threadIds ?? [] };
}

/** Second-pass stop: affected stops have their own anchors and paragraph, others keep theirs with new `fileId` values. */
function stopSpecV2(spec: StopSpec): StopSpec {
    const base: StopSpec = {
        ...spec,
        intent: INTENT_V2[spec.id] ?? spec.intent,
        digest: digestV2(spec.digest),
    };
    const changed = CHANGED[spec.id];
    if (changed === undefined) {
        const rephrased = REPHRASED[spec.id];
        return {
            ...base,
            paragraph: rephrased ?? spec.paragraph,
            anchors: reanchor(spec.anchors),
        };
    }
    return { ...base, paragraph: changed.paragraph, anchors: changed.anchors };
}

const MODEL_STOPS_V2: StopSpec[] = MODEL_STOPS.map(stopSpecV2);

function filledStopV2(spec: StopSpec): RouteStop {
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
        change: changeOf(spec.id),
    };
}

function readySnapshotV2(): RouteSnapshot {
    const base: RouteSnapshot = {
        snapshotId: SNAPSHOT_ID_V2,
        commit: MEDIUM_HEAD_COMMIT_V2,
        baseCommit: MEDIUM_BASE_COMMIT,
        diffId: MEDIUM_DIFF_ID_V2,
        createdAt: CREATED_AT_V2,
        provenance: { harness: 'claude-code', model: 'claude-opus-5', locale: null },
        previousSnapshotId: SNAPSHOT_ID,
        carried: { ...CARRIED },
        summary: SUMMARY_V2,
        stops: [...MODEL_STOPS_V2.map(filledStopV2), otherStop()],
        tourOrder: TOUR_ORDER,
        contentHash: null,
    };
    return { ...base, contentHash: hashHex(canonical(base), 16) };
}

/** Ready second-pass route, the state for the "Iterations" gallery. */
export function makeMediumSecondPassState(): UiRouteState {
    return {
        phase: 'ready',
        smallPr: false,
        snapshot: readySnapshotV2(),
        failure: null,
        // The route was built for the active iteration, so it is not stale.
        stale: null,
    };
}

/** The second-pass plan is unchanged: the push changes stop contents and the summary, not plan composition. */
export function makeMediumSkeletonResultV2(): RouteSkeletonResult {
    return {
        ...makeMediumSkeletonResult(),
        summary: SUMMARY_V2,
        stops: MODEL_STOPS_V2.map((spec) => ({ title: spec.title, tier: spec.tier, intent: spec.intent })),
    };
}

/**
 * Second-pass sections: the model explains "why this stop changed" for the three affected stops,
 * with no explanation for the rest. The validator would drop that field on those stops anyway.
 */
export function makeMediumSectionResultsV2(): RouteSectionResult[] {
    return MODEL_STOPS_V2.map((spec) => {
        const changed = CHANGED[spec.id];
        return {
            stops: [
                {
                    planIndex: spec.planIndex,
                    paragraph: spec.paragraph,
                    ...(spec.bridge === null ? {} : { bridge: spec.bridge }),
                    ...(changed === undefined ? {} : { changeReason: changed.reason }),
                    ...(changed?.threadIds === undefined ? {} : { changeThreadIds: changed.threadIds }),
                    anchors: rawAnchors(spec),
                    ...(spec.digest.length === 0 ? {} : { tests: rawClaims(spec.digest) }),
                },
            ],
        };
    });
}

/** The second pass uses the same broken outputs: they test the validator, not the iteration. */
export function makeMediumBrokenResultsV2(): ReturnType<typeof makeMediumBrokenResults> {
    return makeMediumBrokenResults();
}
