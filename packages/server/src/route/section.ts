import type {
    HostId,
    Locale,
    PrDiff,
    RouteAnchor,
    RouteSectionResult,
    RouteStop,
    RouteStopChange,
    RouteTestClaim,
} from '@sherpa/protocol';
import { routeSectionResultSchema } from '@sherpa/protocol';

import type { IterationMap } from '../iterations/index.js';
import { classifyStop } from '../iterations/index.js';
import type { ChangedFile, DiffIndex } from './diff-index.js';
import { indexDiff, touchesChangedLines } from './diff-index.js';
import { paragraphMarkupErrors } from './paragraph-markup.js';
import { parseResult } from './raw-result.js';
import type { LineRange } from './ranges.js';
import { rangesOverlap, subtractRanges } from './ranges.js';
import type { RouteStrings } from './strings.js';
import { routeStrings } from './strings.js';
import type { RouteStopFilling, RouteValidation } from './types.js';
import { voiceErrors } from './voice.js';

/**
 * Accept a `route.section` task result: raw text → normalized stop fillings.
 *
 * Validation has two levels. Soft rules drop an individual element (anchor or digest assertion)
 * and leave a reviewer note. Hard rules reject the whole result for the model to fix
 * (rpc-design §3). Hard failures include a plan number from another task or absent from the plan, `end < start`, and a stop
 * with no surviving anchors.
 */

type RawSectionStop = RouteSectionResult['stops'][number];
type RawAnchor = RawSectionStop['anchors'][number];
type RawClaim = NonNullable<RawSectionStop['tests']>[number];

/** Occupied range: its owner is needed for the "already explained in stop 02" note. */
interface OccupiedRange extends LineRange {
    readonly planIndex: number;
}

/** Occupancy is keyed by file and side. Ranges on different sides do not conflict. */
type Occupancy = Map<string, OccupiedRange[]>;

/**
 * Section acceptance context: generation language and the data the server uses to classify stops (M4-T7).
 * The first route generation uses default values.
 */
export interface SectionContext {
    /**
     * Generation language used for the model result (voice stop list) and validator notes
     * stored in the snapshot. Defaults to English, the server's fallback generation language.
     */
    readonly locale?: Locale;
    /** Line mapping from the previous snapshot iteration to the generation iteration. null means no classification. */
    readonly map?: IterationMap | null;
    /** Threads fetched at generation start. References to any others are removed from the text. */
    readonly knownThreadIds?: ReadonlySet<HostId>;
}

const NO_THREADS: ReadonlySet<HostId> = new Set();

/** Maximum change-reason threads per stop (`routeSectionResultSchema.changeThreadIds` contract). */
const MAX_CHANGE_THREADS = 20;

/** Thread reference in model text: `[thread:4820242]`. */
const THREAD_TOKEN = /\[thread:([^\]\s]+)\]/g;

/** Anchor resolution result for one stop. */
interface AnchorOutcome {
    readonly anchors: RouteAnchor[];
    readonly notes: string[];
    /** English reasons for dropped anchors, included in the error if the stop has no anchors left. */
    readonly dropReasons: string[];
}

export function validateSection(
    rawText: string,
    plan: readonly RouteStop[],
    allowedPlanIndexes: readonly number[],
    diff: PrDiff,
    context: SectionContext = {},
): RouteValidation<RouteStopFilling[]> {
    const locale = context.locale ?? 'en';
    const strings = routeStrings(locale);
    const parsed = parseResult(rawText, routeSectionResultSchema, 'section');
    if (!parsed.ok) {
        return parsed;
    }

    const index = indexDiff(diff);
    const planStops = new Map(plan.filter((stop) => stop.tier !== 'other').map((stop) => [stop.planIndex, stop]));
    const allowed = new Set(allowedPlanIndexes);
    // Process by plan number: within one result, the lower number wins a range
    // conflict. Between results the rule differs, see `planOccupancy`.
    // Each element carries its model output position so error paths point to the model JSON.
    const stops = parsed.value.stops
        .map((stop, sourceIndex) => ({ stop, sourceIndex }))
        .sort((left, right) => left.stop.planIndex - right.stop.planIndex);
    const filled = new Set(stops.map((entry) => entry.stop.planIndex));
    const occupancy = planOccupancy(plan, filled);

    const errors: string[] = [];
    const fillings: RouteStopFilling[] = [];
    const seen = new Set<number>();

    stops.forEach(({ stop, sourceIndex }) => {
        const at = `section.stops[${String(sourceIndex)}]`;
        if (seen.has(stop.planIndex)) {
            errors.push(
                `${at}.planIndex: stop ${String(stop.planIndex)} is filled twice in this result. Return one entry per stop.`,
            );
            return;
        }
        seen.add(stop.planIndex);

        if (!planStops.has(stop.planIndex)) {
            errors.push(
                `${at}.planIndex: ${String(stop.planIndex)} is not a stop of the route plan (plan numbers are 1..${String(planStops.size)}). Fill only the stops assigned to this task: ${listNumbers(allowedPlanIndexes)}.`,
            );
            return;
        }
        if (!allowed.has(stop.planIndex)) {
            errors.push(
                `${at}.planIndex: stop ${String(stop.planIndex)} is not assigned to this task. Fill only these stops: ${listNumbers(allowedPlanIndexes)}.`,
            );
            return;
        }

        const voice = [
            ...voiceErrors(`${at}.paragraph`, stop.paragraph, locale),
            ...voiceErrors(`${at}.bridge`, stop.bridge, locale),
            ...voiceErrors(`${at}.changeReason`, stop.changeReason, locale),
            ...(stop.tests ?? []).flatMap((claim, position) =>
                voiceErrors(`${at}.tests[${String(position)}].text`, claim.text, locale),
            ),
        ];
        if (voice.length > 0) {
            errors.push(...voice);
            return;
        }

        // Description markup violations reject the result just like voice violations. The vocabulary is narrow,
        // so unsupported markup cannot be silently trimmed. The whole section must be rewritten.
        const markup = paragraphMarkupErrors(`${at}.paragraph`, stop.planIndex, stop.paragraph);
        if (markup.length > 0) {
            errors.push(...markup);
            return;
        }

        const rangeErrors = brokenRanges(stop.anchors, at, stop.planIndex);
        if (rangeErrors.length > 0) {
            errors.push(...rangeErrors);
            return;
        }

        const outcome = resolveAnchors(stop, index, occupancy, strings);
        if (outcome.anchors.length === 0) {
            errors.push(
                `${at}: every anchor of stop ${String(stop.planIndex)} was dropped (${outcome.dropReasons.join('; ')}). Re-anchor the stop to lines this diff actually changes and call complete again.`,
            );
            return;
        }
        occupy(occupancy, stop.planIndex, outcome.anchors);

        const digest = resolveClaims(stop.tests ?? [], index, strings);
        const change = resolveChange(stop, outcome.anchors, context, strings);
        fillings.push({
            planIndex: stop.planIndex,
            paragraph: change.paragraph,
            bridge: stop.bridge ?? null,
            anchors: outcome.anchors,
            tests: digest.claims,
            droppedClaims: digest.dropped,
            validationNotes: [...outcome.notes, ...digest.notes, ...change.notes],
            change: change.change,
        });
    });

    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: fillings };
}

/** Resolve "why this stop changed": server classification, model reason and thread references. */
interface ChangeOutcome {
    readonly change: RouteStopChange | null;
    /** Paragraph without references to unknown threads, which the model must not write. */
    readonly paragraph: string;
    readonly notes: string[];
}

/**
 * The server computes the change kind (`new`/`changed`) from resolved anchors and line mapping.
 * The model does not choose it (decision in slice 5). Only a classified stop keeps its
 * reason. References to threads the server did not fetch are removed from the text.
 */
function resolveChange(
    raw: RawSectionStop,
    anchors: readonly RouteAnchor[],
    context: SectionContext,
    strings: RouteStrings,
): ChangeOutcome {
    const known = context.knownThreadIds ?? NO_THREADS;
    const notes: string[] = [];
    const unknown = new Set<HostId>();
    const paragraph = stripThreadTokens(raw.paragraph, known, unknown);
    const map = context.map ?? null;
    const kind = map === null ? null : classifyStop({ anchors: [...anchors] }, map);

    if (kind === null) {
        if (raw.changeReason !== undefined) {
            notes.push(strings.changeReasonDropped);
        }
        return { change: null, paragraph, notes: [...notes, ...unknownThreadNotes(unknown, strings)] };
    }

    const stripped = raw.changeReason === undefined ? null : stripThreadTokens(raw.changeReason, known, unknown);
    // Text emptied by removing broken references is not a reason. The UI shows
    // the "why this stop changed" block when `reason !== null`, which would produce an empty block.
    const reason = stripped === '' ? null : stripped;
    const cited = raw.changeReason === undefined ? [] : threadTokensOf(raw.changeReason);
    // References are kept even without a reason: `changeThreadIds` alone can point the reviewer to a discussion.
    const threadIds: HostId[] = [];
    for (const id of [...(raw.changeThreadIds ?? []), ...cited]) {
        if (!known.has(id)) {
            unknown.add(id);
            continue;
        }
        if (!threadIds.includes(id) && threadIds.length < MAX_CHANGE_THREADS) {
            threadIds.push(id);
        }
    }

    return {
        change: { kind, reason, threadIds },
        paragraph,
        notes: [...notes, ...unknownThreadNotes(unknown, strings)],
    };
}

function unknownThreadNotes(ids: ReadonlySet<HostId>, strings: RouteStrings): string[] {
    return [...ids].map((id) => strings.unknownThread(id));
}

function threadTokensOf(text: string): HostId[] {
    return [...text.matchAll(THREAD_TOKEN)].map(([, id]) => id ?? '');
}

/**
 * Remove `[thread:<id>]` tokens from text. The UI shows thread links in a separate row using
 * `threadIds`, and a token in prose would appear literally. Unknown ids also lead nowhere.
 * Clean up the removal site because double spaces and spaces before punctuation reveal
 * where the token was removed.
 */
function stripThreadTokens(text: string, known: ReadonlySet<HostId>, unknown: Set<HostId>): string {
    let cut = 0;
    const stripped = text.replaceAll(THREAD_TOKEN, (_token, id: string) => {
        cut += 1;
        if (!known.has(id)) {
            unknown.add(id);
        }
        return '';
    });
    return cut === 0
        ? text
        : stripped.replaceAll(/[ \t]{2,}/g, ' ').replaceAll(/[ \t]+([,.;:!?)])/g, '$1').trim();
}

/**
 * Already accepted plan fillings. Stops filled by this result are excluded from occupancy
 * so resubmitting the same section does not conflict with itself.
 *
 * Conflicts between results favor whoever occupied the range first, regardless of
 * plan number (SPEC §4.3: the validator keeps the first, the second shows "range moved
 * to stop 02"). The validator is a pure function of accepted data and leaves other fillings intact,
 * so it cannot take a range from an accepted stop even when the competing stop has a lower
 * number. The practical consequence for orchestration (M2-T4): if route quality depends on
 * priority by plan number, accept sections in plan order. The validator does not
 * guarantee this, and stops arrive out of order by design (README §8).
 */
function planOccupancy(plan: readonly RouteStop[], refilled: ReadonlySet<number>): Occupancy {
    const occupancy: Occupancy = new Map();
    for (const stop of plan) {
        if (refilled.has(stop.planIndex)) {
            continue;
        }
        occupy(occupancy, stop.planIndex, stop.anchors);
    }
    return occupancy;
}

function occupy(occupancy: Occupancy, planIndex: number, anchors: readonly RouteAnchor[]): void {
    for (const anchor of anchors) {
        const key = occupancyKey(anchor.fileId, anchor.side);
        const list = occupancy.get(key) ?? [];
        list.push({ start: anchor.start, end: anchor.end, planIndex });
        occupancy.set(key, list);
    }
}

function occupancyKey(fileId: string, side: 'old' | 'new'): string {
    return `${fileId} ${side}`;
}

/** The schema does not catch `end < start` because its two fields are independent. */
function brokenRanges(anchors: readonly RawAnchor[], at: string, planIndex: number): string[] {
    return anchors.flatMap((anchor, position) =>
        anchor.end < anchor.start
            ? [
                  `${at}.anchors[${String(position)}]: stop ${String(planIndex)} has end (${String(anchor.end)}) before start (${String(anchor.start)}). An anchor is an inclusive range, so end must be >= start.`,
              ]
            : [],
    );
}

/**
 * Resolve stop anchors: `path` → `fileId`, discard dead anchors and subtract other stops' ranges.
 * Anchors that partially overlap context stay intact because real model outputs include
 * ranges with context, while coverage counts only their intersection with changed lines.
 */
function resolveAnchors(
    stop: RawSectionStop,
    index: DiffIndex,
    occupancy: Occupancy,
    strings: RouteStrings,
): AnchorOutcome {
    const anchors: RouteAnchor[] = [];
    const notes: string[] = [];
    const dropReasons: string[] = [];

    stop.anchors.forEach((raw, position) => {
        const where = `anchor ${String(position + 1)} ("${raw.path}" ${raw.side} ${String(raw.start)}-${String(raw.end)})`;
        const file = index.get(raw.path);
        if (file === undefined) {
            notes.push(strings.anchorFileMissing(raw.path));
            dropReasons.push(`${where}: the file is not in this diff`);
            return;
        }
        if (!touchesChangedLines(file, raw.side, raw.start, raw.end)) {
            notes.push(strings.anchorNotChanged(raw.path, lineSpan(raw)));
            dropReasons.push(`${where}: it covers no line changed on the ${raw.side} side`);
            return;
        }

        const rest = surviving(raw, file, occupancy);
        if (rest.pieces.length === 0) {
            notes.push(strings.rangeTaken(raw.path, lineSpan(raw), stopLabel(rest.owner)));
            dropReasons.push(`${where}: the range is already explained by stop ${stopLabel(rest.owner)}`);
            return;
        }
        if (rest.trimmed) {
            notes.push(strings.rangeTrimmed(raw.path, lineSpan(raw), stopLabel(rest.owner)));
        }
        for (const piece of rest.pieces) {
            anchors.push({
                fileId: file.fileId,
                path: raw.path,
                side: raw.side,
                start: piece.start,
                end: piece.end,
                collapsed: raw.collapsed ?? false,
            });
        }
    });

    return { anchors, notes, dropReasons };
}

interface SurvivingRange {
    readonly pieces: LineRange[];
    /** Plan number of the stop that claimed the range first. null means there was no conflict. */
    readonly owner: number | null;
    readonly trimmed: boolean;
}

/** Anchor remainder after subtracting other ranges on the same side of the same file. */
function surviving(raw: RawAnchor, file: ChangedFile, occupancy: Occupancy): SurvivingRange {
    const range: LineRange = { start: raw.start, end: raw.end };
    const occupied = occupancy.get(occupancyKey(file.fileId, raw.side)) ?? [];
    const rivals = occupied.filter((busy) => rangesOverlap(range, busy));
    if (rivals.length === 0) {
        return { pieces: [range], owner: null, trimmed: false };
    }

    const owner = Math.min(...rivals.map((rival) => rival.planIndex));
    // Pieces without changed lines are pure context, so there is no reason to assign them to a stop.
    const pieces = subtractRanges(range, rivals).filter((piece) =>
        touchesChangedLines(file, raw.side, piece.start, piece.end),
    );
    return { pieces, owner, trimmed: true };
}

/** Test digest: accepted assertions, dropped count and reviewer notes. */
interface DigestOutcome {
    readonly claims: RouteTestClaim[];
    readonly dropped: number;
    readonly notes: string[];
}

/**
 * Resolve the digest. `new`/`changed`/`weakened` without an anchor to a file present in the diff
 * are dropped and counted (SPEC §4.3). `uncovered` can survive without an anchor because "changed
 * behavior without coverage" has nowhere to anchor by definition.
 *
 * The path is not checked for being a test file. The repository defines that, not the validator,
 * and a false rejection would cost more than a missed check. The reviewer still reads the assertion with its anchor.
 */
function resolveClaims(raws: readonly RawClaim[], index: DiffIndex, strings: RouteStrings): DigestOutcome {
    const claims: RouteTestClaim[] = [];
    const missingFiles: string[] = [];
    let anchorless = 0;

    for (const raw of raws) {
        const file = raw.testPath === undefined ? undefined : index.get(raw.testPath);
        const anchor =
            raw.testPath === undefined || raw.testLine === undefined || file === undefined
                ? null
                : { fileId: file.fileId, path: raw.testPath, line: raw.testLine };

        if (raw.kind !== 'uncovered' && anchor === null) {
            if (raw.testPath !== undefined && file === undefined) {
                missingFiles.push(raw.testPath);
            } else {
                anchorless += 1;
            }
            continue;
        }
        claims.push({ kind: raw.kind, text: raw.text, anchor });
    }

    const notes = [
        ...(missingFiles.length > 0 ? [strings.claimsMissingFiles(missingFiles)] : []),
        ...(anchorless > 0 ? [strings.claimsAnchorless(anchorless)] : []),
    ];
    return { claims, dropped: missingFiles.length + anchorless, notes };
}

function lineSpan(raw: RawAnchor): string {
    return raw.start === raw.end ? String(raw.start) : `${String(raw.start)}–${String(raw.end)}`;
}

/** Plan number formatted as the reviewer sees it in the UI: `02`. */
function stopLabel(planIndex: number | null): string {
    return planIndex === null ? '??' : String(planIndex).padStart(2, '0');
}

function listNumbers(values: readonly number[]): string {
    return values.length === 0 ? 'none' : [...values].sort((left, right) => left - right).join(', ');
}
