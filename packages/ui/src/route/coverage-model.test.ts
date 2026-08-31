import { fixtureData, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import type { ChangedLines } from '../progress/read-state.js';
import { changedLinesOf, readStateOf } from '../progress/read-state.js';
import { buildCoverageStrip } from './coverage-model.js';
import type { RouteEntry, RouteTotals } from './route-model.js';
import { buildRouteModel, stopSeenRanges } from './route-model.js';

/**
 * Coverage strip and stop seen ranges (SPEC §2.4, §2.10) on the `medium` fixture:
 * 860 changed lines in coverage counts (862 in the patches: 2 empty lines outside anchors
 * are excluded, decision log 2026-08-26), tiers 196 / 327 / 305, uncovered 32.
 * This test fails if the counts diverge.
 */

const DATA = fixtureData('medium');
const READY = routeFixtures('medium')?.states.ready ?? null;
if (READY?.snapshot == null) {
    throw new Error('medium fixture needs a ready route snapshot');
}
const SNAPSHOT: RouteSnapshot = READY.snapshot;
const MODELS = new Map<string, DiffFileModel>(
    DATA.diff.files.map((file) => [file.fileId, parseFileDiff(toParseRequest(file))]),
);

function model() {
    return buildRouteModel({ snapshot: SNAPSHOT, files: DATA.diff.files, models: MODELS });
}

function strip() {
    const built = model();
    return buildCoverageStrip({ totals: built.totals, entries: built.entries });
}

/** Explicit totals keep minimum-width and zero-tier tests independent of the fixture. */
function totals(patch: Partial<RouteTotals>): RouteTotals {
    return {
        changed: 100,
        covered: 100,
        uncovered: 0,
        byTier: { high: 100, medium: 0, low: 0, other: 0 },
        pendingFiles: 0,
        failedFiles: 0,
        ...patch,
    };
}

describe('coverage bar model', () => {
    it('sizes segments proportionally to changed fixture lines', () => {
        const built = strip();

        expect(built.changed).toBe(860);
        expect(built.uncovered).toBe(32);
        expect(built.explained).toBe(828);
        expect(built.segments.map((segment) => [segment.tier, segment.lines])).toEqual([
            ['high', 196],
            ['medium', 327],
            ['low', 305],
            ['other', 32],
        ]);
        // Shares use changed lines as the denominator, not the sum of segments.
        expect(built.segments.map((segment) => segment.share)).toEqual([196 / 860, 327 / 860, 305 / 860, 32 / 860]);
    });

    it('includes the range of stop plan numbers in the segment tooltip', () => {
        const built = strip();

        expect(built.segments[0]?.title).toBe('high · stops 01–02 · 196 lines');
        expect(built.segments[1]?.title).toBe('medium · stops 03–04 · 327 lines');
        expect(built.segments[3]?.title).toBe('not explained · 32 lines');
    });

    it('clicks go to the first stop in the tier and the hatch goes to Other', () => {
        const built = strip();

        expect(built.segments[0]?.targetStopId).toBe('s01');
        expect(built.segments[0]?.stopIds).toEqual(['s01', 's02']);
        expect(built.segments[3]?.targetStopId).toBe('other');
        expect(built.otherStopId).toBe('other');
    });

    it('calculates the legend and rounds the percentage down', () => {
        const built = strip();

        // 828 / 860 = 96.27…%, which is "96%", not "97%".
        expect(built.percent).toBe(96);
        expect(built.legend.changed).toBe('860 changed lines');
        expect(built.legend.explained).toBe('96% explained');
        expect(built.legend.unexplained).toBe('32 lines not explained');
    });

    it('rounds the percentage down at the boundary too', () => {
        const built = buildCoverageStrip({
            totals: totals({ changed: 1000, uncovered: 44, byTier: { high: 956, medium: 0, low: 0, other: 44 } }),
            entries: [],
        });

        // 95.6% means "95%", never "96%" (SPEC §2.4).
        expect(built.percent).toBe(95);
    });

    it('omits the hatch and third clause when 100% is explained', () => {
        const built = buildCoverageStrip({ totals: totals({}), entries: [] });

        expect(built.segments.map((segment) => segment.tier)).toEqual(['high']);
        expect(built.percent).toBe(100);
        expect(built.legend.unexplained).toBeNull();
    });

    it('does not render a tier with zero lines', () => {
        const built = buildCoverageStrip({
            totals: totals({
                changed: 60,
                uncovered: 6,
                byTier: { high: 54, medium: 0, low: 0, other: 6 },
            }),
            entries: [],
        });

        expect(built.segments.map((segment) => segment.tier)).toEqual(['high', 'other']);
        // The 6-line chunk stays in the bar. Its width stops at the minimum instead of disappearing.
        expect(built.segments[1]?.lines).toBe(6);
    });
});

describe('stop seen ranges', () => {
    it('returns covered changed lines of its files for a regular stop', () => {
        const stop = model().entries.find(
            (entry): entry is Extract<RouteEntry, { kind: 'stop' }> =>
                entry.kind === 'stop' && entry.view.stop.id === 's01',
        );
        if (stop === undefined) {
            throw new Error('model has no stop s01');
        }
        const ranges = stopSeenRanges(stop);

        expect(ranges.length).toBeGreaterThan(0);
        expect(lines(ranges)).toBe(stop.view.changedLines);
        // Range files are exactly the stop's files.
        expect(new Set(ranges.map((range) => range.fileId))).toEqual(
            new Set(stop.view.files.map((group) => group.fileId)),
        );
    });

    it('ranges of all stops and Other add up to all changed diff lines', () => {
        const built = model();
        const total = built.entries.reduce((sum, entry) => sum + lines(stopSeenRanges(entry)), 0);

        expect(total).toBe(862);
    });

    it('Other returns the uncovered ranges: those same 34 lines in 3 files', () => {
        const built = model();
        const other = built.entries.find((entry) => entry.kind === 'other');
        if (other === undefined) {
            throw new Error('model has no Other stop');
        }
        const ranges = stopSeenRanges(other);

        expect(lines(ranges)).toBe(34);
        expect(new Set(ranges.map((range) => range.fileId)).size).toBe(3);
    });
});

describe('read-state from a stop mark', () => {
    it('a fully covered file is read, a partially covered file is partial, and tooltip counts match', () => {
        const built = model();
        const seen: string[] = [];

        for (const entry of built.entries) {
            if (entry.kind !== 'stop') {
                continue;
            }
            const ranges = stopSeenRanges(entry);
            for (const group of entry.view.files) {
                const state = readStateOf({
                    file: group.file,
                    record: {
                        fileId: group.fileId,
                        viewed: false,
                        seenRanges: ranges
                            .filter((range) => range.fileId === group.fileId)
                            .map(({ side, start, end }) => ({ side, start, end })),
                    },
                    changed: changedOf(group.fileId),
                });

                expect(state.state).toBe(group.whole ? 'read' : 'partial');
                // The tooltip must give the exact count that filled the indicator (SPEC §2.12).
                expect(state.seen).toBe(group.additions + group.deletions);
                expect(state.tooltip).toBe(
                    `${String(state.seen)} of ${String(state.total)} changed lines seen`,
                );
                seen.push(`${entry.view.stop.id}:${group.fileId}`);
            }
        }

        // The check must not silently turn into an empty loop.
        expect(seen.length).toBeGreaterThan(5);
    });

    it('clearing a stop mark preserves the generated default for a file with Other ranges', () => {
        const built = model();
        const other = built.entries.find((entry) => entry.kind === 'other');
        const partialGroup = built.entries
            .flatMap((entry) => (entry.kind === 'stop' ? entry.view.files : []))
            .find((group) => !group.whole && other !== undefined && stopSeenRanges(other).some((range) => range.fileId === group.fileId));
        if (other === undefined || partialGroup === undefined) {
            throw new Error('fixture has no file shared between a stop and Other');
        }

        // The stop and "Other" were viewed. Clearing the stop leaves only "Other"
        // ranges and no file_progress row. The server returns viewed: null.
        const rest = stopSeenRanges(other)
            .filter((range) => range.fileId === partialGroup.fileId)
            .map(({ side, start, end }) => ({ side, start, end }));
        const state = readStateOf({
            file: partialGroup.file,
            record: { fileId: partialGroup.fileId, viewed: null, seenRanges: rest },
            changed: changedOf(partialGroup.fileId),
        });

        expect(partialGroup.file.path).toBe('services/orders/src/payments/generated/psp-schema.ts');
        expect(rest.length).toBeGreaterThan(0);
        expect(state).toMatchObject({
            state: 'read',
            seen: partialGroup.file.additions + partialGroup.file.deletions,
            pinned: true,
            generatedDefault: true,
        });
        expect(state.tooltip).toContain('generated file — read by default');
    });
});

/** Changed lines of the parsed model feed read-state. Every fixture file has them. */
function changedOf(fileId: string): ChangedLines {
    const changed = changedLinesOf(MODELS.get(fileId) ?? null);
    if (changed === undefined) {
        throw new Error(`file ${fileId} has no parsed model`);
    }
    return changed;
}

function lines(ranges: readonly { start: number; end: number }[]): number {
    return ranges.reduce((total, range) => total + (range.end - range.start + 1), 0);
}
