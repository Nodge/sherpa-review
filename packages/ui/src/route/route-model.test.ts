import { fixtureData, routeFixtures } from '@sherpa/fixtures';
import type { AgentNote, ChatAnchor, FileDiff, RouteSnapshot, RouteStop, UiStopSeenRange } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import type { FileReadState } from '../progress/read-state.js';
import { changedLinesOf, readStateOf } from '../progress/read-state.js';
import type { RouteFileGroup, RouteModel, RouteTotals } from './route-model.js';
import {
    buildRouteModel,
    changeFilterAvailable,
    composersForGroup,
    countStopComments,
    entryMatchesChangeFilter,
    entryParseFailed,
    filterOtherView,
    lazyCards,
    LAZY_HUNK_THRESHOLD,
    notesForGroup,
    PROMOTE_THRESHOLD,
    stopMatchesFilter,
    stopSeenRanges,
    threadsForGroup,
} from './route-model.js';

/**
 * Route counts come from anchors and diff models, not the snapshot. The reference is
 * the `medium` fixture, whose coverage matches the handoff bar (860 / 828 / 32, tiers
 * 196 / 327 / 305). This test catches any mismatch. The patches contain
 * 862. The 2 empty lines in psp-schema.ts outside anchors are excluded from coverage counts
 * (decision log, 2026-08-26).
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

const EMPTY_TOTALS: RouteTotals = {
    changed: 0,
    covered: 0,
    uncovered: 0,
    byTier: { high: 0, medium: 0, low: 0, other: 0 },
    pendingFiles: 0,
    failedFiles: 0,
};

function build(snapshot: RouteSnapshot = SNAPSHOT, files: readonly FileDiff[] = DATA.diff.files) {
    return buildRouteModel({ snapshot, files, models: MODELS });
}

function stopFiles(id: string): readonly RouteFileGroup[] {
    return build().entries.flatMap((entry) =>
        entry.kind === 'stop' && entry.view.stop.id === id ? entry.view.files : [],
    );
}

/** Order and numbers of model entries, as the reviewer sees them in the stop column. */
function ids(model: ReturnType<typeof build>): string[] {
    return model.entries.map((entry) => entry.view.stop.id);
}

function numbers(model: ReturnType<typeof build>): string[] {
    return model.entries.map((entry) => entry.view.planLabel);
}

/** Anchors for low-tier stops and composite 03 are trimmed: uncovered lines exceed the promotion threshold (SPEC §4.3). */
function strippedAnchors(): RouteSnapshot {
    return {
        ...SNAPSHOT,
        stops: SNAPSHOT.stops.map((stop) =>
            stop.tier === 'low' || stop.id === 's03' ? { ...stop, anchors: [] } : stop,
        ),
    };
}

function stopOf(id: string): RouteStop {
    const stop = SNAPSHOT.stops.find((candidate) => candidate.id === id);
    if (stop === undefined) {
        throw new Error(`fixture snapshot has no stop ${id}`);
    }
    return stop;
}

describe('route model', () => {
    it('coverage matches the handoff bar: 860 changed, 828 explained, 32 not explained', () => {
        const { totals } = build();

        expect(totals.changed).toBe(860);
        expect(totals.covered).toBe(828);
        expect(totals.uncovered).toBe(32);
        expect(totals.pendingFiles).toBe(0);
        expect(totals.covered + totals.uncovered).toBe(totals.changed);
    });

    it('matches fixture line counts by tier', () => {
        const { totals } = build();

        expect(totals.byTier).toEqual({ high: 196, medium: 327, low: 305, other: 32 });
        expect(totals.byTier.high + totals.byTier.medium + totals.byTier.low).toBe(totals.covered);
    });

    it('uncovered lines are in exactly three fixture files', () => {
        const model = build();
        const other = model.entries.find((entry) => entry.kind === 'other');

        expect(other?.kind).toBe('other');
        if (other?.kind !== 'other') {
            return;
        }
        // Use diff file order rather than anchor order. Other follows document order.
        expect(other.view.files.map((file) => [file.name, file.lines])).toEqual([
            // 15, not 17: Other excludes two empty lines at the end of psp-schema.ts.
            ['psp-schema.ts', 15],
            ['CODEOWNERS', 5],
            ['ci.yml', 12],
        ]);
        expect(other.view.lines).toBe(32);
    });

    it('renders in snapshot Triage order with Other last and numbers fixed by the plan', () => {
        const model = build();

        expect(model.promoted).toBe(false);
        expect(model.stopCount).toBe(7);
        expect(
            model.entries.map((entry) => (entry.kind === 'stop' ? entry.view.stop.id : 'other')),
        ).toEqual(['s01', 's02', 's03', 's04', 's05', 's06', 'other']);
        expect(model.entries.map((entry) => entry.view.planLabel)).toEqual([
            '01',
            '02',
            '03',
            '04',
            '05',
            '06',
            '07',
        ]);
    });

    it('uses snapshot tourOrder for Full tour and keeps numbers fixed by the plan', () => {
        const tour = buildRouteModel({ snapshot: SNAPSHOT, files: DATA.diff.files, models: MODELS, preset: 'tour' });

        expect(ids(tour)).toEqual([...SNAPSHOT.tourOrder]);
        // Numbers follow their stops. The first tour card is numbered 03, not 01.
        expect(numbers(tour)).toEqual(['03', '01', '02', '05', '06', '04', '07']);
        // The set is the same as in Triage. Only the card order changes.
        expect([...ids(tour)].sort()).toEqual([...ids(build())].sort());
        expect([...numbers(tour)].sort()).toEqual([...numbers(build())].sort());
        expect(tour.stopCount).toBe(7);
    });

    it('tour order strictly follows tourOrder: promoting Other is a triage feature', () => {
        const stripped = strippedAnchors();
        const triage = build(stripped);
        const tour = buildRouteModel({ snapshot: stripped, files: DATA.diff.files, models: MODELS, preset: 'tour' });

        expect(triage.promoted).toBe(true);
        // The flag is shared and shows the "consider regenerating" banner. The order is not shared.
        expect(tour.promoted).toBe(true);
        expect(ids(tour)).toEqual([...SNAPSHOT.tourOrder]);
    });

    it('handles invalid tourOrder by skipping unknown ids and appending omitted stops', () => {
        const broken: RouteSnapshot = { ...SNAPSHOT, tourOrder: ['s03', 'made-up-stop', 's03', 's01', 'other'] };
        const tour = buildRouteModel({ snapshot: broken, files: DATA.diff.files, models: MODELS, preset: 'tour' });

        expect(ids(tour)).toEqual(['s03', 's01', 'other', 's02', 's04', 's05', 's06']);
        expect(tour.stopCount).toBe(7);
    });

    it('places Other before the first low-tier stop above the uncovered threshold without renumbering', () => {
        // Trim low-tier anchors to push uncovered lines above the threshold without changing the plan.
        const stripped: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.map((stop) =>
                stop.tier === 'low' || stop.id === 's03' ? { ...stop, anchors: [] } : stop,
            ),
        };
        const model = build(stripped);

        expect(model.totals.uncovered / model.totals.changed).toBeGreaterThan(PROMOTE_THRESHOLD);
        expect(model.promoted).toBe(true);
        expect(
            model.entries.map((entry) => (entry.kind === 'stop' ? entry.view.stop.id : 'other')),
        ).toEqual(['s01', 's02', 's03', 's04', 'other', 's05', 's06']);
        const other = model.entries.find((entry) => entry.kind === 'other');
        expect(other?.view.planLabel).toBe('07');
    });

    it('has no Other when there are zero uncovered lines (SPEC §4.3)', () => {
        // One synthetic stop covers the whole diff, leaving nothing uncovered.
        const everything: RouteSnapshot = {
            ...SNAPSHOT,
            stops: [
                {
                    ...stopOf('s01'),
                    anchors: DATA.diff.files.flatMap((file) => [
                        { fileId: file.fileId, path: file.path, side: 'old' as const, start: 1, end: 100_000, collapsed: false },
                        { fileId: file.fileId, path: file.path, side: 'new' as const, start: 1, end: 100_000, collapsed: false },
                    ]),
                },
                stopOf('other'),
            ],
        };
        const model = build(everything);

        expect(model.totals.uncovered).toBe(0);
        expect(model.entries.every((entry) => entry.kind === 'stop')).toBe(true);
        // The "01 / N" denominator, toolbar counter and guardrail count the same set of slots.
        expect(model.stopCount).toBe(model.entries.length);
        expect(model.stopCount).toBe(everything.stops.length - 1);
    });

    it('keeps Other as a slot while parsing the diff: numbers do not jump from 6 to 7', () => {
        const model = buildRouteModel({ snapshot: SNAPSHOT, files: DATA.diff.files, models: new Map() });
        const other = model.entries.find((entry) => entry.kind === 'other');

        expect(model.totals.uncovered).toBe(0);
        expect(other?.kind).toBe('other');
        expect(model.stopCount).toBe(7);
        expect(model.entries).toHaveLength(7);
    });

    it('does not keep a stop pending when a file fails to parse', () => {
        const first = DATA.diff.files[0];
        if (first === undefined) {
            throw new Error('fixture needs at least one file');
        }
        const withoutFirst = new Map(MODELS);
        withoutFirst.delete(first.fileId);
        const stopsOf = (failed: ReadonlySet<string>) =>
            buildRouteModel({
                snapshot: SNAPSHOT,
                files: DATA.diff.files,
                models: withoutFirst,
                failed,
            }).entries.flatMap((entry) =>
                entry.kind === 'stop' && entry.view.files.some((group) => group.fileId === first.fileId)
                    ? [entry.view]
                    : [],
            );

        expect(stopsOf(new Set()).some((view) => view.pending)).toBe(true);
        expect(stopsOf(new Set()).every((view) => !view.parseFailed)).toBe(true);
        // Parsing failed. The file will not finish counting on its own, so there is nothing left to wait for,
        // but the stop cannot be marked viewed either. The file will have no ranges until parsing is retried.
        expect(stopsOf(new Set([first.fileId])).every((view) => !view.pending)).toBe(true);
        expect(stopsOf(new Set([first.fileId])).every((view) => view.parseFailed)).toBe(true);
    });

    it('does not count a file that failed to parse as fully read through the seen ranges of a stop', () => {
        const first = DATA.diff.files[0];
        if (first === undefined) {
            throw new Error('fixture needs at least one file');
        }
        const withoutFirst = new Map(MODELS);
        withoutFirst.delete(first.fileId);
        const entry = buildRouteModel({
            snapshot: SNAPSHOT,
            files: DATA.diff.files,
            models: withoutFirst,
            failed: new Set([first.fileId]),
        }).entries.find(
            (candidate) =>
                candidate.kind === 'stop' && candidate.view.files.some((group) => group.fileId === first.fileId),
        );
        if (entry === undefined) {
            throw new Error('file must first belong to a stop');
        }

        // This is the gap the flag exists to catch: the set would silently arrive without this file.
        expect(stopSeenRanges(entry).some((range) => range.fileId === first.fileId)).toBe(false);
        expect(entryParseFailed(entry, { ...EMPTY_TOTALS, failedFiles: 1 })).toBe(true);
    });

    it('marks unresolved anchors as drift and a stop without anchors as an empty slot', () => {
        const drifted: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.map((stop) => {
                if (stop.id === 's01') {
                    return {
                        ...stop,
                        anchors: stop.anchors.map((anchor) => ({ ...anchor, fileId: 'removed-file' })),
                    };
                }
                return stop.id === 's02' ? { ...stop, anchors: [] } : stop;
            }),
        };
        const model = build(drifted);
        const stops = model.entries.flatMap((entry) => (entry.kind === 'stop' ? [entry.view] : []));

        expect(stops[0]?.drift).toBe(true);
        expect(stops[0]?.unresolvedPaths.length).toBeGreaterThan(0);
        expect(stops[0]?.empty).toBe(false);
        expect(stops[1]?.drift).toBe(false);
        expect(stops[1]?.empty).toBe(true);
    });

    it('gives stop files their own counters and collapse directive', () => {
        const model = build();
        const lock = model.entries.flatMap((entry) =>
            entry.kind === 'stop' && entry.view.stop.id === 's06' ? entry.view.files : [],
        );

        expect(lock).toHaveLength(1);
        expect(lock[0]?.name).toBe('pnpm-lock.yaml');
        expect(lock[0]?.anchors).toHaveLength(0);
        expect(lock[0]?.collapsedAnchors).toHaveLength(2);
        expect(lock[0]?.collapsedLines).toBe((lock[0]?.additions ?? 0) + (lock[0]?.deletions ?? 0));
        expect(lock[0]?.whole).toBe(true);
    });

    it('marks counts as incomplete without parsed models', () => {
        const model = buildRouteModel({ snapshot: SNAPSHOT, files: DATA.diff.files, models: new Map() });

        expect(model.totals.pendingFiles).toBe(DATA.diff.files.length);
        // Patch counts still include whitespace lines, which are only identifiable in parsed models,
        // still 862, including them. Counts are marked unfinished while `pendingFiles` is above zero.
        expect(model.totals.changed).toBe(862);
        expect(model.totals.covered).toBe(0);
        expect(model.totals.uncovered).toBe(0);
    });

    it('hides stops with no remaining files after file filtering', () => {
        const model = build();
        const stops = model.entries.flatMap((entry) => (entry.kind === 'stop' ? [entry.view] : []));
        const first = stops[0];
        if (first === undefined) {
            throw new Error('model must contain at least one stop');
        }
        const onlyFirst = new Set(first.files.map((file) => file.fileId));

        expect(stopMatchesFilter(first, onlyFirst)).toBe(true);
        expect(stopMatchesFilter(first, null)).toBe(true);
        expect(stops.filter((stop) => stopMatchesFilter(stop, onlyFirst))).toEqual([first]);
    });

    it('keeps only classified stops and hides Other under the "what is new" filter', () => {
        const snapshot: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.map((stop) =>
                stop.id === 's02'
                    ? { ...stop, change: { kind: 'changed', reason: null, threadIds: [] } }
                    : stop.id === 's06'
                      ? { ...stop, change: { kind: 'new', reason: null, threadIds: [] } }
                      : stop,
            ),
        };
        const model = buildRouteModel({ snapshot, files: DATA.diff.files, models: new Map() });
        const shown = model.entries.filter((entry) => entryMatchesChangeFilter(entry, true));

        expect(changeFilterAvailable(model.entries)).toBe(true);
        expect(shown.map((entry) => entry.view.stop.id)).toEqual(['s02', 's06']);
        // Numbers are fixed by the plan. The denominator uses the full set of entries.
        expect(model.stopCount).toBe(model.entries.length);
        expect(shown.map((entry) => entry.view.planLabel)).toEqual(['02', '06']);
    });

    it('disables the "what is new" filter when there are no classified stops', () => {
        const model = build();

        expect(changeFilterAvailable(model.entries)).toBe(false);
        expect(model.entries.filter((entry) => entryMatchesChangeFilter(entry, false))).toEqual(model.entries);
    });

    it('keeps surviving files and shows a notice when some anchors have moved', () => {
        const target = stopFiles('s03')[0];
        if (target === undefined) {
            throw new Error('stop s03 must have files');
        }
        const partial: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.map((stop) =>
                stop.id === 's03'
                    ? {
                          ...stop,
                          anchors: stop.anchors.map((anchor) =>
                              anchor.fileId === target.fileId ? { ...anchor, fileId: 'removed-file' } : anchor,
                          ),
                      }
                    : stop,
            ),
        };
        const view = build(partial).entries.flatMap((entry) =>
            entry.kind === 'stop' && entry.view.stop.id === 's03' ? [entry.view] : [],
        )[0];

        expect(view?.drift).toBe(false);
        expect(view?.unresolvedPaths).toEqual([target.path]);
        expect(view?.files.map((file) => file.fileId)).not.toContain(target.fileId);
    });

    it('marks an anchor in an existing file outside changed lines as drift too', () => {
        const target = stopFiles('s03')[0];
        if (target === undefined) {
            throw new Error('stop s03 must have files');
        }
        const moved: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.map((stop) =>
                stop.id === 's03'
                    ? {
                          ...stop,
                          anchors: stop.anchors.map((anchor) =>
                              anchor.fileId === target.fileId
                                  ? { ...anchor, start: 900_000, end: 900_010 }
                                  : anchor,
                          ),
                      }
                    : stop,
            ),
        };
        const view = build(moved).entries.flatMap((entry) =>
            entry.kind === 'stop' && entry.view.stop.id === 's03' ? [entry.view] : [],
        )[0];

        expect(view?.unresolvedPaths).toEqual([target.path]);
        expect(view?.files.map((file) => file.fileId)).not.toContain(target.fileId);
    });

    it('assigns a context-line comment to the stop that renders the line', () => {
        const group = stopFiles('s01')[0];
        const anchor = group?.anchors[0];
        if (group === undefined || anchor === undefined) {
            throw new Error('stop s01 must have an anchor');
        }
        const at = (line: number) => ({
            ...DATA.threads[0],
            id: `thread-${String(line)}`,
            outdated: false,
            anchor: {
                fileId: group.fileId,
                path: group.path,
                position: { side: anchor.side, line, size: 1 },
            },
        }) as (typeof DATA.threads)[number];
        // The line directly below the range is rendered as context by the card, so its comment belongs there too.
        const context = at(anchor.end + 1);
        const far = at(anchor.end + 100);

        expect(threadsForGroup(group, new Map([[group.fileId, [context, far]]]))).toEqual([context]);
    });

    it('assigns a route note by the same range ownership rules as a thread', () => {
        const group = stopFiles('s01')[0];
        const anchor = group?.anchors[0];
        if (group === undefined || anchor === undefined) {
            throw new Error('stop s01 must have an anchor');
        }
        const at = (id: number, line: number): AgentNote => {
            const noteAnchor: ChatAnchor = {
                diffId: DATA.diff.diffId,
                fileId: group.fileId,
                path: group.path,
                side: anchor.side,
                start: line,
                end: line,
            };
            return {
                id,
                exchangeId: id,
                anchor: noteAnchor,
                text: 'Agent answer',
                lostAnchor: false,
                origin: { commit: 'abcdef1', anchor: noteAnchor },
                createdAt: '2026-09-01T10:00:00.000Z',
            };
        };
        const context = at(1, anchor.end + 1);
        const far = at(2, anchor.end + 100);

        expect(notesForGroup(group, new Map([[group.fileId, [context, far]]]))).toEqual([context]);
    });

    it('assigns context between two stops to one of them without duplicating the comment', () => {
        const file = DATA.diff.files[0];
        if (file === undefined) {
            throw new Error('fixture must have at least one file');
        }
        const spans = [
            { start: 10, end: 12 },
            { start: 16, end: 18 },
        ];
        const twins: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.slice(0, 2).map((stop, index) => ({
                ...stop,
                anchors: [
                    {
                        fileId: file.fileId,
                        path: file.path,
                        side: 'new' as const,
                        start: spans[index]?.start ?? 0,
                        end: spans[index]?.end ?? 0,
                        collapsed: false,
                    },
                ],
            })),
        };
        const groups = build(twins).entries.flatMap((entry) =>
            entry.kind === 'stop' ? entry.view.files : [],
        );
        // Lines 13–15 are context for both stops. The first stop in the plan takes them.
        const owners = [13, 14, 15].map(
            (line) => groups.filter((group) => group.contextLines.new.has(line)).length,
        );

        expect(owners).toEqual([1, 1, 1]);
    });

    it('assigns a comment draft to the same stops as a thread', () => {
        const group = stopFiles('s01')[0];
        const anchor = group?.anchors[0];
        if (group === undefined || anchor === undefined) {
            throw new Error('stop s01 must have an anchor');
        }
        const composer = (line: number) => ({
            key: `new:${group.fileId}:${anchor.side}:${String(line)}`,
            threadId: null,
            parentId: null,
            anchor: {
                fileId: group.fileId,
                path: group.path,
                position: { side: anchor.side, line, size: 1 },
            },
            text: '',
            commentId: null,
            status: 'idle' as const,
            saveUncertain: false,
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });
        const inside = composer(anchor.start);
        const outside = composer(100_000);

        expect(composersForGroup(group, new Map([[group.fileId, [inside, outside]]]))).toEqual([inside]);
    });

    it('does not keep counts incomplete forever after a parse failure', () => {
        const broken = DATA.diff.files[0];
        if (broken === undefined) {
            throw new Error('fixture must have at least one file');
        }
        const models = new Map(MODELS);
        models.delete(broken.fileId);
        const model = buildRouteModel({
            snapshot: SNAPSHOT,
            files: DATA.diff.files,
            models,
            failed: new Set([broken.fileId]),
        });

        expect(model.totals.pendingFiles).toBe(0);
        expect(model.totals.failedFiles).toBe(1);
    });

    it('counts exactly what Other expands to under a filter', () => {
        const other = build().entries.find((entry) => entry.kind === 'other');
        if (other?.kind !== 'other') {
            throw new Error('model must contain Other');
        }
        const first = other.view.files[0];
        if (first === undefined) {
            throw new Error('Other must contain files');
        }
        const filtered = filterOtherView(other.view, new Set([first.fileId]));

        expect(filtered.files).toEqual([first]);
        expect(filtered.lines).toBe(first.lines);
        expect(filterOtherView(other.view, null)).toBe(other.view);
    });

    it('splits lazy rendering of a stop by hunks rather than files', () => {
        const group = (hunks: number, fileId: string): RouteFileGroup =>
            ({ fileId, hunks }) as unknown as RouteFileGroup;
        const small = [group(3, 'a'), group(3, 'b'), group(3, 'c')];
        const big = [group(3, 'a'), group(3, 'b'), group(LAZY_HUNK_THRESHOLD, 'c')];

        // Below the hunk threshold, everything renders. There is nothing to split.
        expect(lazyCards(small)).toEqual(small);
        // Above the threshold, the first cards add up to five hunks. The rest wait for scrolling.
        expect(lazyCards(big).map((file) => file.fileId)).toEqual(['a', 'b']);
        expect(lazyCards([group(40, 'one'), group(1, 'two')]).map((file) => file.fileId)).toEqual(['one']);
    });

    it('counts threads whose positions are within the stop anchors', () => {
        const model = build();
        const stop = model.entries.flatMap((entry) =>
            entry.kind === 'stop' && entry.view.stop.id === 's03' ? [entry.view] : [],
        )[0];
        if (stop === undefined) {
            throw new Error('model must contain stop s03');
        }
        const group = stop.files[0];
        if (group === undefined) {
            throw new Error('stop s03 must have files');
        }
        const anchor = group.anchors[0];
        if (anchor === undefined) {
            throw new Error('stop file must have an anchor');
        }
        const inside = {
            ...DATA.threads[0],
            id: 'thread-inside',
            anchor: {
                fileId: group.fileId,
                path: group.path,
                position: { side: anchor.side, line: anchor.start, size: 1 },
            },
        } as (typeof DATA.threads)[number];
        const outside = {
            ...inside,
            id: 'thread-outside',
            anchor: {
                fileId: group.fileId,
                path: group.path,
                position: { side: anchor.side, line: 100_000, size: 1 },
            },
        };

        const byFile = new Map([[group.fileId, [inside, outside]]]);

        expect(countStopComments(stop, byFile)).toBe(1);
    });
});

/**
 * Whitespace line rule (decision log, 2026-08-26) on a synthetic diff: empty and
 * whitespace-only changed lines outside anchors are excluded from coverage statistics entirely, while lines
 * covered by an anchor are counted as before.
 *
 * `WHITESPACE_PATCH` diff: old 2 and new 2–3 (one empty) are under anchors. Outside anchors are
 * new 6 (`delta`), empty new 5 and a whitespace-only deletion on old 5.
 */
const WHITESPACE_PATCH = [
    '@@ -1,6 +1,8 @@',
    ' alpha',
    '-old-one',
    '+new-one',
    '+',
    ' beta',
    '+  ',
    '+delta',
    ' gamma',
    '-\t',
    ' omega',
    '',
].join('\n');

const WHITESPACE_FILE: FileDiff = {
    fileId: 'ws',
    path: 'src/ws.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    generated: false,
    additions: 4,
    deletions: 2,
    patch: WHITESPACE_PATCH,
    viewed: null,
    blameUrl: null,
};

/** Snapshot with one stop containing the given anchors, plus Other. */
function whitespaceSnapshot(anchors: readonly { side: 'old' | 'new'; start: number; end: number }[]): RouteSnapshot {
    return {
        ...SNAPSHOT,
        stops: [
            {
                ...stopOf('s01'),
                anchors: anchors.map((span) => ({
                    fileId: WHITESPACE_FILE.fileId,
                    path: WHITESPACE_FILE.path,
                    ...span,
                    collapsed: false,
                })),
            },
            stopOf('other'),
        ],
    };
}

function whitespaceModel(anchors: readonly { side: 'old' | 'new'; start: number; end: number }[]) {
    return buildRouteModel({
        snapshot: whitespaceSnapshot(anchors),
        files: [WHITESPACE_FILE],
        models: new Map([[WHITESPACE_FILE.fileId, parseFileDiff(toParseRequest(WHITESPACE_FILE))]]),
    });
}

describe('whitespace lines outside anchors', () => {
    it('excludes them from Other and keeps the denominator equal to covered plus uncovered lines', () => {
        const model = whitespaceModel([
            { side: 'old', start: 2, end: 2 },
            { side: 'new', start: 2, end: 3 },
        ]);
        const other = model.entries.find((entry) => entry.kind === 'other');

        // The patch has 6 changed lines. Two whitespace-only lines outside anchors are excluded from the count.
        expect(model.totals.changed).toBe(4);
        // Empty new 3 under an anchor counts like a text line. The rule applies only outside anchors.
        expect(model.totals.covered).toBe(3);
        expect(model.totals.uncovered).toBe(1);
        expect(model.totals.covered + model.totals.uncovered).toBe(model.totals.changed);
        if (other?.kind !== 'other') {
            throw new Error('model must contain Other');
        }
        // Other contains only `delta`, with neither empty new 5 nor the whitespace deletion on old 5.
        expect(other.view.files[0]?.anchors).toEqual([{ side: 'new', start: 6, end: 6 }]);
        expect(other.view.lines).toBe(1);
    });

    it('still includes them in viewed marks because reading progress counts patch lines', () => {
        const model = whitespaceModel([
            { side: 'old', start: 2, end: 2 },
            { side: 'new', start: 2, end: 3 },
        ]);
        const seen = model.entries.reduce(
            (total, entry) =>
                total + stopSeenRanges(entry).reduce((sum, range) => sum + (range.end - range.start + 1), 0),
            0,
        );

        expect(seen).toBe(WHITESPACE_FILE.additions + WHITESPACE_FILE.deletions);
    });

    it('hides Other entirely when only these lines remain uncovered', () => {
        const model = whitespaceModel(FULLY_COVERED);

        expect(model.totals.uncovered).toBe(0);
        expect(model.totals.changed).toBe(4);
        expect(model.totals.covered).toBe(4);
        expect(model.entries.every((entry) => entry.kind === 'stop')).toBe(true);
        expect(model.stopCount).toBe(1);
    });

    it('includes them in the file stop without Other so the route completes reading progress', () => {
        // There is no Other stop, and reading progress counts all 6 changed patch lines:
        // without whitespace ranges in seen, the file would remain `partial` forever.
        const model = whitespaceModel(FULLY_COVERED);
        const state = whitespaceReadState(model);

        expect(model.entries.every((entry) => entry.kind === 'stop')).toBe(true);
        expect(state.seen).toBe(WHITESPACE_FILE.additions + WHITESPACE_FILE.deletions);
        expect(state.state).toBe('read');
    });

    it('keeps a partly uncovered file partially read when marking one stop', () => {
        const model = whitespaceModel([
            { side: 'old', start: 2, end: 2 },
            { side: 'new', start: 2, end: 3 },
        ]);
        const stop = model.entries.find((entry) => entry.kind === 'stop');
        if (stop === undefined) {
            throw new Error('model must contain a stop');
        }

        // Other takes the whitespace lines. The stop is responsible only for its three lines.
        expect(readStateOfWhitespace(stopSeenRanges(stop))).toMatchObject({ state: 'partial', seen: 3 });
    });
});

/** Anchors covering all changed text lines in the file, leaving only whitespace uncovered. */
const FULLY_COVERED = [
    { side: 'old', start: 2, end: 2 },
    { side: 'new', start: 2, end: 3 },
    { side: 'new', start: 6, end: 6 },
] as const;

/** File progress with all route entries marked: their seen ranges are the entire read-state input. */
function whitespaceReadState(model: RouteModel): FileReadState {
    return readStateOfWhitespace(model.entries.flatMap((entry) => stopSeenRanges(entry)));
}

function readStateOfWhitespace(ranges: readonly UiStopSeenRange[]): FileReadState {
    const changed = changedLinesOf(parseFileDiff(toParseRequest(WHITESPACE_FILE)));
    if (changed === undefined) {
        throw new Error('synthetic patch must parse as text');
    }
    return readStateOf({
        file: WHITESPACE_FILE,
        record: {
            fileId: WHITESPACE_FILE.fileId,
            viewed: false,
            seenRanges: ranges.map(({ side, start, end }) => ({ side, start, end })),
        },
        changed,
    });
}
