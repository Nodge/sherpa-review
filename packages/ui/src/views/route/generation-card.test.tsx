import { readFileSync } from 'node:fs';

import { routeFixtures } from '@sherpa/fixtures';
import type { UiRouteState, UiTask } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { generationIsLong, LONG_GENERATION_MS } from '../../route/generation.js';
import type { OtherStopFacts } from '../../route/other-stop.js';
import {
    GenerationCard,
    GenerationFailedBanner,
    RouteActionErrorBanner,
    RouteFillingBanner,
    RouteRegeneratingBanner,
} from './generation-card.tsx';

/** Generation card: what the reviewer sees in each phase and where its counts come from. */

function state(phase: 'none' | 'reading' | 'filling' | 'ready' | 'failed'): UiRouteState {
    const fixture = routeFixtures('medium')?.states[phase] ?? null;
    if (fixture === null) {
        throw new Error(`medium fixture needs state ${phase}`);
    }
    return fixture;
}

const NOOP = (): void => undefined;

function render(
    route: UiRouteState,
    extra: { diffFiles?: number; longRunning?: boolean; other?: OtherStopFacts } = {},
): string {
    return renderToStaticMarkup(
        <GenerationCard
            route={route}
            {...(extra.other === undefined ? {} : { other: extra.other })}
            diffFiles={extra.diffFiles ?? null}
            longRunning={extra.longRunning ?? false}
            onOpenRoute={NOOP}
            onOpenDiff={NOOP}
            onRetry={NOOP}
            onCancel={NOOP}
        />,
    );
}

describe('route generation card', () => {
    it('phase A shows a spinner, three progress lines and an accurate note without a stop count', () => {
        const html = render(state('reading'), { diffFiles: 18 });

        expect(html).toContain('Reading the diff, planning the route');
        expect(html).toContain('~40 s');
        expect(html).toContain('Reading the whole diff · 18 files');
        expect(html).toContain('Deciding how many stops there will be and in what order');
        expect(html).toContain('Filling the stops one by one');
        expect(html).toContain('The plan comes first — until it lands there is nothing to count stops from');
        expect(html).toContain('Open the route skeleton');
        // Neither a counter nor a segment bar can appear in this phase: there is no plan yet (docs/design/README.md §6).
        expect(html).not.toContain('gen-bar');
        expect(html).not.toMatch(/\d+ of \d+ ready/);
    });

    it('a phase A rebuild keeps an entry point to the previous route', () => {
        const html = render({ ...state('reading'), snapshot: state('ready').snapshot });

        expect(html).toContain('Building a new route');
        expect(html).toContain('The previous route stays available');
        expect(html).toContain('Open the previous route');
        expect(html).toContain('the new plan replaces it whole only once accepted');
    });

    it('phase B shows "3 of 6 ready", one segment per slot and a plan list with statuses, without Other', () => {
        const html = render(state('filling'), { other: { uncovered: 300, conflictFiles: 0 } });

        expect(html).toContain('Filling the route');
        expect(html).toContain('3 of 6 ready');
        expect(count(html, 'class="gen-bar__segment')).toBe(6);
        expect(count(html, 'gen-bar__segment--ready')).toBe(3);
        expect(count(html, 'gen-bar__segment--filling')).toBe(1);
        expect(count(html, 'gen-bar__segment--queued')).toBe(2);
        expect(count(html, 'class="gen-plan__item')).toBe(6);
        expect(html).not.toContain('Other — lines');
        expect(html).toContain('The plan is fixed — stops are validated independently');
        expect(html).toContain('3 stops are already readable, 3 are placeholders');
    });

    it('shows "still working" with the phase count and cancellation after a minute (docs/design/SPEC-elements.md §3)', () => {
        expect(render(state('filling'), { longRunning: true })).toContain('still working · 3 of 6');
        // The reading phase has no count to show, so the line stays without one.
        expect(render(state('reading'), { longRunning: true })).toContain('still working<');
        expect(render(state('reading'), { longRunning: true })).toContain('Cancel');
        expect(render(state('filling'))).not.toContain('still working');
    });

    it('measures the 60 s threshold from the oldest open route task (docs/design/SPEC-elements.md §3)', () => {
        const created = Date.parse('2026-09-01T10:00:00.000Z');
        const task = (createdAt: string): UiTask => ({
            id: 1,
            type: 'route.section',
            priority: 'background',
            status: 'leased',
            heldByWorker: true,
            attempt: 1,
            instructions: 'fill the stop',
            progressText: null,
            result: null,
            failReason: null,
            createdAt,
            updatedAt: createdAt,
        });
        const tasks = [task(new Date(created).toISOString())];

        expect(generationIsLong(tasks, created + LONG_GENERATION_MS - 1)).toBe(false);
        expect(generationIsLong(tasks, created + LONG_GENERATION_MS)).toBe(true);
        // This flag turns on the line with cancellation. App calculates it from the ticking clock.
        const html = render(state('filling'), { longRunning: generationIsLong(tasks, created + LONG_GENERATION_MS) });
        expect(html).toContain('still working · 3 of 6');
        expect(html).toContain('>Cancel</button>');
    });

    it('a ready route shows the stop count, stop list and "Open the route"', () => {
        const ready = state('ready');
        const html = render(ready, { other: { uncovered: 38, conflictFiles: 0 } });
        const titles = ready.snapshot?.stops.map((stop) => stop.title) ?? [];

        expect(html).toContain('Route ready · 7 stops');
        expect(html).toContain('Open the route');
        expect(titles.length).toBe(7);
        // Titles go through the route Markdown profile, so the checks use numbers and plain text.
        expect([...html.matchAll(/gen-plan__number">(\d+)</gu)].map((match) => match[1])).toEqual([
            '01',
            '02',
            '03',
            '04',
            '05',
            '06',
            '07',
        ]);
        expect(html).toContain(titles[0]);
        expect(html).toContain('Other — lines the model did not place');
        expect(html).toContain('gen-plan__item--ready');
        // The bar, note and placeholder hint describe filling. They have nothing to say once the route is ready.
        expect(html).not.toContain('gen-bar');
        expect(html).not.toContain('gen-card__note');
        expect(html).not.toContain('gen-card__hint');
    });

    it('a ready route where the model placed everything has no Other in the count or plan', () => {
        const html = render(state('ready'), { other: { uncovered: 0, conflictFiles: 0 } });

        expect(html).toContain('Route ready · 6 stops');
        expect(count(html, 'class="gen-plan__item')).toBe(6);
        expect(html).not.toContain('Other — lines');
    });

    it('omits the stop count until uncovered ranges are counted, since Other may add a stop', () => {
        for (const other of [{ uncovered: null, conflictFiles: 0 }, undefined]) {
            const html = render(state('ready'), other === undefined ? {} : { other });

            expect(html).toContain('<h2 class="gen-card__title">Route ready</h2>');
            expect(html).not.toContain('Route ready ·');
            expect(html).not.toContain('Other — lines');
        }
    });

    it('shows failure as a compact red card without raw output or a footer', () => {
        const html = render(state('failed'));

        expect(html).toContain('gen-failed--compact');
        expect(html).toContain('2 stops reference services/orders/src/domain/order-state.ts');
        expect(html).toContain('Retry');
        expect(html).not.toContain('Show the raw output');
        expect(html).not.toContain('The reader below is untouched');
    });

    it('a failed rebuild names the new route, leaving the old readable route distinct', () => {
        const html = render({ ...state('failed'), snapshot: state('ready').snapshot });

        expect(html).toContain('The new route was not built');
    });

    it('shows no card when generation has never started', () => {
        expect(render(state('none'))).toBe('');
    });
});

describe('phase B plan list', () => {
    const css = readFileSync(new URL('./generation.css', import.meta.url), 'utf8');

    it('keeps queued items readable with their own text token instead of the segment fill', () => {
        // docs/design/README.md §7 distinguishes two colours: `#5c6288` for queued item text, `#2a2e4a` for the background
        // of an unlit bar segment. Combining them makes the lines invisible against the card background.
        const title = /\.gen-plan__title,\s*\.gen-plan__state\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

        expect(title).toContain('var(--accent-text-queued)');
        expect(title).not.toContain('var(--tier-unfilled)');
        expect(/\.gen-bar__segment\s*\{[^}]*var\(--tier-unfilled\)/.test(css)).toBe(true);
    });

    it('has status-specific overrides only for ready and filling items', () => {
        const html = render(state('filling'));

        expect(count(html, 'gen-plan__item--queued')).toBe(2);
        expect(count(html, 'gen-plan__item--ready')).toBe(3);
        expect(html).toContain('queued');
    });
});

describe('generation banners', () => {
    it('shows an endpoint error in a banner when there is no place for it at the call site', () => {
        const html = renderToStaticMarkup(
            <RouteActionErrorBanner message="This PR has no host adapter: there is no source for building a route." />,
        );

        expect(html).toContain('Route action did not go through.');
        expect(html).toContain('This PR has no host adapter');
    });

    it('counts filling slots from the snapshot and links to the full diff', () => {
        const snapshot = state('filling').snapshot;
        if (snapshot === null) {
            throw new Error('the filling state needs a snapshot');
        }
        const html = renderToStaticMarkup(<RouteFillingBanner snapshot={snapshot} onReadDiff={NOOP} />);

        expect(html).toContain('Filling the route · 3 of 6 stops ready');
        expect(html).toContain('stops appear out of order');
        expect(html).toContain('Meanwhile you can read the full diff');
    });

    it('the rebuild banner warns about marks and offers cancellation', () => {
        const html = renderToStaticMarkup(<RouteRegeneratingBanner onCancel={NOOP} />);

        expect(html).toContain('Building a new route — stop marks go away once it lands');
        expect(html).toContain('>Cancel</button>');
    });

    it('the failure banner shows the reason and exactly one action', () => {
        const html = renderToStaticMarkup(
            <GenerationFailedBanner message="Generation stopped at validation." onRetry={NOOP} />,
        );

        expect(html).toContain('The route was not built.');
        expect(html).toContain('Generation stopped at validation.');
        expect(count(html, '<button')).toBe(1);
    });

    it('the rebuild failure banner identifies the failed route as the new one', () => {
        const html = renderToStaticMarkup(
            <GenerationFailedBanner
                message="Generation stopped at validation."
                rebuilding
                onRetry={NOOP}
            />,
        );

        expect(html).toContain('The new route was not built.');
    });
});

function count(html: string, needle: string): number {
    return html.split(needle).length - 1;
}
