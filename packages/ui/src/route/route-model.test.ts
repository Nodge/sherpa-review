import { fixtureData, routeFixtures } from '@sherpa/fixtures';
import type { FileDiff, RouteSnapshot, RouteStop } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import type { RouteFileGroup } from './route-model.js';
import {
    buildRouteModel,
    composersForGroup,
    countStopComments,
    filterOtherView,
    lazyCards,
    LAZY_HUNK_THRESHOLD,
    PROMOTE_THRESHOLD,
    stopMatchesFilter,
    threadsForGroup,
} from './route-model.js';

/**
 * Route counts come from anchors and diff models, not the snapshot. The reference is
 * the `medium` fixture, whose coverage matches the handoff strip (862 / 828 / 34, tiers
 * 196 / 327 / 305). This test catches any difference in the counts.
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

function build(snapshot: RouteSnapshot = SNAPSHOT, files: readonly FileDiff[] = DATA.diff.files) {
    return buildRouteModel({ snapshot, files, models: MODELS });
}

function stopFiles(id: string): readonly RouteFileGroup[] {
    return build().entries.flatMap((entry) =>
        entry.kind === 'stop' && entry.view.stop.id === id ? entry.view.files : [],
    );
}

function stopOf(id: string): RouteStop {
    const stop = SNAPSHOT.stops.find((candidate) => candidate.id === id);
    if (stop === undefined) {
        throw new Error(`fixture snapshot has no stop ${id}`);
    }
    return stop;
}

describe('route model', () => {
    it('coverage matches the handoff strip: 862 changed, 828 explained, 34 unexplained', () => {
        const { totals } = build();

        expect(totals.changed).toBe(862);
        expect(totals.covered).toBe(828);
        expect(totals.uncovered).toBe(34);
        expect(totals.pendingFiles).toBe(0);
        expect(totals.covered + totals.uncovered).toBe(totals.changed);
    });

    it('matches fixture line counts by tier', () => {
        const { totals } = build();

        expect(totals.byTier).toEqual({ high: 196, medium: 327, low: 305, other: 34 });
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
            ['psp-schema.ts', 17],
            ['CODEOWNERS', 5],
            ['ci.yml', 12],
        ]);
        expect(other.view.lines).toBe(34);
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
        // Parsing failed: the file will not finish counting on its own, so there is nothing left to wait for.
        expect(stopsOf(new Set([first.fileId])).every((view) => !view.pending)).toBe(true);
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
