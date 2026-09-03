import type { FileDiff, RouteSnapshot } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';
import type { Translate } from '../i18n/index.js';
import { stripInlineCode } from '../markdown/markdown.js';
import { changedLinesOf } from '../progress/read-state.js';
import type { AnchorSpan } from './anchor-clip.js';
import { droppedWhitespaceLines, spanLines, uncoveredRanges } from './anchor-clip.js';
import { planLabel } from './route-model.js';

/**
 * Route in the full diff margins (README §10): which stop explains each file, what has no
 * stop at all, and how many there are. A pure module with no React or DOM.
 *
 * Unlike `buildRouteModel`, which needs threads, composers and models trimmed to stop cards,
 * this only needs anchors. The file→stops map needs no patch parsing, so
 * tree and card badges appear immediately. Uncovered ranges use the same `uncoveredRanges` and
 * `changedLinesOf` rule as Other and the coverage bar, so their counts agree by construction.
 */

/** A stop explaining a file. Title and number come from the snapshot, order comes from the plan. */
export interface RouteMarginStop {
    readonly stopId: string;
    readonly planLabel: string;
    readonly title: string;
}

export interface RouteMarginFile {
    readonly fileId: string;
    /** File stops in plan order. Empty means no stop contains the file (it is all in Other). */
    readonly stops: readonly RouteMarginStop[];
    /** Ranges of changed file lines without a stop. Empty until the patch is parsed. */
    readonly uncovered: readonly AnchorSpan[];
    readonly uncoveredLines: number;
    /** The patch is parsed, so uncovered lines have been counted rather than remaining unknown. */
    readonly parsed: boolean;
    /** The file has changed lines. Without them it is not "outside route", as there is nothing to place. */
    readonly changed: boolean;
}

export interface RouteMarginModel {
    readonly files: ReadonlyMap<string, RouteMarginFile>;
    /** Other is the target of a hatched badge click. null means it is absent from the snapshot. */
    readonly otherStopId: string | null;
    readonly uncoveredLines: number;
    readonly uncoveredFiles: number;
    /** Files without parsed patches. While any remain, the uncovered count is incomplete. */
    readonly pendingFiles: number;
    /** Files that failed to parse. Their lines are excluded from the count and need a retry to be included. */
    readonly failedFiles: number;
}

export interface RouteMarginInput {
    readonly snapshot: RouteSnapshot;
    readonly files: readonly FileDiff[];
    readonly models: ReadonlyMap<string, DiffFileModel>;
    readonly failed?: ReadonlySet<string>;
}

export function buildRouteMargin({ snapshot, files, models, failed = EMPTY_FAILED }: RouteMarginInput): RouteMarginModel {
    // Other is excluded from the map because its contents are "not placed". A stop badge on it
    // would say the opposite.
    const planned = [...snapshot.stops]
        .filter((stop) => stop.tier !== 'other')
        .sort((left, right) => left.planIndex - right.planIndex);

    const stopsByFile = new Map<string, RouteMarginStop[]>();
    const claimed = new Map<string, AnchorSpan[]>();
    for (const stop of planned) {
        const view: RouteMarginStop = { stopId: stop.id, planLabel: planLabel(stop.planIndex), title: stop.title };
        for (const anchor of stop.anchors) {
            const stops = stopsByFile.get(anchor.fileId) ?? [];
            // Multiple anchors from one stop in a file produce one entry. The badge counts stops.
            if (stops.at(-1)?.stopId !== stop.id) {
                stops.push(view);
            }
            stopsByFile.set(anchor.fileId, stops);

            const spans = claimed.get(anchor.fileId) ?? [];
            spans.push({ side: anchor.side, start: anchor.start, end: anchor.end });
            claimed.set(anchor.fileId, spans);
        }
    }

    const byFile = new Map<string, RouteMarginFile>();
    let uncoveredLines = 0;
    let uncoveredFiles = 0;
    let pendingFiles = 0;
    let failedFiles = 0;
    for (const file of files) {
        const model = models.get(file.fileId) ?? null;
        if (model === null) {
            if (failed.has(file.fileId)) {
                failedFiles += 1;
            } else {
                pendingFiles += 1;
            }
        }
        const spans = claimed.get(file.fileId) ?? EMPTY_SPANS;
        const uncovered = model === null ? EMPTY_SPANS : uncoveredRanges(model, spans);
        const lines = spanLines(uncovered);
        uncoveredLines += lines;
        uncoveredFiles += lines > 0 ? 1 : 0;
        byFile.set(file.fileId, {
            fileId: file.fileId,
            stops: stopsByFile.get(file.fileId) ?? EMPTY_STOPS,
            uncovered,
            uncoveredLines: lines,
            parsed: model !== null,
            changed: changedLineCount(model, file, spans) > 0,
        });
    }

    return {
        files: byFile,
        otherStopId: snapshot.stops.find((stop) => stop.tier === 'other')?.id ?? null,
        uncoveredLines,
        uncoveredFiles,
        pendingFiles,
        failedFiles,
    };
}

/** Whether the file has a badge. Without changed lines there is nothing to place (binary file, mode change). */
export function marginBadgeShown(file: RouteMarginFile): boolean {
    return file.stops.length > 0 || file.changed;
}

/** Badge click target: the file's first stop, or Other for a hatch. */
export function marginTargetStopId(file: RouteMarginFile, otherStopId: string | null): string | null {
    return file.stops[0]?.stopId ?? otherStopId;
}

/** Number in the tree row: the first stop plus "+N" if the file belongs to several. */
export function treeBadgeLabel(file: RouteMarginFile, t: Translate): string {
    const first = file.stops[0];
    if (first === undefined) {
        return t('margin.notPlaced');
    }
    return file.stops.length === 1 ? first.planLabel : `${first.planLabel} +${String(file.stops.length - 1)}`;
}

/** Card badge (README §10): "explained in 02 · stop title". */
export function marginBadgeLabel(file: RouteMarginFile, t: Translate): string {
    const first = file.stops[0];
    if (first === undefined) {
        return t('margin.notPlacedCard');
    }
    // The badge is a single-line chip. It cannot take markdown, so the model's backticks are stripped (M2F-T5).
    const title = stripInlineCode(first.title);
    return file.stops.length === 1
        ? t('margin.badge.explained', first.planLabel, title)
        : t('margin.badge.explainedMore', first.planLabel, file.stops.length - 1, title);
}

/**
 * Badge tooltip and accessible label. For a file in multiple stops, it lists them all. The label fits
 * only the first, and the reviewer needs to know where a click will take them beforehand.
 */
export function marginBadgeTitle(file: RouteMarginFile, jumps: boolean, t: Translate): string {
    const first = file.stops[0];
    if (first === undefined) {
        return t(jumps ? 'margin.badge.notPlacedJump' : 'margin.badge.notPlaced');
    }
    const numbers = file.stops.map((stop) => stop.planLabel).join(', ');
    const title = stripInlineCode(first.title);
    const where =
        file.stops.length === 1
            ? t('margin.badge.title', first.planLabel, title)
            : t('margin.badge.titleMany', numbers, title);
    return jumps ? t('margin.badge.titleJump', where) : where;
}

/**
 * Label for the hatched strip below the last line of an uncovered range. The old side contains
 * deleted lines, which the label must state because the two sides have different line numbers.
 */
export function marginStripText(span: AnchorSpan, t: Translate): string {
    const removed = span.side === 'old';
    // Numbers match the card gutter (`diff-rows`), without digit grouping. The strip points
    // to a line, and "1 234" is hard to match visually with "1234".
    const range = span.start === span.end ? String(span.start) : `${String(span.start)}–${String(span.end)}`;
    if (span.start === span.end) {
        return t(removed ? 'margin.strip.lineRemoved' : 'margin.strip.line', range);
    }
    return t(removed ? 'margin.strip.linesRemoved' : 'margin.strip.lines', range);
}

/** Summary of ranges with no rendered line (collapsed card, "whitespace only"). */
export function marginStripSummary(spans: readonly AnchorSpan[], t: Translate): string {
    return t('margin.strip.summary', spanLines(spans));
}

/**
 * File panel footer note (README §10). Counts are computed: while patches are being parsed, the note
 * says it is counting instead of showing an intermediate total.
 */
export function marginFooterNote(model: RouteMarginModel, t: Translate): string | null {
    if (model.pendingFiles > 0) {
        return t('margin.footer.counting');
    }
    const failed = model.failedFiles === 0 ? '' : t('margin.footer.failed', model.failedFiles);
    if (model.uncoveredLines === 0) {
        return failed === '' ? null : t('margin.footer.hatchOnly', failed);
    }
    return t('margin.footer.uncovered', model.uncoveredLines, model.uncoveredFiles, failed);
}

/**
 * Changed file lines use the same `changedLinesOf` rule as everywhere else. Without a model,
 * use patch counts. Binary files and mode changes give zero and get no badge.
 *
 * Empty and whitespace-only lines outside anchors are subtracted, as in the route view denominator (decision
 * log, 2026-08-26): a file with no other changes has nowhere to go, so the hatched
 * "outside route" badge would link to Other, which does not contain this file.
 */
function changedLineCount(model: DiffFileModel | null, file: FileDiff, anchors: readonly AnchorSpan[]): number {
    const changed = changedLinesOf(model);
    if (changed !== undefined) {
        return changed.old.size + changed.new.size - droppedWhitespaceLines(model, anchors);
    }
    return model === null ? file.additions + file.deletions : 0;
}

const EMPTY_FAILED: ReadonlySet<string> = new Set();
const EMPTY_SPANS: readonly AnchorSpan[] = [];
const EMPTY_STOPS: readonly RouteMarginStop[] = [];
