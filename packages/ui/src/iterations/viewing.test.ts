import type { Iteration, RouteSnapshot, UiRouteStale, UiRouteState, UiSnapshotSummary } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import {
    fallbackSnapshots,
    parseViewing,
    pickerRows,
    resolveViewing,
    rowAction,
    sliceBetween,
    sliceMarks,
    VIEWING_CURRENT,
    viewingFragmentPatch,
} from './viewing.js';
import type { ViewingInput } from './viewing.js';

/**
 * Resolve the iteration selection: endpoint parameters, read-only mode,
 * and fallback behaviour when the server does not yet support the snapshots endpoint.
 */

const OLD_COMMIT = '9f3c1ab6d4e2705c8a1b3f9d6e4c2a08b7d5f316';
const NEW_COMMIT = 'a71d4e2c9b8f5301d6e4a2c7b09f8e3d5a4c6b21';

function summary(patch: Partial<UiSnapshotSummary> = {}): UiSnapshotSummary {
    return {
        snapshotId: 'route-old',
        diffId: '182800',
        commit: OLD_COMMIT,
        baseCommit: 'base',
        createdAt: '2026-08-31T06:00:00.000Z',
        provenance: { harness: 'claude-code', model: 'sonnet-5', locale: null },
        previousSnapshotId: null,
        status: 'stale',
        ...patch,
    };
}

const CURRENT = summary({ snapshotId: 'route-new', diffId: '182801', commit: NEW_COMMIT, status: 'current' });

function iteration(patch: Partial<Iteration> = {}): Iteration {
    return {
        diffId: '182801',
        baseCommit: 'base',
        headCommit: NEW_COMMIT,
        createdAt: '2026-08-31T09:00:00.000Z',
        status: 'active',
        ...patch,
    };
}

function routeSnapshot(patch: Partial<RouteSnapshot> = {}): RouteSnapshot {
    return {
        snapshotId: 'route-new',
        commit: NEW_COMMIT,
        baseCommit: 'base',
        diffId: '182801',
        createdAt: '2026-08-31T09:30:00.000Z',
        provenance: { harness: 'claude-code', model: 'sonnet-5', locale: null },
        previousSnapshotId: null,
        carried: null,
        summary: 'summary',
        stops: [],
        tourOrder: [],
        contentHash: 'hash',
        ...patch,
    };
}

const STALE: UiRouteStale = {
    routeCommit: OLD_COMMIT,
    prCommit: NEW_COMMIT,
    prDiffId: '182801',
    newIterations: 1,
    affectedStopIds: [],
};

function route(patch: Partial<UiRouteState> = {}): UiRouteState {
    return { phase: 'ready', smallPr: false, snapshot: routeSnapshot(), failure: null, stale: null, ...patch };
}

function input(patch: Partial<ViewingInput> = {}): ViewingInput {
    return {
        viewing: VIEWING_CURRENT,
        snapshots: [summary(), CURRENT],
        iterations: [],
        route: route(),
        activeDiffId: '182801',
        activeCommit: NEW_COMMIT,
        snapshotsLoaded: true,
        activeLoaded: true,
        ...patch,
    };
}

describe('resolve iteration selection', () => {
    it('current state uses endpoints without parameters and allows writes', () => {
        const resolved = resolveViewing(input());

        expect(resolved).toMatchObject({ diffId: null, snapshotId: null, readOnly: false, gone: false });
        expect(resolved.label).toEqual({ kind: 'snapshot', commit: NEW_COMMIT, status: 'current' });
    });

    it('the indicator label shows a stale route', () => {
        const resolved = resolveViewing(input({ route: route({ stale: STALE }) }));

        expect(resolved.label?.status).toBe('stale');
    });

    it('selecting the current snapshot behaves as current state while preserving the selection', () => {
        const resolved = resolveViewing(input({ viewing: { kind: 'snapshot', snapshotId: 'route-new' } }));

        expect(resolved).toMatchObject({ diffId: null, snapshotId: null, readOnly: false, unknown: false });
        expect(resolved.viewing).toEqual({ kind: 'snapshot', snapshotId: 'route-new' });
    });

    it('a previous snapshot goes into the parameters and enables read-only mode', () => {
        const resolved = resolveViewing(input({ viewing: { kind: 'snapshot', snapshotId: 'route-old' } }));

        expect(resolved).toMatchObject({
            diffId: '182800',
            snapshotId: 'route-old',
            readOnly: true,
            gone: false,
            createdAt: '2026-08-31T06:00:00.000Z',
        });
        expect(resolved.label).toEqual({ kind: 'snapshot', commit: OLD_COMMIT, status: 'stale' });
    });

    it('a non-current snapshot on the active iteration does not become read-only', () => {
        const regenerated = summary({ snapshotId: 'route-regen', diffId: '182801', commit: NEW_COMMIT });
        const resolved = resolveViewing(
            input({ snapshots: [regenerated, CURRENT], viewing: { kind: 'snapshot', snapshotId: 'route-regen' } }),
        );

        expect(resolved).toMatchObject({ diffId: '182801', snapshotId: 'route-regen', readOnly: false });
    });

    it('a snapshot of a gone iteration is marked `gone` and remains readable', () => {
        const gone = summary({ status: 'gone' });
        const resolved = resolveViewing(
            input({ snapshots: [gone, CURRENT], viewing: { kind: 'snapshot', snapshotId: 'route-old' } }),
        );

        expect(resolved).toMatchObject({ readOnly: true, gone: true });
        expect(resolved.label?.status).toBe('gone');
    });

    it('a previous iteration without a route has its own diff, is read-only and leaves the route tab without a route', () => {
        const resolved = resolveViewing(
            input({
                iterations: [iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' }), iteration()],
                snapshots: [CURRENT],
                viewing: { kind: 'diff', diffId: '182800' },
            }),
        );

        expect(resolved).toMatchObject({ diffId: '182800', snapshotId: null, readOnly: true, routeless: true });
        expect(resolved.label).toEqual({ kind: 'diff', commit: OLD_COMMIT, status: 'noRoute' });
    });

    it('the active iteration without a route uses the same endpoints without parameters for reads and writes', () => {
        const resolved = resolveViewing(
            input({
                iterations: [iteration()],
                snapshots: [summary()],
                route: route({ snapshot: routeSnapshot({ diffId: '182800', commit: OLD_COMMIT }), stale: STALE }),
                viewing: { kind: 'diff', diffId: '182801' },
            }),
        );

        expect(resolved).toMatchObject({ diffId: null, snapshotId: null, readOnly: false, routeless: true });
        expect(resolved.label).toEqual({ kind: 'diff', commit: NEW_COMMIT, status: 'noRoute' });
    });

    // The server may send `iterations: []`, leaving only the route without parameters to identify the active iteration.
    // Its response lives apart from the tab data and survives selection changes.
    it('known facts identify the active iteration even without an iteration list or a route in the tab', () => {
        const resolved = resolveViewing(
            input({
                iterations: [],
                snapshots: [CURRENT],
                route: null,
                viewing: { kind: 'diff', diffId: '182801' },
            }),
        );

        expect(resolved).toMatchObject({ diffId: null, readOnly: false, unknown: false, routeless: true });
        expect(resolved.label).toEqual({ kind: 'diff', commit: NEW_COMMIT, status: 'noRoute' });
    });

    it('before facts about the active iteration arrive, the selection stays and data is not loaded', () => {
        const resolved = resolveViewing(
            input({ activeLoaded: false, viewing: { kind: 'snapshot', snapshotId: 'route-old' } }),
        );

        expect(resolved).toMatchObject({ pending: true, unknown: false, diffId: null, snapshotId: null });
        expect(resolved.viewing).toEqual({ kind: 'snapshot', snapshotId: 'route-old' });
    });

    it('a snapshot on the active iteration does not become read-only just because the tab route is from another iteration', () => {
        const regenerated = summary({ snapshotId: 'route-regen', diffId: '182801', commit: NEW_COMMIT });
        const resolved = resolveViewing(
            input({
                iterations: [],
                snapshots: [regenerated, CURRENT],
                route: null,
                viewing: { kind: 'snapshot', snapshotId: 'route-regen' },
            }),
        );

        expect(resolved).toMatchObject({ diffId: '182801', snapshotId: 'route-regen', readOnly: false });
    });

    it('an unknown snapshot returns to current state and requests URL cleanup', () => {
        const resolved = resolveViewing(input({ viewing: { kind: 'snapshot', snapshotId: 'no-such-snapshot' } }));

        expect(resolved).toMatchObject({ unknown: true, diffId: null, snapshotId: null, readOnly: false });
        expect(resolved.viewing).toEqual(VIEWING_CURRENT);
    });

    it('an unknown iteration returns to current state', () => {
        const resolved = resolveViewing(input({ viewing: { kind: 'diff', diffId: '999' } }));

        expect(resolved).toMatchObject({ unknown: true, viewing: VIEWING_CURRENT });
    });

    it('before the snapshot list arrives, the selection stays and data is not loaded', () => {
        const resolved = resolveViewing(
            input({ snapshotsLoaded: false, viewing: { kind: 'snapshot', snapshotId: 'route-old' } }),
        );

        expect(resolved).toMatchObject({ pending: true, unknown: false, diffId: null, snapshotId: null });
    });

    it('a previous snapshot stays read-only even when the active iteration is unknown', () => {
        const resolved = resolveViewing(
            input({ activeDiffId: null, viewing: { kind: 'snapshot', snapshotId: 'route-old' } }),
        );

        expect(resolved.readOnly).toBe(true);
    });
});

describe('selection fragment', () => {
    it('snapshot takes precedence over slice, slice over diff, and empty values do not count', () => {
        expect(parseViewing('s1', 'd1')).toEqual({ kind: 'snapshot', snapshotId: 's1' });
        expect(parseViewing(null, 'd1')).toEqual({ kind: 'diff', diffId: 'd1' });
        expect(parseViewing(null, 'd1', 'b1', 'h1')).toEqual({ kind: 'slice', base: 'b1', head: 'h1' });
        expect(parseViewing('s1', null, 'b1', 'h1')).toEqual({ kind: 'snapshot', snapshotId: 's1' });
        expect(parseViewing(null, null)).toEqual(VIEWING_CURRENT);
    });

    it('a slice missing either half is ignored entirely', () => {
        expect(parseViewing(null, null, 'b1', null)).toEqual(VIEWING_CURRENT);
        expect(parseViewing(null, null, null, 'h1')).toEqual(VIEWING_CURRENT);
        expect(parseViewing(null, 'd1', 'b1', '')).toEqual({ kind: 'diff', diffId: 'd1' });
    });

    it('current state stays out of the URL and changing the selection clears anchors from another diff', () => {
        expect(viewingFragmentPatch(VIEWING_CURRENT, VIEWING_CURRENT)).toEqual({
            snapshot: null,
            diff: null,
            base: null,
            head: null,
        });
        expect(viewingFragmentPatch({ kind: 'snapshot', snapshotId: 's1' }, VIEWING_CURRENT)).toEqual({
            snapshot: 's1',
            diff: null,
            base: null,
            head: null,
            file: null,
            side: null,
            line: null,
            end: null,
            thread: null,
            stop: null,
        });
        expect(viewingFragmentPatch({ kind: 'diff', diffId: 'd1' }, { kind: 'diff', diffId: 'd1' })).toEqual({
            snapshot: null,
            diff: 'd1',
            base: null,
            head: null,
        });
    });

    it('both sides of a slice enter the URL and anchors from the previous selection are cleared', () => {
        expect(viewingFragmentPatch({ kind: 'slice', base: 'b1', head: 'h1' }, VIEWING_CURRENT)).toEqual({
            snapshot: null,
            diff: null,
            base: 'b1',
            head: 'h1',
            file: null,
            side: null,
            line: null,
            end: null,
            thread: null,
            stop: null,
        });
        // Same slice, anchors stay: the tab has not moved anywhere.
        expect(
            viewingFragmentPatch({ kind: 'slice', base: 'b1', head: 'h1' }, { kind: 'slice', base: 'b1', head: 'h1' }),
        ).toEqual({ snapshot: null, diff: null, base: 'b1', head: 'h1' });
    });
});

describe('resolve a slice between iterations', () => {
    const OLD = iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' });
    const ACTIVE = iteration();

    function sliceInput(patch: Partial<ViewingInput> = {}): ViewingInput {
        return input({
            iterations: [OLD, ACTIVE],
            snapshots: [CURRENT],
            viewing: { kind: 'slice', base: '182800', head: '182801' },
            ...patch,
        });
    }

    it('a slice uses the base/head endpoint, is read-only and has no route or snapshot', () => {
        const resolved = resolveViewing(sliceInput());

        expect(resolved).toMatchObject({
            diffId: '182801',
            snapshotId: null,
            readOnly: true,
            routeless: true,
            unknown: false,
            createdAt: OLD.createdAt,
        });
        expect(resolved.slice).toEqual({ base: '182800', head: '182801' });
        expect(resolved.label).toEqual({
            kind: 'slice',
            commit: NEW_COMMIT,
            baseCommit: OLD_COMMIT,
            status: 'slice',
        });
    });

    it('a slice between 2 previous iterations does not require an active head', () => {
        const older = iteration({ diffId: '182799', headCommit: 'c0ffee1', status: 'previous' });
        const resolved = resolveViewing(
            sliceInput({
                iterations: [older, OLD, ACTIVE],
                viewing: { kind: 'slice', base: '182799', head: '182800' },
            }),
        );

        expect(resolved).toMatchObject({ diffId: '182800', readOnly: true, routeless: true, unknown: false });
        expect(resolved.slice).toEqual({ base: '182799', head: '182800' });
        expect(resolved.label).toEqual({ kind: 'slice', commit: OLD_COMMIT, baseCommit: 'c0ffee1', status: 'slice' });
    });

    it('the active iteration outside the list is an eligible head because known facts provide its commit', () => {
        const resolved = resolveViewing(sliceInput({ iterations: [OLD] }));

        expect(resolved.slice).toEqual({ base: '182800', head: '182801' });
        expect(resolved.label).toMatchObject({ commit: NEW_COMMIT, baseCommit: OLD_COMMIT });
    });

    it('a gone iteration cannot be either edge of a slice, base or head', () => {
        const gone = iteration({ diffId: '182799', headCommit: 'c0ffee1', status: 'gone' });
        const asBase = resolveViewing(
            sliceInput({ iterations: [gone, OLD, ACTIVE], viewing: { kind: 'slice', base: '182799', head: '182801' } }),
        );
        const asHead = resolveViewing(
            sliceInput({ iterations: [OLD, gone, ACTIVE], viewing: { kind: 'slice', base: '182800', head: '182799' } }),
        );

        expect(asBase).toMatchObject({ unknown: true, viewing: VIEWING_CURRENT, slice: null, readOnly: false });
        expect(asHead).toMatchObject({ unknown: true, viewing: VIEWING_CURRENT, slice: null, readOnly: false });
    });

    it('a base newer than the head is invalid because the UI never builds this URL and the diff would be reversed', () => {
        const older = iteration({ diffId: '182799', headCommit: 'c0ffee1', status: 'previous' });
        const fromActive = resolveViewing(
            sliceInput({ iterations: [older, OLD, ACTIVE], viewing: { kind: 'slice', base: '182801', head: '182799' } }),
        );
        const betweenPrevious = resolveViewing(
            sliceInput({ iterations: [older, OLD, ACTIVE], viewing: { kind: 'slice', base: '182800', head: '182799' } }),
        );

        expect(fromActive).toMatchObject({ unknown: true, viewing: VIEWING_CURRENT, slice: null });
        expect(betweenPrevious).toMatchObject({ unknown: true, viewing: VIEWING_CURRENT, slice: null });
    });

    it('a head outside the list that is not active is invalid', () => {
        const resolved = resolveViewing(sliceInput({ viewing: { kind: 'slice', base: '182800', head: '999' } }));

        expect(resolved).toMatchObject({ unknown: true, slice: null });
    });

    it('a base outside the iteration list is invalid', () => {
        const resolved = resolveViewing(sliceInput({ viewing: { kind: 'slice', base: '999', head: '182801' } }));

        expect(resolved).toMatchObject({ unknown: true, slice: null });
    });

    it('an iteration cannot form a slice with itself', () => {
        const resolved = resolveViewing(sliceInput({ viewing: { kind: 'slice', base: '182801', head: '182801' } }));

        expect(resolved).toMatchObject({ unknown: true, slice: null });
    });

    it('before facts about the active iteration arrive, the slice stays and data is not loaded', () => {
        const resolved = resolveViewing(sliceInput({ activeLoaded: false }));

        expect(resolved).toMatchObject({ pending: true, unknown: false, diffId: null, slice: null });
        expect(resolved.viewing).toEqual({ kind: 'slice', base: '182800', head: '182801' });
    });
});

describe('picker rows', () => {
    it('snapshots appear newest first with provenance and status', () => {
        const rows = pickerRows({ snapshots: [summary(), CURRENT], iterations: [], activeIteration: null });

        expect(rows.iterations.map((row) => row.id)).toEqual(['route-new', 'route-old']);
        expect(rows.iterations[0]).toMatchObject({ status: 'current', model: 'sonnet-5', harness: 'claude-code' });
        expect(rows.iterations[1]?.status).toBe('stale');
    });

    it('the current snapshot of a previous iteration is stale in both the menu and the indicator', () => {
        const current = summary({ status: 'current' });
        const onPrevious = pickerRows({
            snapshots: [current],
            iterations: [],
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
        });
        const onActive = pickerRows({
            snapshots: [current],
            iterations: [],
            activeIteration: { diffId: current.diffId, commit: current.commit },
        });
        const unknownActive = pickerRows({ snapshots: [current], iterations: [], activeIteration: null });

        // The label changes, but selection without parameters still marks this row.
        expect(onPrevious.iterations.find((row) => row.kind === 'snapshot')).toMatchObject({
            status: 'stale',
            latest: true,
        });
        expect(onActive.iterations[0]?.status).toBe('current');
        expect(unknownActive.iterations[0]?.status).toBe('current');
    });

    it('the active iteration without a route is the first row, above snapshots of previous iterations', () => {
        const rows = pickerRows({
            snapshots: [summary()],
            iterations: [
                iteration({ diffId: '182799', headCommit: 'c0ffee1', status: 'gone', createdAt: '2026-08-31T03:00:00.000Z' }),
                iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous', createdAt: '2026-08-31T05:00:00.000Z' }),
                iteration(),
            ],
            activeIteration: null,
        });

        // Active iteration 182801 has no route but comes first. 182800 appears as its snapshot.
        expect(rows.iterations.map((row) => row.id)).toEqual(['182801', 'route-old', '182799']);
        expect(rows.iterations[0]?.status).toBe('activeIteration');
        expect(rows.iterations[1]?.kind).toBe('snapshot');
        expect(rows.iterations[2]?.status).toBe('gone');
    });

    it('a snapshot sits beside its iteration instead of in a separate section at the top', () => {
        const older = summary({ snapshotId: 'route-older', diffId: '182799', createdAt: '2026-08-31T04:00:00.000Z' });
        const rows = pickerRows({
            snapshots: [older, summary()],
            iterations: [
                iteration({ diffId: '182799', headCommit: 'c0ffee1', status: 'previous', createdAt: '2026-08-31T03:00:00.000Z' }),
                iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous', createdAt: '2026-08-31T05:00:00.000Z' }),
                iteration({ createdAt: '2026-08-31T09:00:00.000Z' }),
            ],
            activeIteration: null,
        });

        expect(rows.iterations.map((row) => row.id)).toEqual(['182801', 'route-old', 'route-older']);
    });

    it('identical 7-character commit prefixes expand until distinct', () => {
        const head = '6630996aa1b2c3d4e5f60718293a4b5c6d7e8f90';
        const rows = pickerRows({
            snapshots: [],
            iterations: [
                iteration({ diffId: '1', headCommit: `${head}+11111111`, status: 'previous', createdAt: '2026-08-31T03:00:00.000Z' }),
                iteration({ diffId: '2', headCommit: `${head}+22222222`, status: 'previous', createdAt: '2026-08-31T05:00:00.000Z' }),
                iteration({ diffId: '3', headCommit: head, createdAt: '2026-08-31T09:00:00.000Z' }),
            ],
            activeIteration: null,
        });

        expect(rows.iterations.map((row) => row.short)).toEqual(['6630996…8f90', '6630996…2222', '6630996…1111']);
    });

    it('2 iterations with the same commit label their rows with the exact time', () => {
        const rows = pickerRows({
            snapshots: [],
            iterations: [
                iteration({ diffId: '1', status: 'previous', createdAt: '2026-08-31T03:00:00.000Z' }),
                iteration({ diffId: '2', status: 'previous', createdAt: '2026-08-31T05:00:00.000Z' }),
                iteration({ diffId: '3', headCommit: OLD_COMMIT, createdAt: '2026-08-31T09:00:00.000Z' }),
            ],
            activeIteration: null,
        });

        // Both the commit and short id match entirely for the first 2. Only the time distinguishes them.
        expect(rows.iterations.map((row) => [row.id, row.ambiguous])).toEqual([
            ['3', false],
            ['2', true],
            ['1', true],
        ]);
    });

    it('an empty iteration list produces an active row from App facts', () => {
        const rows = pickerRows({
            snapshots: [summary()],
            iterations: [],
            activeIteration: { diffId: STALE.prDiffId, commit: STALE.prCommit },
        });

        expect(rows.iterations.map((row) => row.id)).toEqual(['182801', 'route-old']);
        expect(rows.iterations[0]).toMatchObject({ id: '182801', commit: NEW_COMMIT, status: 'activeIteration' });
    });

    it('the menu has one timeline and slice edges are iterations excluding gone ones, oldest to newest', () => {
        const rows = pickerRows({
            snapshots: [CURRENT],
            iterations: [
                iteration({ diffId: '182799', headCommit: 'c0ffee1', status: 'gone' }),
                iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' }),
                iteration(),
            ],
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
            interdiff: true,
        });

        expect(rows.iterations.map((row) => `${row.kind}:${row.id}`)).toEqual([
            'snapshot:route-new',
            'diff:182800',
            'diff:182799',
        ]);
        expect([...rows.sliceOrder]).toEqual([
            ['182800', 1],
            ['182801', 2],
        ]);
    });

    it('a host without slice support has no slice edges', () => {
        const rows = pickerRows({
            snapshots: [CURRENT],
            iterations: [iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' }), iteration()],
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
        });

        expect(rows.sliceOrder.size).toBe(0);
    });

    it('the active iteration outside the list is the newest', () => {
        const rows = pickerRows({
            snapshots: [CURRENT],
            iterations: [iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' })],
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
            interdiff: true,
        });

        expect([...rows.sliceOrder]).toEqual([
            ['182800', 0],
            ['182801', 1],
        ]);
    });

    it('without a snapshots endpoint, the list uses the current route snapshot', () => {
        const list = fallbackSnapshots(routeSnapshot());

        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ snapshotId: 'route-new', diffId: '182801', status: 'current' });
        expect(fallbackSnapshots(null)).toEqual([]);
    });
});

describe('2-step slice selection in picker rows', () => {
    const OLDER = iteration({ diffId: '182799', headCommit: 'c0ffee1', status: 'previous' });
    const OLD = iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' });
    const ACTIVE = iteration();
    const ROWS = pickerRows({
        snapshots: [CURRENT],
        iterations: [OLDER, OLD, ACTIVE],
        activeIteration: { diffId: '182801', commit: NEW_COMMIT },
        interdiff: true,
    });

    function row(diffId: string, rows = ROWS) {
        const found = rows.iterations.find((candidate) => candidate.diffId === diffId);
        if (found === undefined) {
            throw new Error(`no row for ${diffId}`);
        }
        return found;
    }

    it('a plain click without a first edge selects a row', () => {
        expect(rowAction(ROWS, null, row('182800'), false)).toEqual({
            kind: 'select',
            viewing: { kind: 'diff', diffId: '182800' },
        });
    });

    it('Shift+click sets the first edge without selecting, including on the active iteration', () => {
        expect(rowAction(ROWS, null, row('182800'), true)).toEqual({ kind: 'edge', edge: '182800' });
        expect(rowAction(ROWS, null, row('182801'), true)).toEqual({ kind: 'edge', edge: '182801' });
    });

    it('the second click with or without Shift builds a slice with the older iteration as base and newer as head', () => {
        const slice = { kind: 'select', viewing: { kind: 'slice', base: '182799', head: '182801' } };

        expect(rowAction(ROWS, '182799', row('182801'), false)).toEqual(slice);
        expect(rowAction(ROWS, '182799', row('182801'), true)).toEqual(slice);
        expect(rowAction(ROWS, '182801', row('182799'), false)).toEqual(slice);
    });

    it('clicking the first-edge iteration clears it', () => {
        expect(rowAction(ROWS, '182801', row('182801'), false)).toEqual({ kind: 'edge', edge: null });
        expect(rowAction(ROWS, '182801', row('182801'), true)).toEqual({ kind: 'edge', edge: null });
    });

    it('a snapshot of the first-edge iteration is the same iteration and clears the edge', () => {
        const rows = pickerRows({
            snapshots: [summary({ snapshotId: 'route-old-1' }), summary({ snapshotId: 'route-old-2', status: 'current' })],
            iterations: [OLDER, OLD, ACTIVE],
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
            interdiff: true,
        });
        const second = rows.iterations.find((candidate) => candidate.id === 'route-old-1');
        expect(second).toBeDefined();
        if (second !== undefined) {
            expect(rowAction(rows, '182800', second, false)).toEqual({ kind: 'edge', edge: null });
        }
    });

    it('Shift+click selects normally for a gone iteration or a host without slice support', () => {
        const withGone = pickerRows({
            snapshots: [],
            iterations: [{ ...OLDER, status: 'gone' }, OLD, ACTIVE],
            activeIteration: null,
            interdiff: true,
        });
        expect(rowAction(withGone, null, row('182799', withGone), true)).toEqual({
            kind: 'select',
            viewing: { kind: 'diff', diffId: '182799' },
        });

        const noInterdiff = pickerRows({ snapshots: [], iterations: [OLD, ACTIVE], activeIteration: null });
        expect(rowAction(noInterdiff, null, row('182800', noInterdiff), true)).toEqual({
            kind: 'select',
            viewing: { kind: 'diff', diffId: '182800' },
        });
    });

    it('Shift+click selects normally when there is only one eligible iteration to compare', () => {
        const alone = pickerRows({
            snapshots: [],
            iterations: [{ ...OLDER, status: 'gone' }, ACTIVE],
            activeIteration: null,
            interdiff: true,
        });
        expect(rowAction(alone, null, row('182801', alone), true)).toEqual({
            kind: 'select',
            viewing: { kind: 'diff', diffId: '182801' },
        });
    });

    it('with a first edge set, clicking an ineligible edge row selects normally', () => {
        const withGone = pickerRows({
            snapshots: [],
            iterations: [{ ...OLDER, status: 'gone' }, OLD, ACTIVE],
            activeIteration: null,
            interdiff: true,
        });
        expect(rowAction(withGone, '182800', row('182799', withGone), false)).toEqual({
            kind: 'select',
            viewing: { kind: 'diff', diffId: '182799' },
        });
    });

    it('a first edge no longer among eligible iterations has no effect', () => {
        expect(rowAction(ROWS, 'no-such-iteration', row('182800'), false)).toEqual({
            kind: 'select',
            viewing: { kind: 'diff', diffId: '182800' },
        });
    });

    it('the active iteration outside the list without its own row is an eligible slice head', () => {
        const rows = pickerRows({
            snapshots: [],
            iterations: [OLDER, OLD],
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
            interdiff: true,
        });

        expect(sliceBetween(rows, '182801', '182800')).toEqual({ kind: 'slice', base: '182800', head: '182801' });
        expect(sliceBetween(rows, '182800', '182800')).toBeNull();
        expect(sliceBetween(rows, '182800', 'no-such-iteration')).toBeNull();
    });

    function marked(marks: ReturnType<typeof sliceMarks>) {
        return [...marks].map(([markedRow, mark]) => [markedRow.id, mark.part, mark.role]);
    }

    it('a first edge without a cursor on another iteration is the only mark', () => {
        expect(marked(sliceMarks(ROWS, VIEWING_CURRENT, '182799', null))).toEqual([['182799', 'edge', null]]);
        expect(marked(sliceMarks(ROWS, VIEWING_CURRENT, '182799', row('182799')))).toEqual([['182799', 'edge', null]]);
    });

    it('a cursor on another eligible iteration previews the range with unlabelled edges', () => {
        expect(marked(sliceMarks(ROWS, VIEWING_CURRENT, '182799', row('182801')))).toEqual([
            ['route-new', 'edge', null],
            ['182800', 'inside', null],
            ['182799', 'edge', null],
        ]);
    });

    it('a cursor on a row ineligible as an edge has no preview', () => {
        const withGone = pickerRows({
            snapshots: [],
            iterations: [OLDER, { ...OLD, status: 'gone' }, ACTIVE],
            activeIteration: null,
            interdiff: true,
        });
        expect(marked(sliceMarks(withGone, VIEWING_CURRENT, '182801', row('182800', withGone)))).toEqual([
            ['182801', 'edge', null],
        ]);
    });

    it('a slice marks edges with base and head labels and the iteration snapshots inside', () => {
        const rows = pickerRows({
            snapshots: [summary({ snapshotId: 'route-old-1' }), summary({ snapshotId: 'route-old-2' }), CURRENT],
            iterations: [OLDER, OLD, ACTIVE],
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
            interdiff: true,
        });
        const slice = { kind: 'slice', base: '182799', head: '182801' } as const;

        expect(marked(sliceMarks(rows, slice, null, null))).toEqual([
            ['route-new', 'edge', 'head'],
            ['route-old-2', 'inside', null],
            ['route-old-1', 'inside', null],
            ['182799', 'edge', 'base'],
        ]);
    });

    it('an edge label appears only on the first row of an iteration group', () => {
        const rows = pickerRows({
            snapshots: [summary({ snapshotId: 'route-old-1' }), summary({ snapshotId: 'route-old-2' })],
            iterations: [OLD, ACTIVE],
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
            interdiff: true,
        });

        expect(marked(sliceMarks(rows, { kind: 'slice', base: '182800', head: '182801' }, null, null))).toEqual([
            ['182801', 'edge', 'head'],
            ['route-old-2', 'edge', 'base'],
            ['route-old-1', 'edge', null],
        ]);
    });

    it('the preview replaces the active slice mark', () => {
        const slice = { kind: 'slice', base: '182800', head: '182801' } as const;

        expect(marked(sliceMarks(ROWS, slice, '182799', row('182800')))).toEqual([
            ['182800', 'edge', null],
            ['182799', 'edge', null],
        ]);
    });

    it('outside a slice with no first edge, there are no marks', () => {
        expect(sliceMarks(ROWS, { kind: 'diff', diffId: '182800' }, null, row('182799')).size).toBe(0);
    });
});
