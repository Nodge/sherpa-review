import type { RouteTier } from '@sherpa/protocol';

import { formatCount, plural } from '../i18n/index.js';
import type { RouteEntry, RouteTotals } from './route-model.js';

/**
 * Coverage strip model (SPEC §2.4, README §1): segments are proportional to changed lines,
 * and the legend is calculated, not hardcoded. This pure module takes route totals and stops
 * and returns what the bar renders. It uses neither React nor DOM.
 *
 * Counts must match the rest of the view. `RouteTotals` use the same diff model as
 * chips and "Other", so this module only handles layout and text, with no separate arithmetic.
 */

/** Minimum segment width: a 6-line piece must remain clickable (SPEC §2.4). */
export const MIN_SEGMENT_PX = 3;

/** Segment order from left to right, with important changes first and the hatch last. */
const TIER_ORDER: readonly RouteTier[] = ['high', 'medium', 'low', 'other'];

const TIER_LABEL: Readonly<Record<RouteTier, string>> = {
    high: 'high',
    medium: 'medium',
    low: 'low',
    other: 'not explained',
};

export interface CoverageSegment {
    readonly tier: RouteTier;
    readonly lines: number;
    /** Share of changed lines, which sets segment width instead of pixels. */
    readonly share: number;
    /** `title` tooltip with the tier, its stop plan number range and line count. */
    readonly title: string;
    /** Stops in the tier receive an accent line on hover, in both directions. */
    readonly stopIds: readonly string[];
    /** Click destination is the first stop in the tier, or "Other" for the hatch. */
    readonly targetStopId: string | null;
}

export interface CoverageLegend {
    readonly changed: string;
    readonly explained: string;
    /** `null` at 100% explained: omit the third clause instead of writing "0 lines" (SPEC §2.4). */
    readonly unexplained: string | null;
}

export interface CoverageStripModel {
    readonly segments: readonly CoverageSegment[];
    readonly changed: number;
    readonly explained: number;
    /** Percentage rounds down. 95.6% gives "95%", never "96%". */
    readonly percent: number;
    readonly uncovered: number;
    readonly legend: CoverageLegend;
    /** The "Other" stop, when present in the route, is the destination for the legend link and hatch. */
    readonly otherStopId: string | null;
}

export interface CoverageStripInput {
    readonly totals: RouteTotals;
    /** Route entries in render order supply plan numbers and jump destinations. */
    readonly entries: readonly RouteEntry[];
}

export function buildCoverageStrip({ totals, entries }: CoverageStripInput): CoverageStripModel {
    const changed = totals.changed;
    const uncovered = totals.uncovered;
    const explained = Math.max(changed - uncovered, 0);
    const percent = changed === 0 ? 100 : Math.floor((explained / changed) * 100);
    const otherStopId = entries.find((entry) => entry.kind === 'other')?.view.stop.id ?? null;

    const byTier = new Map<RouteTier, { ids: string[]; labels: string[] }>();
    for (const entry of entries) {
        const tier = entry.kind === 'other' ? 'other' : entry.view.stop.tier;
        const bucket = byTier.get(tier) ?? { ids: [], labels: [] };
        bucket.ids.push(entry.view.stop.id);
        bucket.labels.push(entry.view.planLabel);
        byTier.set(tier, bucket);
    }

    const segments: CoverageSegment[] = [];
    for (const tier of TIER_ORDER) {
        const lines = totals.byTier[tier];
        // A tier with zero lines is not rendered. A hairline segment would mislead (SPEC §2.4).
        if (lines <= 0) {
            continue;
        }
        const bucket = byTier.get(tier) ?? { ids: [], labels: [] };
        segments.push({
            tier,
            lines,
            share: changed === 0 ? 0 : lines / changed,
            title: segmentTitle(tier, bucket.labels, lines),
            stopIds: bucket.ids,
            targetStopId: (tier === 'other' ? otherStopId : (bucket.ids[0] ?? null)) ?? null,
        });
    }

    return {
        segments,
        changed,
        explained,
        percent,
        uncovered,
        legend: {
            changed: `${formatCount(changed, 'ru')} ${plural(changed, { one: 'changed line', few: 'changed lines', many: 'changed lines', other: 'changed lines' }, 'ru')}`,
            explained: `${String(percent)}% explained`,
            unexplained:
                uncovered === 0
                    ? null
                    : `${formatCount(uncovered, 'ru')} ${plural(uncovered, { one: 'line not explained', few: 'lines not explained', many: 'lines not explained', other: 'lines not explained' }, 'ru')}`,
        },
        otherStopId,
    };
}

/** "high · stops 01–02 · 196 lines" uses a calculated number range, not a manually set one. */
function segmentTitle(tier: RouteTier, labels: readonly string[], lines: number): string {
    const counted = `${formatCount(lines, 'ru')} ${plural(lines, { one: 'line', few: 'lines', many: 'lines', other: 'lines' }, 'ru')}`;
    if (tier === 'other' || labels.length === 0) {
        return `${TIER_LABEL[tier]} · ${counted}`;
    }
    const sorted = [...labels].sort((left, right) => left.localeCompare(right));
    const first = sorted[0] ?? '';
    const last = sorted.at(-1) ?? '';
    const stops = first === last ? `stop ${first}` : `stops ${first}–${last}`;
    return `${TIER_LABEL[tier]} · ${stops} · ${counted}`;
}
