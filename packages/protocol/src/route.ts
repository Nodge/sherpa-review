import { z } from 'zod';

import { localeSchema } from './locale.js';
import { hostIdSchema } from './review.js';

/**
 * Route (M2, requirements §1/C5): snapshot schema and generation task result schemas.
 * This is the canonical definition (requirements §5). Task payload JSON schemas come from these same zod schemas.
 * Brief rule (principle 3): the UI consumes nothing that has not passed the fail-closed
 * validator. Raw model output never reaches a snapshot.
 *
 * A snapshot stores only model-generated content (titles, paragraphs, anchors, digest).
 * The UI computes all derived data, including file chips, counters, read state, coverage strip shares,
 * and the contents of "Other" (uncovered ranges), from the anchors
 * and its own diff model. Snapshots have no derived fields that could become incorrect.
 */

/**
 * Importance tier. The model assigns `high`/`medium`/`low`. `other` is the synthetic
 * "Other" stop that the validator creates (the model knows nothing about it).
 */
export const routeTierSchema = z.enum(['high', 'medium', 'low', 'other']);
export type RouteTier = z.infer<typeof routeTierSchema>;

/** Stop filling status during progressive generation (rpc-design §6). */
export const routeStopStatusSchema = z.enum(['queued', 'filling', 'ready', 'failed']);
export type RouteStopStatus = z.infer<typeof routeStopStatusSchema>;

/**
 * Stop anchor, a line range on one side of a diff file (not the entire file, since a file
 * can span several stops). The validator resolves it by converting `path` from model
 * output to the active iteration's `fileId`. `collapsed` is a display
 * directive to "collapse by default" (the fold stays visible with a counter, principle 3).
 */
export const routeAnchorSchema = z.object({
    fileId: hostIdSchema,
    path: z.string().min(1),
    side: z.enum(['old', 'new']),
    /** Inclusive, with `end >= start`. Uses file line numbers on the corresponding side. */
    start: z.number().int().positive(),
    end: z.number().int().positive(),
    collapsed: z.boolean(),
});
export type RouteAnchor = z.infer<typeof routeAnchorSchema>;

/**
 * A Behavioural test digest assertion (brief §6). `weakened` is a first-class
 * signal. `uncovered` explicitly represents "changed behaviour without coverage".
 * A test anchor is required for new/changed/weakened (otherwise the validator drops
 * the assertion and increments `droppedClaims`). `uncovered` has no test anchor
 * by definition, only `anchor: null` or an anchor to the code left uncovered.
 */
export const routeTestClaimKindSchema = z.enum(['new', 'changed', 'weakened', 'uncovered']);
export type RouteTestClaimKind = z.infer<typeof routeTestClaimKindSchema>;

export const routeTestClaimSchema = z.object({
    kind: routeTestClaimKindSchema,
    /** In plain words: "rejects edits after the 30-minute window". */
    text: z.string().min(1).max(1000),
    anchor: z
        .object({
            fileId: hostIdSchema,
            path: z.string().min(1),
            line: z.number().int().positive(),
        })
        .nullable(),
});
export type RouteTestClaim = z.infer<typeof routeTestClaimSchema>;

/**
 * Generation provenance (brief, principle 7): which tool and language generated it.
 * The commit belongs to the snapshot. `locale` is the UI language when generation starts (M5, planning
 * decision 2). null on pre-M5 snapshots means Russian. The UI reads null as `ru`.
 */
export const routeProvenanceSchema = z.object({
    harness: z.string().nullable(),
    model: z.string().nullable(),
    locale: localeSchema.nullable().default(null),
});
export type RouteProvenance = z.infer<typeof routeProvenanceSchema>;

/**
 * A stop's classification relative to the previous snapshot (README §1 `changed`/`new` badges,
 * "why this stop changed" block). The server computes it deterministically from the interdiff between
 * the snapshots' iterations. `new` means all anchored lines were touched or the file was added,
 * `changed` means some were touched. The model only explains (`reason`), it does not choose the classification.
 * `threadIds` are threads on the affected ranges that the model named as the reason.
 * The validator keeps only existing threads.
 */
export const routeStopChangeSchema = z.object({
    kind: z.enum(['new', 'changed']),
    /** "Why this stop changed" in the model's words (Russian). null means the model gave no explanation. */
    reason: z.string().nullable(),
    threadIds: z.array(hostIdSchema),
});
export type RouteStopChange = z.infer<typeof routeStopChangeSchema>;

/**
 * A route stop. The skeleton fixes the plan (id, planIndex, tier, title),
 * and filling does not change it: numbers stay fixed by the plan (SPEC §8 item 4). Filters
 * and promoting "Other" reorder rendering but leave the numbers unchanged.
 *
 * The synthetic "Other" stop has `id: 'other'`, `tier: 'other'`, and the last
 * `planIndex`. The server sets its title (Russian, for the reviewer).
 * It has `status: 'ready'` immediately, since there is nothing to fill. The UI computes its contents
 * itself. The UI hides it when there are no uncovered lines (SPEC §4.3).
 */
export const routeStopSchema = z.object({
    id: z.string().min(1),
    /** Position in the plan, starting at 1. The `stops` array uses triage order (descending importance). */
    planIndex: z.number().int().positive(),
    tier: routeTierSchema,
    title: z.string().min(1).max(300),
    status: routeStopStatusSchema,
    /** Filling fields, null until the section is ready. Paragraph formula: "what changed → consequences". */
    paragraph: z.string().nullable(),
    /** Transition to the next stop, separate from the paragraph. May be absent even in a ready stop. */
    bridge: z.string().nullable(),
    anchors: z.array(routeAnchorSchema),
    tests: z.array(routeTestClaimSchema),
    /** Number of digest assertions the validator dropped ("2 claims dropped — no matching test"). */
    droppedClaims: z.number().int().min(0),
    /** Validator notes for the reviewer (Russian): "the range moved to stop 02", etc. */
    validationNotes: z.array(z.string()),
    /** Section provenance if it differs from the snapshot (agent changed mid-generation, SPEC §4.4). */
    provenance: routeProvenanceSchema.nullable(),
    /** null if the push did not affect the stop or this is the first snapshot (nothing to compare). */
    change: routeStopChangeSchema.nullable(),
});
export type RouteStop = z.infer<typeof routeStopSchema>;

/**
 * Progress carryover result from the previous snapshot (second-pass banner, README §9):
 * how many marked stops from the previous route remain marked in the new one.
 */
export const routeCarriedSchema = z.object({
    kept: z.number().int().min(0),
    total: z.number().int().min(0),
});
export type RouteCarried = z.infer<typeof routeCarriedSchema>;

/**
 * A route snapshot appears when the skeleton is accepted and grows
 * as sections are submitted. It becomes immutable in the `ready` phase
 * (`contentHash` is computed then too). A PR has many snapshots, one for
 * each generation or regeneration. The server stores all of them, with one current snapshot.
 */
export const routeSnapshotSchema = z.object({
    snapshotId: z.string().min(1),
    /** Reviewed commit (the diff's headCommit) and iteration for which the route was built. */
    commit: z.string().min(1),
    baseCommit: z.string().min(1),
    diffId: hostIdSchema,
    createdAt: z.iso.datetime(),
    provenance: routeProvenanceSchema,
    /** The snapshot from which progress was carried over and against which `stops[].change` was computed. null for the first. */
    previousSnapshotId: z.string().nullable(),
    /** Progress carryover result. null if there was no source to carry over from. */
    carried: routeCarriedSchema.nullable(),
    /** PR summary. Arrives in full with the skeleton: the loop has no token streaming (rpc-design §6). */
    summary: z.string(),
    /** Triage order, with synthetic "Other" last. */
    stops: z.array(routeStopSchema),
    /** "Full tour" order, a permutation of all stop ids, including "Other" (last). */
    tourOrder: z.array(z.string().min(1)),
    /** Content hash of the ready snapshot. null until the phase is `ready`. */
    contentHash: z.string().nullable(),
});
export type RouteSnapshot = z.infer<typeof routeSnapshotSchema>;

/**
 * The `route.skeleton` task result, what the model returns (validated
 * fail-closed on `complete`. This schema is included in the task payload as a file).
 * Stops use triage order. The server assigns ids and "Other" after validation.
 */
export const routeSkeletonResultSchema = z.object({
    /** PR summary: Markdown, Russian (for the reviewer). */
    summary: z.string().min(1).max(20_000),
    stops: z
        .array(
            z.object({
                title: z.string().min(1).max(300),
                tier: z.enum(['high', 'medium', 'low']),
                /**
                 * A rough stop outline for fill tasks, the files/ranges
                 * it is expected to cover and what it explains. Not shown in the UI.
                 */
                intent: z.string().min(1).max(2000),
            }),
        )
        .min(1)
        .max(40),
    /** "Full tour" order, a permutation of plan numbers (1-based). */
    tourOrder: z.array(z.number().int().positive()),
});
export type RouteSkeletonResult = z.infer<typeof routeSkeletonResultSchema>;

/**
 * The `route.section` task result fills one or more planned stops
 * (section batching is a server concern, not a protocol concern). Anchors use `path`.
 * The validator resolves them to `fileId` against the snapshot's iteration.
 *
 * After a push, the same task receives the previous route and interdiff as context.
 * `changeReason`/`changeThreadIds` explain "why this stop changed" for stops
 * the server classified as `new`/`changed` (`RouteStop.change`). For other
 * stops, the validator drops these fields, along with unknown thread ids.
 */
export const routeSectionResultSchema = z.object({
    stops: z
        .array(
            z.object({
                planIndex: z.number().int().positive(),
                paragraph: z.string().min(1).max(4000),
                bridge: z.string().min(1).max(1000).optional(),
                changeReason: z.string().min(1).max(1000).optional(),
                changeThreadIds: z.array(hostIdSchema).max(20).optional(),
                anchors: z
                    .array(
                        z.object({
                            path: z.string().min(1),
                            side: z.enum(['old', 'new']),
                            start: z.number().int().positive(),
                            end: z.number().int().positive(),
                            collapsed: z.boolean().optional(),
                        }),
                    )
                    .min(1)
                    .max(200),
                tests: z
                    .array(
                        z.object({
                            kind: routeTestClaimKindSchema,
                            text: z.string().min(1).max(1000),
                            testPath: z.string().min(1).optional(),
                            testLine: z.number().int().positive().optional(),
                        }),
                    )
                    .max(100)
                    .optional(),
            }),
        )
        .min(1)
        .max(40),
});
export type RouteSectionResult = z.infer<typeof routeSectionResultSchema>;
