import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, UiFileProgress } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { ReadOnlyIterationProvider } from '../../iterations/read-only.tsx';
import type { RoutePreset, SessionStore, StopsState } from '../../session/session-store.js';
import { createSessionStore, EMPTY_STOPS } from '../../session/session-store.js';
import type { ThreadStore } from '../../threads/store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteWorkspace } from './route-workspace.tsx';
import { createT } from '../../i18n/index.js';
import { TOUR_HINT, TRIAGE_HINT } from './route-toolbar.tsx';
import { DIGEST_NOTE, UNCOVERED_NOTE } from './test-digest.tsx';

const t = createT('en');

/**
 * Route view component tests use static markup on a fixture (the same approach as
 * the action panel). They check what the reviewer sees: stop order, folds,
 * Other copy and edge cases from docs/design/SPEC-elements.md §2.9.
 */

const DATA = fixtureIteration('medium');
const READY = routeFixtures('medium')?.states.ready ?? null;
if (READY?.snapshot == null) {
    throw new Error('medium fixture needs a ready route snapshot');
}
const SNAPSHOT: RouteSnapshot = READY.snapshot;
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const ORDER_FILE = DATA.diff.files.find((file) => file.path === 'services/orders/src/domain/order.ts');
const GENERATED_FILE = DATA.diff.files.find((file) => file.path === 'pnpm-lock.yaml');
if (ORDER_FILE === undefined || GENERATED_FILE === undefined) {
    throw new Error('the medium fixture needs order.ts and pnpm-lock.yaml');
}

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
        /** Global diff mode (docs/design/SPEC-elements.md §2.6) also applies to route cards. */
        mode?: 'unified' | 'split';
        progress?: readonly UiFileProgress[];
        collapsed?: ReadonlyMap<string, boolean>;
        onSetStopViewed?: (stopId: string, viewed: boolean) => Promise<number>;
        onFillStop?: (planIndex: number) => void;
        /** The tab shows a previous iteration, so route writes are unavailable. */
        readOnly?: boolean;
        /** Files marked as conflicted by the host (docs/design/SPEC-elements.md §4.1). They are outside route coverage. */
        conflicts?: readonly string[];
    } = {},
): string {
    const conflicts = new Set(options.conflicts ?? []);
    const files = DATA.diff.files.map((file) =>
        conflicts.has(file.fileId) ? { ...file, changeType: 'conflict' as const } : file,
    );
    const store = createDiffViewStore({
        files,
        ...(options.progress === undefined ? {} : { progress: options.progress }),
        ...(options.collapsed === undefined ? {} : { collapsed: options.collapsed }),
    });
    if (options.mode !== undefined) {
        store.setDiffMode(options.mode);
    }
    if (options.parsed !== false) {
        for (const file of files) {
            store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
    }
    return renderToStaticMarkup(
        <ReadOnlyIterationProvider readOnly={options.readOnly ?? false}>
        <RouteWorkspace
            pr={DATA.pr}
            diff={{ ...DATA.diff, files }}
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
            onSetViewed={() => Promise.resolve(0)}
            onSetStopViewed={options.onSetStopViewed ?? (() => Promise.resolve(0))}
            onSetStopFileViewed={() => Promise.resolve(0)}
            {...(options.onFillStop === undefined ? {} : { onFillStop: options.onFillStop })}
        />
        </ReadOnlyIterationProvider>,
    );
}

/**
 * Path tooltips from file chips only. The same path is in the tooltip of the file card on the right,
 * so searching for a `title="…"` substring alone would check the wrong element.
 */
function chipPathTitles(html: string): string[] {
    return [...html.matchAll(/<span\b[^>]*\bclass="route-chip__path"[^>]*>/g)]
        .map((tag) => /\btitle="([^"]*)"/.exec(tag[0])?.[1])
        .filter((title): title is string => title !== undefined);
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
        expect(html).toContain('Open 38 lines');
    });

    it('tour step 02 targets the first rendered fold, not the first low stop', () => {
        expect(render()).toContain('data-tour="fold-s05"');

        // The first low stop is not filled yet. It has a skeleton, so there is nothing to outline.
        const queued = render({
            snapshot: {
                ...SNAPSHOT,
                stops: SNAPSHOT.stops.map((stop) =>
                    stop.id === 's05' ? { ...stop, status: 'queued' as const } : stop,
                ),
            },
        });

        expect(queued).not.toContain('data-tour="fold-s05"');
        expect(queued).toContain('data-tour="fold-s06"');
    });

    it('the preset switch shows the active option and its tooltip', () => {
        const triage = render();
        const tour = render({ preset: 'tour' });

        expect(triage).toContain(t(TRIAGE_HINT));
        expect(triage).not.toContain(t(TOUR_HINT));
        expect(triage).toContain('aria-pressed="true">Triage</button>');
        expect(triage).toContain('aria-pressed="false">Full tour</button>');
        expect(tour).toContain(t(TOUR_HINT));
        expect(tour).not.toContain(t(TRIAGE_HINT));
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
            expect(section(html, 's03')).toContain('>Viewed</button>');
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

    it('the header shows a snapshot indicator with a short commit hash and status', () => {
        const html = render();

        // Without the picker from App, the workspace shows its own snapshot as current.
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
        expect(html).toContain('>Viewed</button>');
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

    it('anchors in a conflicted file show a conflict notice instead of a drift notice (docs/design/SPEC-elements.md §4.1)', () => {
        const target = SNAPSHOT.stops.find((stop) => stop.id === 's01');
        if (target === undefined) {
            throw new Error('the fixture needs stop s01');
        }
        const html = render({ conflicts: target.anchors.map((anchor) => anchor.fileId) });
        const stop = section(html, 's01');

        expect(stop).toContain('route-conflicts');
        expect(stop).toContain('в конфликте: разрешите их в хосте');
        expect(stop).not.toContain('no longer in the diff');
        // Name the anchor paths so the reviewer knows what needs resolving.
        expect(stop).toContain(target.anchors[0]?.path ?? '');
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

        expect(all).toContain('Open 38 lines');
        expect(filtered).toContain('Open 15 lines');
        expect(filtered).not.toContain('Open 38 lines');
    });

    it('Other kept visible by the filter shows all its uncovered ranges', () => {
        const html = render({ filter: 'pci', keptStopId: 'other' });

        expect(html).toContain('Open 38 lines');
        expect(section(html, 'other')).toContain('kept in view — outside the current filter');
    });

    it('an unfilled stop offers filling only when available', () => {
        const snapshot = withStops((stops) =>
            stops.stops.map((stop) =>
                stop.id === 's01' ? { ...stop, status: 'failed', paragraph: null, bridge: null } : stop,
            ),
        );
        const fillingSnapshot = {
            ...snapshot,
            stops: snapshot.stops.map((stop) => (stop.id === 's02' ? { ...stop, status: 'queued' as const } : stop)),
        };
        const available = section(render({ snapshot, onFillStop: () => undefined }), 's01');
        const unavailable = section(render({ snapshot }), 's01');
        const whileFilling = section(render({ snapshot: fillingSnapshot, onFillStop: () => undefined }), 's01');

        expect(available).toContain('Not filled — the agent stopped early');
        expect(available).toContain('route-stop__regenerate">Fill this stop</button>');
        expect(unavailable).not.toContain('route-stop__regenerate');
        expect(whileFilling).not.toContain('route-stop__regenerate');

        // Filling writes to the tab snapshot. In a previous iteration the button is visible but disabled.
        const reading = section(render({ snapshot, onFillStop: () => undefined, readOnly: true }), 's01');
        expect(reading).toMatch(
            /<button [^>]*class="[^"]*route-stop__regenerate"[^>]*disabled=""[^>]*>Fill this stop<\/button>/,
        );
        expect(reading).toContain('only in the active iteration');
    });

    it('the validator note appears only on an unfilled stop', () => {
        const note = 'The stop was left unfilled: the agent gave no reason';
        const failed = withStops((snapshot) =>
            snapshot.stops.map((stop) =>
                stop.id === 's01'
                    ? {
                          ...stop,
                          status: 'failed' as const,
                          paragraph: null,
                          bridge: null,
                          validationNotes: [note],
                      }
                    : stop,
            ),
        );
        const ready = withStops((snapshot) =>
            snapshot.stops.map((stop) => (stop.id === 's01' ? { ...stop, validationNotes: [note] } : stop)),
        );

        // The note is the only explanation in an empty slot. A filled slot needs that space more.
        expect(section(render({ snapshot: failed }), 's01')).toContain(note);
        expect(section(render({ snapshot: ready }), 's01')).not.toContain(note);
    });

    it('a stop without anchors shows a dashed card instead of an empty space', () => {
        const html = render({
            snapshot: withStops((snapshot) =>
                snapshot.stops.map((stop) => (stop.id === 's02' ? { ...stop, anchors: [] } : stop)),
            ),
        });

        expect(html).toContain('No hunks: filling marked up no ranges at all.');
    });

    it('Other moves above low stops when more than 40% is uncovered', () => {
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

        expect(html).toContain('866 changed lines');
        expect(html).toContain('95% explained');
        expect(html).toContain('38 lines not explained');
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

        expect(count(pending, 'class="viewed-toggle ctl ctl--toggle route-stop__viewed" aria-pressed="false" disabled=""')).toBe(7);
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

        expect(html).toContain('>Viewed</button>');
        expect(html).toContain('aria-pressed="true"');
    });

    it('file chips show stop counts and a read indicator box', () => {
        const html = render();

        expect(html).toContain('route-chip__read');
        expect(html).toContain('edit-window.ts');
        expect(html).toContain('Go to this file in the stop’s diff');
        // The path is truncated on the left, so only the tooltip has the full path (docs/design/SPEC-elements.md §1.2).
        expect(chipPathTitles(html)).toContain('services/orders/src/domain/edit-window.ts');
        // The name and path container makes room for counters, not a spacer.
        expect(html).toContain('route-chip__file');
        expect(html).not.toContain('route-chip__spacer');
    });

    it('a digest stop renders assertions instead of test code', () => {
        const stop = section(render(), 's04');

        expect(stop).toContain('Behavioural digest · 12 assertions');
        expect(stop).toContain(t(DIGEST_NOTE));
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

        expect(stop).toContain(t(UNCOVERED_NOTE));
        // Both footer rows are inside the footer, not in the main list.
        expect(count(footer, 'digest__chip--uncovered')).toBe(2);
        expect(stop).toContain('2 assertions dropped — the anchor found no test');
        // The footer count is the only mention. A filled stop does not render the validator note.
        expect(stop).not.toContain('Two assertions dropped: the anchor led to');
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
        expect(shown).not.toContain(t(DIGEST_NOTE));
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
        expect(stop).not.toContain(t(DIGEST_NOTE));
        expect(stop).toContain('digest__anchor digest__location"');
        expect(stop).toContain('test code — in stop 01</button>');
        // The s04 files do not match assertion files, so no cards are hidden.
        expect(stop).toContain('file-card');
    });

    it('the global diff mode also applies to expanded test code (docs/design/SPEC-elements.md §2.6)', () => {
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
        expect(hidden).toContain('>Viewed</button>');
        expect(shown).toContain('>Viewed</button>');
    });

    it('a viewed file collapses inside its stop', () => {
        const html = section(
            render({ progress: [{ fileId: ORDER_FILE.fileId, viewed: true, seenRanges: [] }] }),
            's02',
        );

        expect(html).toContain('order.ts');
        expect(html).toContain('file-card__collapsed--file');
        expect(html).toContain('· viewed');
    });

    it('the generated file summary counts the slice and hides the separate collapsed-anchor button', () => {
        const stops = { ...EMPTY_STOPS, expanded: new Set(['s06']) };
        const collapsed = section(render({ stops }), 's06');
        const expanded = section(
            render({ stops, collapsed: new Map([[GENERATED_FILE.fileId, false]]) }),
            's06',
        );

        expect(collapsed).toContain('+217');
        expect(collapsed).toContain('−9');
        expect(collapsed).toContain('· generated file');
        expect(collapsed).not.toContain('route-stop__collapsed-lines');
        expect(expanded).toContain('route-stop__collapsed-lines');
        expect(expanded).toContain('226 changed lines collapsed by the model');
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
