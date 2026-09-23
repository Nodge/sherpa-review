import type {
    AgentNote,
    FileDiff,
    RouteAnchor,
    RouteSnapshot,
    RouteStop,
    RouteTier,
    Thread,
    UiStopSeenRange,
} from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';
import { noteCommentPosition } from '../notes/note-draft.js';
import { changedLinesOf } from '../progress/read-state.js';
import type { RoutePreset } from '../session/session-store.js';
import { threadAtLines } from '../threads/model.js';
import type { IterationLayout } from '../threads/model.js';
import type { ComposerSnapshot } from '../threads/store.js';
import type { AnchorSpan } from './anchor-clip.js';
import {
    ANCHOR_CONTEXT,
    anchorSpans,
    clipModelToAnchors,
    coveredChangedLines,
    coveredChangedRanges,
    droppedWhitespaceLines,
    spanLines,
    uncoveredRanges,
    uncoveredReadRanges,
} from './anchor-clip.js';

/**
 * Route view model (docs/design/README.md §1–2): what to render, in what order, how many lines are explained
 * and what remains in Other. A pure module with no React or network. It takes a route snapshot,
 * diff files and parsed models, and returns the order ready for rendering.
 *
 * Contract invariant (`protocol/route.ts`): the snapshot contains only model output. File chips,
 * counters, coverage ratios and the contents of Other are computed here from anchors and the
 * diff model, using `changedLinesOf` (add→new, del→old).
 */

/** Uncovered fraction above which Other moves ahead of low-tier stops (docs/design/SPEC-elements.md §4.3). */
export const PROMOTE_THRESHOLD = 0.4;

/** Unchanged line numbers by diff side. */
export interface ContextLines {
    readonly old: ReadonlySet<number>;
    readonly new: ReadonlySet<number>;
}

export interface RouteFileGroup {
    readonly file: FileDiff;
    readonly fileId: string;
    readonly path: string;
    readonly name: string;
    readonly dir: string;
    /** This stop's anchors for the file that render immediately. */
    readonly anchors: readonly RouteAnchor[];
    /** Anchors with the `collapsed` directive render as a summary row (principle 3, with a counter). */
    readonly collapsedAnchors: readonly RouteAnchor[];
    /**
     * Unchanged context lines that the card renders around its ranges.
     * A comment on such a line belongs to this route entry, otherwise it would appear
     * nowhere. Each line belongs to exactly one entry, assigned in plan order.
     */
    readonly contextLines: ContextLines;
    /** Hunks in the card slice, used for lazy rendering (docs/design/SPEC-elements.md §2.9). */
    readonly hunks: number;
    /** Changed file lines covered by the stop: additions and deletions. */
    readonly additions: number;
    readonly deletions: number;
    /** Changed lines under collapsed anchors. */
    readonly collapsedLines: number;
    /**
     * Ranges of changed file lines covered by the stop's anchors. Marking the stop
     * viewed writes them to progress. Collapsed anchors are included along with
     * visible ones because the stop explains them and prints their counts in a summary row.
     *
     * Also includes whitespace lines that Other will not take (`orphanWhitespace`). They are excluded from the stop's
     * counters, but without them the file's reading progress could not reach completion.
     */
    readonly seenRanges: readonly AnchorSpan[];
    /** The stop covers all changed lines in the file. */
    readonly whole: boolean;
}

export interface RouteStopView {
    readonly stop: RouteStop;
    /** Number fixed by the plan: `01`. Render order does not affect it (docs/design/SPEC-elements.md §8 item 4). */
    readonly planLabel: string;
    readonly files: readonly RouteFileGroup[];
    readonly changedLines: number;
    /** Paths of anchors with no matching file or changed lines in the current diff. */
    readonly unresolvedPaths: readonly string[];
    /**
     * Anchor paths in conflict files. The lines are still there, but the file is outside route
     * coverage (docs/design/SPEC-elements.md §4.1). This is not drift. Regeneration will not change it.
     */
    readonly conflictPaths: readonly string[];
    /** Anchors exist but none resolve in the diff: anchor drift (docs/design/SPEC-elements.md §2.9). */
    readonly drift: boolean;
    /** No anchors at all: the stop was not filled, or filling placed no anchors. */
    readonly empty: boolean;
    /**
     * Some stop files are still being parsed, so its counts and seen ranges are not final.
     * Files that failed to parse are excluded here because they will not finish counting on their own.
     */
    readonly pending: boolean;
    /**
     * Some stop files failed to parse. Their changed lines will not enter the seen ranges
     * until the reviewer retries parsing. Marking this stop viewed would write
     * an incomplete set and silently leave these files unread.
     */
    readonly parseFailed: boolean;
}

export interface RouteUncoveredFile {
    readonly file: FileDiff;
    readonly fileId: string;
    readonly path: string;
    readonly name: string;
    readonly dir: string;
    /** Synthetic anchors: uncovered ranges of changed lines. */
    readonly anchors: readonly AnchorSpan[];
    /**
     * Viewed-mark ranges: the same uncovered lines plus whitespace lines that
     * the whitespace rule excluded from statistics. Reading progress counts every changed line
     * in the patch, and Other must complete the file's progress.
     */
    readonly seenRanges: readonly AnchorSpan[];
    /** Context around uncovered ranges not assigned to stops. */
    readonly contextLines: ContextLines;
    readonly lines: number;
}

export interface RouteOtherView {
    readonly stop: RouteStop;
    readonly planLabel: string;
    readonly files: readonly RouteUncoveredFile[];
    readonly lines: number;
    /** Conflict file count. They are outside coverage, but Other must report them (docs/design/SPEC-elements.md §4.1). */
    readonly conflictFiles: number;
}

export interface RouteTotals {
    readonly changed: number;
    readonly covered: number;
    readonly uncovered: number;
    readonly byTier: Readonly<Record<RouteTier, number>>;
    /** Diff files without a parsed model. While any remain, the uncovered count is unknown. */
    readonly pendingFiles: number;
    /**
     * Files that failed to parse. Their lines are absent from the uncovered count. They will not
     * finish counting without a retry, so the reviewer sees this count too.
     */
    readonly failedFiles: number;
    /** Conflict files. Their lines are absent from `changed` and `uncovered` (docs/design/SPEC-elements.md §4.1). */
    readonly conflictFiles: number;
}

export type RouteEntry =
    | { readonly kind: 'stop'; readonly view: RouteStopView }
    | { readonly kind: 'other'; readonly view: RouteOtherView };

export interface RouteModel {
    /**
     * Render order. Triage: high → medium → [promoted Other] → low → Other.
     * Full tour: the snapshot's `tourOrder` as is.
     */
    readonly entries: readonly RouteEntry[];
    readonly totals: RouteTotals;
    /**
     * Uncovered lines exceed the threshold (docs/design/SPEC-elements.md §4.3). In Triage, Other moves ahead of
     * low-tier stops. The tour follows `tourOrder` strictly, because promotion helps Triage and does not apply
     * to the tour. The "consider
     * regenerating" banner uses this flag in both presets because it concerns route quality,
     * rather than card order.
     */
    readonly promoted: boolean;
    /**
     * Route slots, used as the denominator in "01 / 7" and the toolbar counter. Counted from `entries`, not
     * the snapshot: "Other" is not rendered when no uncovered lines remain, so the card number,
     * counter and guardrail must all refer to the same set.
     */
    readonly stopCount: number;
}

export interface RouteModelInput {
    readonly snapshot: RouteSnapshot;
    readonly files: readonly FileDiff[];
    readonly models: ReadonlyMap<string, DiffFileModel>;
    /** Files whose parsing failed have no model until the reviewer requests a retry. */
    readonly failed?: ReadonlySet<string>;
    /** Session preset (docs/design/SPEC-elements.md §2.5). Only affects entry order. */
    readonly preset?: RoutePreset;
    /**
     * The route is still filling (docs/design/README.md §8): uncovered ranges are unfilled plan slots, not the model's
     * final judgement. "Other" is not promoted and its banner stays hidden until ready. The order stays fixed by the plan.
     */
    readonly filling?: boolean;
}

export function buildRouteModel({
    snapshot,
    files: allFiles,
    models,
    failed = EMPTY_FAILED,
    preset = 'triage',
    filling = false,
}: RouteModelInput): RouteModel {
    // Conflicted files are excluded from coverage calculations entirely (docs/design/SPEC-elements.md §4.1). Their lines
    // count as neither changed nor uncovered, and the coverage bar omits them. A separate row
    // in "Other" reports the conflict itself.
    const files = allFiles.filter((file) => file.changeType !== 'conflict');
    // The agent sees conflicted files with patches and places anchors on them as usual. Such an anchor
    // has not drifted. It must be distinguished from a path missing from the diff entirely.
    const conflicts = new Set(
        allFiles.filter((file) => file.changeType === 'conflict').map((file) => file.fileId),
    );
    const conflictFiles = conflicts.size;
    const byId = new Map(files.map((file) => [file.fileId, file]));
    const planned = snapshot.stops.filter((stop) => stop.tier !== 'other');
    const otherStop = snapshot.stops.find((stop) => stop.tier === 'other') ?? null;

    // All stops' anchors together define uncovered ranges as those none of them touches. Each
    // stop uses the same map to find which file ranges belong to its neighbours.
    const claimed = new Map<string, AnchorSpan[]>();
    for (const stop of snapshot.stops) {
        for (const anchor of stop.anchors) {
            const spans = claimed.get(anchor.fileId) ?? [];
            spans.push({ side: anchor.side, start: anchor.start, end: anchor.end });
            claimed.set(anchor.fileId, spans);
        }
    }

    // Context already assigned to a stop. The first stop in plan order gets the line so that one
    // comment never appears in two route entries at once.
    const takenContext = new Map<string, ContextLines>();
    const orphans = orphanWhitespace(planned, files, models, claimed);
    const views = planned.map((stop) =>
        stopView(stop, byId, conflicts, models, failed, claimed, takenContext, orphans),
    );
    const byTier: Record<RouteTier, number> = { high: 0, medium: 0, low: 0, other: 0 };
    for (const view of views) {
        byTier[view.stop.tier] += view.changedLines;
    }

    let changed = 0;
    let covered = 0;
    let pendingFiles = 0;
    let failedFiles = 0;
    const uncoveredFiles: RouteUncoveredFile[] = [];
    for (const file of files) {
        const model = models.get(file.fileId) ?? null;
        if (model === null) {
            changed += file.additions + file.deletions;
            if (failed.has(file.fileId)) {
                failedFiles += 1;
            } else {
                pendingFiles += 1;
            }
            continue;
        }
        const spans = claimed.get(file.fileId) ?? [];
        const total = changedLineCount(model, file, spans);
        const fileCovered = coveredChangedLines(model, spans);
        changed += total;
        covered += fileCovered.additions + fileCovered.deletions;

        const ranges = uncoveredRanges(model, spans);
        const lines = spanLines(ranges);
        if (lines > 0) {
            uncoveredFiles.push({
                ...names(file),
                file,
                anchors: ranges,
                seenRanges: uncoveredReadRanges(model, spans),
                contextLines: claimContext(takenContext, file.fileId, ranges, spans),
                lines,
            });
        }
    }

    const uncovered = uncoveredFiles.reduce((total, file) => total + file.lines, 0);
    byTier.other = uncovered;
    const totals: RouteTotals = { changed, covered, uncovered, byTier, pendingFiles, failedFiles, conflictFiles };

    // Hide "Other" only when there really are no uncovered ranges (docs/design/SPEC-elements.md §4.3). While the diff
    // is being parsed, uncovered lines have not been counted yet. Keep the slot with "counting…",
    // otherwise card numbers and the counter would jump from 6 to 7 during parsing.
    // Conflicts also keep the slot: their row is the only place that reports them.
    const other: RouteOtherView | null =
        otherStop === null || (uncovered === 0 && pendingFiles === 0 && conflictFiles === 0)
            ? null
            : {
                  stop: otherStop,
                  planLabel: planLabel(otherStop.planIndex),
                  files: uncoveredFiles,
                  lines: uncovered,
                  conflictFiles,
              };
    const promoted = !filling && other !== null && changed > 0 && uncovered / changed > PROMOTE_THRESHOLD;
    const entries =
        preset === 'tour'
            ? inTourOrder(order(views, other, false), snapshot.tourOrder)
            : order(views, other, promoted);

    return { entries, totals, promoted, stopCount: entries.length };
}

/** The route entry's counts are not final yet because some of its files have not been parsed. */
export function entryPending(entry: RouteEntry, totals: RouteTotals): boolean {
    return entry.kind === 'stop' ? entry.view.pending : totals.pendingFiles > 0;
}

/**
 * The route entry has files whose parsing failed, so their ranges cannot be counted.
 * A "viewed" mark would reach the server without them and silently leave the files unread,
 * so the entry cannot be marked until parsing is retried.
 */
export function entryParseFailed(entry: RouteEntry, totals: RouteTotals): boolean {
    return entry.kind === 'stop' ? entry.view.parseFailed : totals.failedFiles > 0;
}

/**
 * The agent has not filled the stop yet (or filling failed). It has no ranges,
 * so there is nothing to mark. The synthetic "Other" is always ready.
 */
export function entryUnfilled(entry: RouteEntry): boolean {
    return entry.kind === 'stop' && entry.view.stop.status !== 'ready';
}

/**
 * Render order. Triage follows the snapshot's `stops` array. "Other" goes last, or
 * before the first low-tier stop when raised. Stop numbers stay fixed.
 */
function order(
    views: readonly RouteStopView[],
    other: RouteOtherView | null,
    promoted: boolean,
): readonly RouteEntry[] {
    const entries: RouteEntry[] = views.map((view) => ({ kind: 'stop', view }));
    if (other === null) {
        return entries;
    }
    const otherEntry: RouteEntry = { kind: 'other', view: other };
    if (!promoted) {
        return [...entries, otherEntry];
    }
    const firstLow = entries.findIndex((entry) => entry.kind === 'stop' && entry.view.stop.tier === 'low');
    if (firstLow < 0) {
        return [...entries, otherEntry];
    }
    return [...entries.slice(0, firstLow), otherEntry, ...entries.slice(firstLow)];
}

/**
 * Full tour order (docs/design/SPEC-elements.md §2.5). Entries follow the snapshot's `tourOrder` exactly,
 * including the position of "Other". The snapshot passed validation (`tourOrder` is a permutation
 * of all stops), but the view fails closed. Unknown ids are skipped, duplicates are used once,
 * and stops absent from `tourOrder` go at the end in plan order. A card
 * must not disappear because of a malformed field.
 */
function inTourOrder(entries: readonly RouteEntry[], ids: readonly string[]): readonly RouteEntry[] {
    const byId = new Map(entries.map((entry) => [entry.view.stop.id, entry]));
    const ordered: RouteEntry[] = [];
    for (const id of ids) {
        const entry = byId.get(id);
        if (entry !== undefined) {
            byId.delete(id);
            ordered.push(entry);
        }
    }
    return [...ordered, ...entries.filter((entry) => byId.has(entry.view.stop.id))];
}

function stopView(
    stop: RouteStop,
    byId: ReadonlyMap<string, FileDiff>,
    conflicts: ReadonlySet<string>,
    models: ReadonlyMap<string, DiffFileModel>,
    failed: ReadonlySet<string>,
    claimed: ReadonlyMap<string, readonly AnchorSpan[]>,
    takenContext: Map<string, ContextLines>,
    orphans: ReadonlyMap<string, readonly AnchorSpan[]>,
): RouteStopView {
    const groups = new Map<string, { shown: RouteAnchor[]; collapsed: RouteAnchor[] }>();
    const unresolved: string[] = [];
    const conflictPaths: string[] = [];
    const markUnresolved = (path: string): void => {
        if (!unresolved.includes(path)) {
            unresolved.push(path);
        }
    };
    for (const anchor of stop.anchors) {
        // The file has a conflict. Its lines are present, but there will be no card because the file is outside coverage.
        if (conflicts.has(anchor.fileId)) {
            if (!conflictPaths.includes(anchor.path)) {
                conflictPaths.push(anchor.path);
            }
            continue;
        }
        if (!byId.has(anchor.fileId)) {
            markUnresolved(anchor.path);
            continue;
        }
        const group = groups.get(anchor.fileId) ?? { shown: [], collapsed: [] };
        (anchor.collapsed ? group.collapsed : group.shown).push(anchor);
        groups.set(anchor.fileId, group);
    }

    let changedLines = 0;
    let pending = false;
    let parseFailed = false;
    const files: RouteFileGroup[] = [];
    for (const [fileId, group] of groups) {
        const file = byId.get(fileId);
        if (file === undefined) {
            continue;
        }
        const model = models.get(fileId) ?? null;
        pending ||= model === null && !failed.has(fileId);
        parseFailed ||= model === null && failed.has(fileId);
        const own = anchorSpans([...group.shown, ...group.collapsed]);
        const shown = coveredChangedLines(model, anchorSpans(group.shown));
        const collapsed = coveredChangedLines(model, anchorSpans(group.collapsed));
        const additions = shown.additions + collapsed.additions;
        const deletions = shown.deletions + collapsed.deletions;
        // The file exists in the diff, but no changed lines remain under the anchors. The diff has shifted beneath
        // the snapshot. An empty card would not explain this, so the file gets a notice (docs/design/SPEC-elements.md §2.9).
        if (model !== null && model.content.kind === 'text' && additions + deletions === 0) {
            markUnresolved(file.path);
            continue;
        }
        changedLines += additions + deletions;
        files.push({
            ...names(file),
            file,
            anchors: group.shown,
            collapsedAnchors: group.collapsed,
            contextLines: claimContext(takenContext, fileId, own, claimed.get(fileId) ?? []),
            hunks: model === null ? 0 : clipModelToAnchors(model, anchorSpans(group.shown)).hunks,
            additions,
            deletions,
            collapsedLines: collapsed.additions + collapsed.deletions,
            seenRanges: [...coveredChangedRanges(model, own), ...(orphans.get(fileId) ?? EMPTY_SPANS)],
            whole: model !== null && additions + deletions >= changedLineCount(model, file, claimed.get(fileId) ?? []),
        });
    }

    return {
        stop,
        planLabel: planLabel(stop.planIndex),
        files,
        changedLines,
        unresolvedPaths: unresolved,
        conflictPaths,
        // The entire stop now consists of conflicted files. This is not drift because the lines are present,
        // and regenerating the route will not bring them back.
        drift: stop.anchors.length > 0 && files.length === 0 && conflictPaths.length === 0,
        empty: stop.anchors.length === 0,
        pending,
        parseFailed,
    };
}

/**
 * Whitespace lines outside anchors that "Other" will not take. The file has no uncovered text
 * left, so it will not appear in "Other" at all. Reading progress counts changed lines
 * across the whole patch (`read-state`), so stops explaining this file mark these lines
 * as read too. Otherwise, a file with a blank line between blocks from different stops would
 * never be completed through the route.
 *
 * A file touched by no stop (all its changed lines are whitespace) never appears
 * in the route. It can only be completed by marking the file itself.
 */
function orphanWhitespace(
    planned: readonly RouteStop[],
    files: readonly FileDiff[],
    models: ReadonlyMap<string, DiffFileModel>,
    claimed: ReadonlyMap<string, readonly AnchorSpan[]>,
): ReadonlyMap<string, readonly AnchorSpan[]> {
    const placed = new Set(planned.flatMap((stop) => stop.anchors.map((anchor) => anchor.fileId)));
    const orphans = new Map<string, readonly AnchorSpan[]>();
    for (const file of files) {
        const model = models.get(file.fileId) ?? null;
        if (model === null || !placed.has(file.fileId)) {
            continue;
        }
        const spans = claimed.get(file.fileId) ?? EMPTY_SPANS;
        // There is uncovered text, so the file will appear in "Other", whose seen ranges will cover
        // the whitespace lines too.
        if (uncoveredRanges(model, spans).length > 0) {
            continue;
        }
        const rest = uncoveredReadRanges(model, spans);
        if (rest.length > 0) {
            orphans.set(file.fileId, rest);
        }
    }
    return orphans;
}

/**
 * Route entry context includes up to `ANCHOR_CONTEXT` unchanged lines at the edges of its ranges.
 * Everything claimed by anchors (another stop's line means its comment) and everything
 * taken by a previous entry is subtracted. `taken` is updated in place, in plan order.
 */
function claimContext(
    taken: Map<string, ContextLines>,
    fileId: string,
    own: readonly AnchorSpan[],
    allClaimed: readonly AnchorSpan[],
): ContextLines {
    const mine: { old: Set<number>; new: Set<number> } = { old: new Set(), new: new Set() };
    const already = taken.get(fileId) ?? EMPTY_CONTEXT;
    for (const span of own) {
        for (let offset = 1; offset <= ANCHOR_CONTEXT; offset += 1) {
            for (const line of [span.start - offset, span.end + offset]) {
                if (line < 1 || already[span.side].has(line) || covered(allClaimed, span.side, line)) {
                    continue;
                }
                mine[span.side].add(line);
            }
        }
    }

    taken.set(fileId, {
        old: new Set([...already.old, ...mine.old]),
        new: new Set([...already.new, ...mine.new]),
    });
    return mine;
}

function covered(spans: readonly AnchorSpan[], side: 'old' | 'new', line: number): boolean {
    return spans.some((span) => span.side === side && line >= span.start && line <= span.end);
}

/** The comment position touches at least one line of the entry's context. */
function touchesContext(lines: ContextLines, side: 'old' | 'new', start: number, end: number): boolean {
    for (const line of lines[side]) {
        if (line >= start && line <= end) {
            return true;
        }
    }
    return false;
}

function intersects(spans: readonly AnchorSpan[], side: 'old' | 'new', start: number, end: number): boolean {
    return spans.some((span) => span.side === side && start <= span.end && end >= span.start);
}

const EMPTY_CONTEXT: ContextLines = { old: new Set(), new: new Set() };
const EMPTY_SPANS: readonly AnchorSpan[] = [];

/**
 * Changed lines in the file, using the canonical `changedLinesOf` rule (add→new, del→old). Without
 * a model yet, use patch counters.
 *
 * Blank and whitespace lines outside anchors are subtracted from the count.
 * `uncoveredRanges` omits them. Without the same adjustment in the denominator, covered plus
 * uncovered would not equal changed.
 */
function changedLineCount(model: DiffFileModel | null, file: FileDiff, anchors: readonly AnchorSpan[]): number {
    const changed = changedLinesOf(model);
    if (changed === undefined) {
        return file.additions + file.deletions;
    }
    return changed.old.size + changed.new.size - droppedWhitespaceLines(model, anchors);
}

function names(file: FileDiff): { fileId: string; path: string; name: string; dir: string } {
    const cut = file.path.lastIndexOf('/');
    return {
        fileId: file.fileId,
        path: file.path,
        name: cut === -1 ? file.path : file.path.slice(cut + 1),
        dir: cut === -1 ? '' : file.path.slice(0, cut),
    };
}

/** Plan number as shown in the design: `01`, `07`. */
export function planLabel(planIndex: number): string {
    return String(planIndex).padStart(2, '0');
}

/**
 * Whether the comment position belongs to the stop's ranges. First check its anchors, then
 * their context. The card renders several unchanged lines at the edges of each range, and a comment
 * on such a line would otherwise appear in no route entry. Context claimed by
 * a neighbouring stop stays with it so that a thread never appears twice.
 */
function groupOwnsPosition(group: RouteFileGroup, position: { side: 'old' | 'new'; line: number; size: number }): boolean {
    const last = position.line + Math.max(position.size, 1) - 1;
    return (
        intersects(anchorSpans([...group.anchors, ...group.collapsedAnchors]), position.side, position.line, last) ||
        touchesContext(group.contextLines, position.side, position.line, last)
    );
}

/**
 * Threads belonging to the stop's ranges. With a position, the line must fall within the anchors or their
 * context. Without a position (outdated or pinned to another iteration), the stop must
 * explain the whole file. Otherwise, the same thread would appear in every stop that
 * touches this file.
 */
export function threadsForGroup(
    group: RouteFileGroup,
    byFile: ReadonlyMap<string, readonly Thread[]>,
    iteration: IterationLayout | null = null,
): readonly Thread[] {
    const threads = byFile.get(group.fileId) ?? [];
    if (threads.length === 0) {
        return threads;
    }
    return threads.filter((thread) => {
        const position = thread.anchor?.position ?? null;
        if (position === null || !threadAtLines(thread, iteration)) {
            return group.whole;
        }
        return groupOwnsPosition(group, position);
    });
}

/** A note appears in only one route card, using the same ownership rule as a thread. */
export function notesForGroup(
    group: RouteFileGroup,
    byFile: ReadonlyMap<string, readonly AgentNote[]>,
): readonly AgentNote[] {
    const notes = byFile.get(group.fileId) ?? [];
    return notes.filter((note) => groupOwnsPosition(group, noteCommentPosition(note.anchor)));
}

/**
 * Composers follow the same rule as threads. A draft appearing in two route
 * entries would create two textareas for one store record.
 */
export function composersForGroup(
    group: RouteFileGroup,
    byFile: ReadonlyMap<string, readonly ComposerSnapshot[]>,
): readonly ComposerSnapshot[] {
    const composers = byFile.get(group.fileId) ?? [];
    if (composers.length === 0) {
        return composers;
    }
    return composers.filter((composer) => {
        const position = composer.anchor?.position ?? null;
        return position === null ? group.whole : groupOwnsPosition(group, position);
    });
}

/**
 * Seen ranges for the "viewed" mark on a route entry (docs/architecture.md §7.1).
 * For a regular stop, these are its files' changed lines covered by its anchors. For "Other",
 * these are uncovered ranges. The UI computes them because the server has no diff model.
 */
export function stopSeenRanges(entry: RouteEntry): readonly UiStopSeenRange[] {
    return entryGroups(entry).flatMap((group) =>
        group.seenRanges.map((span) => ({
            fileId: group.fileId,
            side: span.side,
            start: span.start,
            end: span.end,
        })),
    );
}

/** Stop comments (docs/design/README.md §1, counter in the left column). */
export function countStopComments(
    view: RouteStopView,
    byFile: ReadonlyMap<string, readonly Thread[]>,
    iteration: IterationLayout | null = null,
): number {
    return view.files.reduce((total, group) => total + threadsForGroup(group, byFile, iteration).length, 0);
}

/** File cards of a route entry. For "Other", these are its uncovered files. */
export function entryGroups(entry: RouteEntry): readonly RouteFileGroup[] {
    return entry.kind === 'stop' ? entry.view.files : entry.view.files.map((file) => uncoveredAsGroup(file));
}

/** An "Other" file as a regular stop file group, with the same cards and threads. */
export function uncoveredAsGroup(file: RouteUncoveredFile): RouteFileGroup {
    const anchors: RouteAnchor[] = file.anchors.map((span) => ({
        fileId: file.fileId,
        path: file.path,
        side: span.side,
        start: span.start,
        end: span.end,
        collapsed: false,
    }));
    const additions = file.anchors
        .filter((span) => span.side === 'new')
        .reduce((total, span) => total + (span.end - span.start + 1), 0);
    return {
        file: file.file,
        fileId: file.fileId,
        path: file.path,
        name: file.name,
        dir: file.dir,
        anchors,
        collapsedAnchors: [],
        contextLines: file.contextLines,
        // Uncovered ranges already join adjacent lines. Each is rendered as its own chunk.
        hunks: anchors.length,
        additions,
        deletions: file.lines - additions,
        collapsedLines: 0,
        seenRanges: file.seenRanges,
        whole: spanLines(file.seenRanges) >= file.file.additions + file.file.deletions,
    };
}

/**
 * Lazy rendering for a stop counts hunks, not files (docs/design/SPEC-elements.md §2.9): "stop with more
 * than 20 hunks lazy-renders beyond the first 5". Below the threshold, the whole stop renders
 * even offscreen, so scrolling does not have to wait for rendering unnecessarily.
 */
export const LAZY_HUNK_THRESHOLD = 20;
const LAZY_HUNKS = 5;

/** Cards rendered before the stop has appeared on screen. */
export function lazyCards(files: readonly RouteFileGroup[]): readonly RouteFileGroup[] {
    const total = files.reduce((sum, group) => sum + group.hunks, 0);
    if (total <= LAZY_HUNK_THRESHOLD) {
        return files;
    }
    const head: RouteFileGroup[] = [];
    let hunks = 0;
    for (const group of files) {
        // Always render the first card. A single card with 30 hunks still needs to be visible.
        if (head.length > 0 && hunks >= LAZY_HUNKS) {
            break;
        }
        head.push(group);
        hunks += group.hunks;
    }
    return head;
}

/**
 * Stop state that determines whether its diff column can be removed from the DOM.
 * The route is not virtualized as a whole. The section stays in place with its narrative,
 * chips and viewed toggle. Only the right column is removed, with a placeholder
 * of its measured height holding its place.
 */
export interface StopDiffMountState {
    /** The stop is still within the far hysteresis boundary of `useNearViewport`. */
    readonly nearViewport: boolean;
    /** Last measured column height. `null` means it has never been measured, so there is no replacement height. */
    readonly measuredHeight: number | null;
    /** First stop in the route, the reviewer's entry point and the tour anchor. */
    readonly first: boolean;
    /**
     * The column renders file cards. An unfilled slot's skeleton, anchor drift, "no hunks"
     * and a collapsed summary each take one row. There is nothing to remove, and e2e also counts plan skeletons.
     */
    readonly rendersCards: boolean;
    /** The stop flashes after a jump or is the target of a jump still in progress. */
    readonly jumping: boolean;
    /** A file in the stop contains a selection, an open composer or line focus. */
    readonly busy: boolean;
}

/**
 * Whether the stop's diff column can be removed from the DOM. Exceptions account for what
 * unmounting loses: local context bridge state, the comment editor instance,
 * line focus and `data-file` anchors for navigation after marking viewed.
 */
export function canUnmountStopDiff(state: StopDiffMountState): boolean {
    return (
        !state.nearViewport &&
        state.measuredHeight !== null &&
        !state.first &&
        state.rendersCards &&
        !state.jumping &&
        !state.busy
    );
}

/**
 * The stop is classified relative to the previous pass. Only these pass the
 * "what is new" filter (docs/design/README.md §9). The synthetic "Other" has no classification and is hidden along
 * with unchanged stops.
 */
export function entryChanged(entry: RouteEntry): boolean {
    return entry.kind === 'stop' && entry.view.stop.change !== null;
}

/**
 * The "what is new" filter is invalid when there are no classified stops. The entire
 * route is shown, with no chip or URL entry.
 */
export function changeFilterAvailable(entries: readonly RouteEntry[]): boolean {
    return entries.some(entryChanged);
}

/**
 * The entry passes the "what is new" filter. Stop numbers remain fixed by the plan.
 * The filter selects what to render, while the denominator in "02 / 7" counts the full set of entries.
 */
export function entryMatchesChangeFilter(entry: RouteEntry, active: boolean): boolean {
    return !active || entryChanged(entry);
}

/** Stops with no files left under the current filter are removed from the view (docs/design/SPEC-elements.md §2.7). */
export function stopMatchesFilter(view: RouteStopView, fileIds: ReadonlySet<string> | null): boolean {
    return fileIds === null || view.files.some((group) => fileIds.has(group.fileId));
}

export function otherMatchesFilter(view: RouteOtherView, fileIds: ReadonlySet<string> | null): boolean {
    return fileIds === null || view.files.some((group) => fileIds.has(group.fileId));
}

/**
 * "Other" under a filter. Both the heading and the button must count exactly what will expand.
 * `null` in `fileIds` means no filter (or the card is held on screen), so the view stays unchanged.
 */
export function filterOtherView(view: RouteOtherView, fileIds: ReadonlySet<string> | null): RouteOtherView {
    if (fileIds === null) {
        return view;
    }
    const files = view.files.filter((file) => fileIds.has(file.fileId));
    return { ...view, files, lines: files.reduce((total, file) => total + file.lines, 0) };
}

const EMPTY_FAILED: ReadonlySet<string> = new Set();
