import { fixtureData, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import type { RoutePreset, SessionStore, StopsState } from '../../session/session-store.js';
import { createSessionStore, EMPTY_STOPS } from '../../session/session-store.js';
import type { ThreadStore } from '../../threads/store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteWorkspace } from './route-view.tsx';
import { TOUR_HINT, TRIAGE_HINT } from './route-toolbar.tsx';
import { DIGEST_NOTE, UNCOVERED_NOTE } from './test-digest.tsx';

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
    options: {
        snapshot?: RouteSnapshot;
        filter?: string;
        preset?: RoutePreset;
        stops?: StopsState;
        stopViewed?: readonly string[];
        keptStopId?: string;
        /** Shared session and thread store to check what survives a preset change. */
        session?: SessionStore;
        threadStore?: ThreadStore;
        /** `false` means diff models are not parsed yet, so view counts are not final. */
        parsed?: boolean;
        /** Global diff mode (SPEC §2.6): applies to route cards too. */
        mode?: 'unified' | 'split';
        onSetStopViewed?: (stopId: string, viewed: boolean) => Promise<number>;
    } = {},
): string {
    const store = createDiffViewStore({ files: DATA.diff.files, storage: null });
    if (options.mode !== undefined) {
        store.setDiffMode(options.mode);
    }
    if (options.parsed !== false) {
        for (const file of DATA.diff.files) {
            store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
    }
    return renderToStaticMarkup(
        <RouteWorkspace
            pr={DATA.pr}
            diff={DATA.diff}
            lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
            snapshot={options.snapshot ?? SNAPSHOT}
            session={
                options.session ??
                createSessionStore({
                    initial: {
                        view: 'route',
                        filter: options.filter ?? 'all',
                        stops: options.stops ?? EMPTY_STOPS,
                        ...(options.preset === undefined ? {} : { preset: options.preset }),
                    },
                })
            }
            store={store}
            threadStore={options.threadStore ?? createThreadStore(DATA.threads, FILE_IDS)}
            threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
            {...(options.keptStopId === undefined ? {} : { initialKeptStopId: options.keptStopId })}
            {...(options.stopViewed === undefined ? {} : { initialStopViewed: options.stopViewed })}
            parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
            loadContent={() => Promise.resolve(null)}
            onOpenInEditor={() => Promise.resolve(null)}
            onSetViewed={() => Promise.resolve(0)}
            onSetStopViewed={options.onSetStopViewed ?? (() => Promise.resolve(0))}
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

/** Digest assertion anchors lead to s01, while the files in s04 itself remain unchanged. */
function digestOutsideStopSnapshot(): RouteSnapshot {
    const target = SNAPSHOT.stops.find((stop) => stop.id === 's01')?.anchors[0];
    if (target === undefined) {
        throw new Error('stop s01 needs an anchor for the derived snapshot');
    }
    return withStops((snapshot) =>
        snapshot.stops.map((stop) =>
            stop.id !== 's04'
                ? stop
                : {
                      ...stop,
                      tests: stop.tests.map((claim) =>
                          claim.kind === 'uncovered'
                              ? claim
                              : {
                                    ...claim,
                                    anchor: { fileId: target.fileId, path: target.path, line: target.start },
                                },
                      ),
                  },
        ),
    );
}

describe('route view', () => {
    it('renders stops in triage order with numbers fixed by the plan and Other at the end', () => {
        const html = render();

        expect(order(html)).toEqual(['s01', 's02', 's03', 's04', 's05', 's06', 'other']);
        expect(html).toContain('01 / 7');
        expect(html).toContain('07 / 7');
        expect(html).toContain('Other — lines the model did not place');
        expect(html).toContain('Open 32 lines');
    });

    it('the preset switch shows the active option and its tooltip', () => {
        const triage = render();
        const tour = render({ preset: 'tour' });

        expect(triage).toContain(TRIAGE_HINT);
        expect(triage).not.toContain(TOUR_HINT);
        expect(triage).toContain('aria-pressed="true">Triage</button>');
        expect(triage).toContain('aria-pressed="false">Full tour</button>');
        expect(tour).toContain(TOUR_HINT);
        expect(tour).not.toContain(TRIAGE_HINT);
        expect(tour).toContain('aria-pressed="true">Full tour</button>');
    });

    it('Full tour orders stops by tourOrder while their numbers stay fixed by the plan', () => {
        const html = render({ preset: 'tour' });

        expect(order(html)).toEqual([...SNAPSHOT.tourOrder]);
        expect(order(html)).not.toEqual(order(render()));
        // Stop 03 comes first with its own number, not "01".
        expect(section(html, 's03')).toContain('03 / 7');
        expect(section(html, 's01')).toContain('01 / 7');
        expect(section(html, 'other')).toContain('07 / 7');
    });

    it('an invalid tourOrder does not crash the view, unknown ids are skipped and omitted stops go last', () => {
        const html = render({
            preset: 'tour',
            snapshot: { ...SNAPSHOT, tourOrder: ['s04', 'no-such-stop', 's01'] },
        });

        expect(order(html)).toEqual(['s04', 's01', 's02', 's03', 's05', 's06', 'other']);
        expect(html).toContain('0 of 7 stops viewed');
    });

    it('switching presets preserves marks, the filter and expanded state', () => {
        const session = createSessionStore({
            initial: {
                view: 'route',
                filter: 'pci',
                stops: { ...EMPTY_STOPS, expanded: new Set(['s05']), collapsed: new Set(['s02']) },
            },
        });
        const triage = render({ session, stopViewed: ['s03'] });
        session.setPreset('tour');
        const tour = render({ session, stopViewed: ['s03'] });

        expect(session.getSnapshot().filter).toBe('pci');
        expect(session.getSnapshot().stops.expanded.has('s05')).toBe(true);
        expect(session.getSnapshot().stops.collapsed.has('s02')).toBe(true);
        // The filter applies to the same set of stops in both presets.
        expect([...order(tour)].sort()).toEqual([...order(triage)].sort());
        for (const html of [triage, tour]) {
            expect(section(html, 's03')).toContain('</span>Viewed</button>');
        }
    });

    it('a comment draft survives reordering because it lives in the store, not the card', () => {
        const threadStore = createThreadStore(DATA.threads, FILE_IDS);
        const anchor = SNAPSHOT.stops[0]?.anchors[0];
        if (anchor === undefined) {
            throw new Error('the first fixture stop must have an anchor');
        }
        const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        threadStore.openComposer({
            key: `new:${anchor.fileId}:${anchor.side}:${String(anchor.start)}`,
            threadId: null,
            parentId: null,
            anchor: {
                fileId: anchor.fileId,
                path: anchor.path,
                position: { side: anchor.side, line: anchor.start, size: 1 },
            },
            text: 'the draft survives reordering',
            commentId: null,
            status: 'idle',
            saveUncertain: false,
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        const triage = render({ session, threadStore });
        session.setPreset('tour');
        const tour = render({ session, threadStore });

        expect(triage).toContain('the draft survives reordering');
        expect(tour).toContain('the draft survives reordering');
        expect(order(tour)).toEqual([...SNAPSHOT.tourOrder]);
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

    it('model backticks produce monospace text and plain attribute values', () => {
        const html = render();
        const head = section(html, 's02').slice(0, section(html, 's02').indexOf('route-stop__diff'));

        // Stop title and paragraph: backticked code becomes an element, with no backticks on screen.
        expect(head).toContain('<code class="md-code">EditWindow</code>');
        expect(head).not.toContain('`');
        // The same title in the region announcement has no markup at all.
        expect(html).toContain('aria-label="Stop 02 of 7 — Policy decides by EditWindow, not by the clock"');
        // Digest assertions use the same rendering rules.
        expect(section(html, 's04')).toContain('<code class="md-code">dispatch</code>');
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
        const html = render({ stopViewed: ['s01'] });

        expect(html).toContain('route-stop--high is-viewed');
        expect(html).toContain('· viewed');
        expect(html).toContain('</span>Viewed</button>');
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

        expect(all).toContain('Open 32 lines');
        expect(filtered).toContain('Open 15 lines');
        expect(filtered).not.toContain('Open 32 lines');
    });

    it('Other kept visible by the filter shows all its uncovered ranges', () => {
        const html = render({ filter: 'pci', keptStopId: 'other' });

        expect(html).toContain('Open 32 lines');
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

    it('the toolbar shows a coverage bar with fixture counts and a stop counter', () => {
        const html = render();

        expect(html).toContain('860 changed lines');
        expect(html).toContain('96% explained');
        expect(html).toContain('32 lines not explained');
        expect(html).toContain('high · stops 01–02 · 196 lines');
        expect(html).toContain('0 of 7 stops viewed');
        // The fixture has no empty tiers, so there are exactly four segments.
        expect(count(html, 'coverage__segment coverage__segment--')).toBe(4);
    });

    it('the bar stays in loading state until the diff is parsed without promising 100% explained', () => {
        const html = render({ parsed: false });

        expect(html).toContain('counting coverage over the diff');
        expect(html).not.toContain('explained');
        expect(html).not.toContain('coverage__segment');
        // The "Other" slot stays in place: the numbering denominator does not jump during parsing.
        expect(order(html)).toContain('other');
        expect(html).toContain('01 / 7');
    });

    it('cannot mark a stop viewed until its ranges are counted', () => {
        const pending = render({ parsed: false });
        const marked = render({ parsed: false, stopViewed: ['s01'] });

        expect(count(pending, 'class="viewed-toggle route-stop__viewed" aria-pressed="false" disabled=""')).toBe(7);
        // Clearing a mark needs no ranges, so an already marked stop stays clickable.
        expect(section(marked, 's01')).toContain('aria-pressed="true"');
        expect(section(marked, 's01')).not.toContain('disabled=""');
        expect(render()).not.toContain('route-stop__viewed" aria-pressed="false" disabled');
    });

    it('the stop counter counts actual marks', () => {
        const html = render({ stopViewed: ['s01', 'other'] });

        expect(html).toContain('2 of 7 stops viewed');
    });

    it('Other is a stop too and has its own viewed mark', () => {
        const html = section(render({ stopViewed: ['other'] }), 'other');

        expect(html).toContain('</span>Viewed</button>');
        expect(html).toContain('aria-pressed="true"');
    });

    it('file chips show stop counts and a read indicator box', () => {
        const html = render();

        expect(html).toContain('route-chip__read');
        expect(html).toContain('edit-window.ts');
        expect(html).toContain('Go to this file in the stop’s diff');
    });

    it('a digest stop renders assertions instead of test code', () => {
        const stop = section(render(), 's04');

        expect(stop).toContain('Behavioural digest · 12 assertions');
        expect(stop).toContain(DIGEST_NOTE);
        expect(stop).toContain('Show the test code');
        // 10 list rows plus 2 footer rows. Chips for all four categories are present.
        expect(count(stop, 'class="digest__row')).toBe(12);
        expect(count(stop, 'digest__chip--new')).toBe(6);
        expect(count(stop, 'digest__chip--changed')).toBe(2);
        expect(count(stop, 'digest__chip--weakened')).toBe(2);
        expect(count(stop, 'digest__chip--uncovered')).toBe(2);
        expect(stop).toContain('After 30 minutes and one millisecond, the window is closed.');
        expect(stop).toContain('edit-window.test.ts:17');
    });

    it('moves uncovered assertions to the footer with their note and counts dropped assertions separately', () => {
        const stop = section(render(), 's04');
        const footer = stop.slice(stop.indexOf('digest__footer'));

        expect(stop).toContain(UNCOVERED_NOTE);
        // Both footer rows are inside the footer, not in the main list.
        expect(count(footer, 'digest__chip--uncovered')).toBe(2);
        expect(stop).toContain('2 assertions dropped — the anchor found no test');
        // The validator note keeps its own row in the left column. The counter does not duplicate it.
        expect(stop).toContain('2 claims dropped: the anchor pointed at');
    });

    it('an anchor without a route target explains why it cannot be clicked', () => {
        const stop = section(render(), 's04');

        // Stop 01 explains `edit-window.ts:92`, so the link is live.
        expect(stop).toContain('edit-window.ts:92');
        expect(stop).not.toContain('digest__anchor--off');
        // The second uncovered assertion has no anchor at all, so its row has no link.
        expect(stop).toContain('PAN masking in the reauthorize log');
    });

    it('hides test code by default and expands it with the toggle', () => {
        const hidden = section(render(), 's04');
        const shown = section(render({ stops: { ...EMPTY_STOPS, testCode: new Set(['s04']) } }), 's04');

        expect(hidden).not.toContain('file-card');
        expect(hidden).not.toContain('diff-rows');
        expect(shown).toContain('file-card');
        expect(shown).toContain('diff-rows');
        expect(shown).toContain('Hide the test code');
        // The note about hidden test code is absent when the code is expanded.
        expect(shown).not.toContain(DIGEST_NOTE);
    });

    it('an empty intersection shows a test code link instead of a toggle and an incorrect note', () => {
        const stop = section(
            render({
                snapshot: digestOutsideStopSnapshot(),
                stops: { ...EMPTY_STOPS, testCode: new Set(['s04']) },
            }),
            's04',
        );

        expect(stop).not.toContain('Show the test code');
        expect(stop).not.toContain('Hide the test code');
        expect(stop).not.toContain(DIGEST_NOTE);
        expect(stop).toContain('class="digest__anchor digest__location"');
        expect(stop).toContain('test code — in stop 01</button>');
        // The s04 files do not match assertion files, so no cards are hidden.
        expect(stop).toContain('file-card');
    });

    it('global diff mode applies to expanded test code too (SPEC §2.6)', () => {
        const unified = section(render({ stops: { ...EMPTY_STOPS, testCode: new Set(['s04']) } }), 's04');
        const split = section(
            render({ mode: 'split', stops: { ...EMPTY_STOPS, testCode: new Set(['s04']) } }),
            's04',
        );

        expect(unified).not.toContain('diff-rows--split');
        expect(split).toContain('diff-rows--split');
    });

    it('the test code toggle leaves progress untouched and lives only in the session', () => {
        const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const writes: string[] = [];
        const onSetStopViewed = (stopId: string): Promise<number> => {
            writes.push(stopId);
            return Promise.resolve(0);
        };

        render({ session, onSetStopViewed });
        session.setStopTestCode('s04', true);
        const shown = render({ session, onSetStopViewed });

        expect(writes).toEqual([]);
        expect(session.getSnapshot().stops.testCode).toEqual(new Set(['s04']));
        expect(section(shown, 's04')).toContain('Hide the test code');
    });

    it('the digest stop viewed mark is independent of the toggle', () => {
        const hidden = section(render({ stopViewed: ['s04'] }), 's04');
        const shown = section(
            render({ stopViewed: ['s04'], stops: { ...EMPTY_STOPS, testCode: new Set(['s04']) } }),
            's04',
        );

        // A viewed stop summary includes assertions as well as files and lines.
        expect(hidden).toContain('12 assertions · 3 files · 172 lines · viewed');
        expect(shown).toContain('12 assertions · 3 files · 172 lines · viewed');
        expect(hidden).toContain('</span>Viewed</button>');
        expect(shown).toContain('</span>Viewed</button>');
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
