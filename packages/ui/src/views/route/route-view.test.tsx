import { fixtureData, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import type { StopsState } from '../../session/session-store.js';
import { createSessionStore, EMPTY_STOPS } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteWorkspace } from './route-view.tsx';
import { TRIAGE_HINT } from './route-toolbar.tsx';

/**
 * Route view component tests use static markup on a fixture (the same approach as
 * the M1-T14 action panel). They check what the reviewer sees: stop order, folds,
 * Other copy and SPEC §2.9 edge cases.
 */

const DATA = fixtureData('medium');
const READY = routeFixtures('medium')?.states.ready ?? null;
if (READY?.snapshot == null) {
    throw new Error('medium fixture needs a ready route snapshot');
}
const SNAPSHOT: RouteSnapshot = READY.snapshot;
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));

function render(
    options: { snapshot?: RouteSnapshot; filter?: string; stops?: StopsState; keptStopId?: string } = {},
): string {
    const store = createDiffViewStore({ files: DATA.diff.files, storage: null });
    for (const file of DATA.diff.files) {
        store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
    }
    return renderToStaticMarkup(
        <RouteWorkspace
            pr={DATA.pr}
            diff={DATA.diff}
            lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
            snapshot={options.snapshot ?? SNAPSHOT}
            session={createSessionStore({
                initial: { view: 'route', filter: options.filter ?? 'all', stops: options.stops ?? EMPTY_STOPS },
            })}
            store={store}
            threadStore={createThreadStore(DATA.threads, FILE_IDS)}
            threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
            {...(options.keptStopId === undefined ? {} : { initialKeptStopId: options.keptStopId })}
            parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
            loadContent={() => Promise.resolve(null)}
            onOpenInEditor={() => Promise.resolve(null)}
            onSetViewed={() => Promise.resolve(0)}
        />,
    );
}

/** Stop order in the markup, read from the `data-stop` attribute. */
function order(html: string): string[] {
    return [...html.matchAll(/data-stop="([^"]+)"/g)].map((match) => match[1] ?? '');
}

function withStops(patch: (snapshot: RouteSnapshot) => RouteSnapshot['stops']): RouteSnapshot {
    return { ...SNAPSHOT, stops: patch(SNAPSHOT) };
}

describe('route view', () => {
    it('renders stops in triage order with numbers fixed by the plan and Other at the end', () => {
        const html = render();

        expect(order(html)).toEqual(['s01', 's02', 's03', 's04', 's05', 's06', 'other']);
        expect(html).toContain('01 / 7');
        expect(html).toContain('07 / 7');
        expect(html).toContain('Other — lines the model did not place');
        expect(html).toContain('Open 34 lines');
    });

    it('the toolbar holds a static preset with a hint and disables the full tour', () => {
        const html = render();

        expect(html).toContain(TRIAGE_HINT);
        expect(html).toContain('Full tour');
        expect(html).toContain('full tour is not available yet');
    });

    it('the header has a snapshot pill with a short commit hash', () => {
        const html = render();

        expect(html).toContain(`snapshot ${SNAPSHOT.commit.slice(0, 7)} · current`);
    });

    it('a high stop gets a badge and a numbered region role', () => {
        const html = render();

        expect(html).toContain('aria-label="Stop 01 of 7 — The edit window became a domain concept"');
        expect(html).toContain('>high<');
    });

    it('collapsed low stops have dashed cards, expanded ones do not', () => {
        const collapsed = render();
        const expanded = render({ stops: { ...EMPTY_STOPS, expanded: new Set(['s05']) } });

        expect(collapsed).toContain('low tier');
        expect(collapsed).toContain('nothing is hidden — click to expand');
        // An expanded stop leaves only the neighbouring low stop collapsed.
        expect(count(collapsed, 'low tier')).toBe(2);
        expect(count(expanded, 'low tier')).toBe(1);
    });

    it('a viewed stop dims and collapses to a summary row', () => {
        const html = render({ stops: { ...EMPTY_STOPS, viewed: new Set(['s01']) } });

        expect(html).toContain('route-stop--high is-viewed');
        expect(html).toContain('· viewed');
        expect(html).toContain('✓ Viewed');
    });

    it('anchor drift shows a notice instead of an empty space', () => {
        const html = render({
            snapshot: withStops((snapshot) =>
                snapshot.stops.map((stop) =>
                    stop.id === 's01'
                        ? { ...stop, anchors: stop.anchors.map((anchor) => ({ ...anchor, fileId: 'gone' })) }
                        : stop,
                ),
            ),
        });

        expect(html).toContain('This stop pointed at lines that are no longer in the diff.');
    });

    it('when some anchors drift, a notice appears above the remaining cards', () => {
        const html = render({
            snapshot: withStops((snapshot) =>
                snapshot.stops.map((stop) =>
                    stop.id === 's03'
                        ? {
                              ...stop,
                              anchors: stop.anchors.map((anchor, index) =>
                                  index === 0 ? { ...anchor, fileId: 'gone' } : anchor,
                              ),
                          }
                        : stop,
                ),
            ),
        });
        const stop = section(html, 's03');

        expect(stop).toContain('Some anchors of this stop pointed at lines that are no longer in the diff.');
        // The remaining files in the stop still render.
        expect(stop).toContain('file-card');
    });

    it('filtered Other promises exactly what it will expand', () => {
        const all = render();
        const filtered = render({ filter: 'pci' });

        expect(all).toContain('Open 34 lines');
        expect(filtered).toContain('Open 17 lines');
        expect(filtered).not.toContain('Open 34 lines');
    });

    it('Other kept visible by the filter shows all its uncovered ranges', () => {
        const html = render({ filter: 'pci', keptStopId: 'other' });

        expect(html).toContain('Open 34 lines');
        expect(section(html, 'other')).toContain('kept in view — outside the current filter');
    });

    it('a stop without anchors shows a dashed card instead of an empty space', () => {
        const html = render({
            snapshot: withStops((snapshot) =>
                snapshot.stops.map((stop) => (stop.id === 's02' ? { ...stop, anchors: [] } : stop)),
            ),
        });

        expect(html).toContain('No hunks: filling marked up no ranges at all.');
    });

    it('promotes Other above low-tier stops when more than 40% is uncovered', () => {
        const html = render({
            snapshot: withStops((snapshot) =>
                snapshot.stops.map((stop) =>
                    stop.tier === 'low' || stop.id === 's03' ? { ...stop, anchors: [] } : stop,
                ),
            ),
        });

        expect(order(html)).toEqual(['s01', 's02', 's03', 's04', 'other', 's05', 's06']);
    });

    it('the filter hides stops with no matching files and keeps the stop being read visible', () => {
        const html = render({ filter: 'pci', keptStopId: 's01' });

        expect(order(html)).toEqual(['s01', 's03', 'other']);
        expect(html).toContain('kept in view — outside the current filter');
    });

    it('file chips show stop counts and a read indicator box', () => {
        const html = render();

        expect(html).toContain('route-chip__read');
        expect(html).toContain('edit-window.ts');
        expect(html).toContain('Go to this file in the stop’s diff');
    });

    it('the stop card renders the diff clipped by its anchors', () => {
        const html = render();
        const stop = section(html, 's01');

        // The first stop explains all of edit-window.ts: 94 added lines.
        expect(stop).toContain('+94');
        expect(stop).toContain('edit-window.ts');
        // Files from other stops never appear in its column as cards or chips.
        expect(stop).not.toContain('pnpm-lock.yaml');
        expect(stop).not.toContain('handlers.ts');
    });
});

/** Markup for one stop, from its `data-stop` to the next one. */
function section(html: string, stopId: string): string {
    const start = html.indexOf(`data-stop="${stopId}"`);
    const next = html.indexOf('data-stop="', start + 1);
    return html.slice(start, next === -1 ? undefined : next);
}

function count(html: string, needle: string): number {
    return html.split(needle).length - 1;
}
