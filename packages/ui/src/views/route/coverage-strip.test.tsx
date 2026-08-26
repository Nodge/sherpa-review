import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { buildCoverageStrip } from '../../route/coverage-model.js';
import type { RouteTotals } from '../../route/route-model.js';
import { CoverageStrip } from './coverage-strip.tsx';

/** Coverage strip as the reviewer sees it: widths, a 3px minimum, legend and loading state. */

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

function render(model: ReturnType<typeof buildCoverageStrip> | null, stops = { viewed: 0, total: 0 }): string {
    return renderToStaticMarkup(
        <CoverageStrip model={model} viewedStops={stops.viewed} totalStops={stops.total} />,
    );
}

describe('coverage strip', () => {
    it('sets segment widths as fractions with a 3px minimum', () => {
        const html = render(
            buildCoverageStrip({
                totals: totals({ changed: 200, uncovered: 6, byTier: { high: 194, medium: 0, low: 0, other: 6 } }),
                entries: [],
            }),
        );

        expect(html).toContain('flex-grow:0.97');
        expect(html).toContain('flex-grow:0.03');
        expect(count(html, 'min-width:3px')).toBe(2);
    });

    it('has no hatch or third clause when 100% is explained', () => {
        const html = render(buildCoverageStrip({ totals: totals({}), entries: [] }), { viewed: 3, total: 7 });

        expect(html).toContain('100% explained');
        expect(html).not.toContain('not explained');
        expect(html).not.toContain('coverage__segment--other');
        expect(html).toContain('3 of 7 stops viewed');
    });

    it('loading state: shows a flat track, shimmer over ready stops and an accurate legend', () => {
        const html = renderToStaticMarkup(
            <CoverageStrip model={null} loading={{ kind: 'plan', ready: 3, total: 7 }} viewedStops={0} totalStops={7} />,
        );

        expect(html).toContain('coverage known after the plan');
        expect(html).toContain('coverage__shimmer');
        expect(html).toContain('coverage__rest');
        expect(html).not.toContain('coverage__segment');
    });

    it('has no denominator before the plan arrives, so the shimmer fills the track', () => {
        const html = renderToStaticMarkup(
            <CoverageStrip model={null} loading={{ kind: 'plan', ready: 0, total: 0 }} />,
        );

        expect(html).toContain('coverage__shimmer');
        expect(html).not.toContain('coverage__rest');
        expect(html).not.toContain('viewed');
    });
});

function count(html: string, needle: string): number {
    return html.split(needle).length - 1;
}
