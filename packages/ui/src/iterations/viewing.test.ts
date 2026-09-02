import type { Iteration, RouteSnapshot, UiRouteStale, UiRouteState, UiSnapshotSummary } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import {
    fallbackSnapshots,
    parseViewing,
    pickerRows,
    resolveViewing,
    VIEWING_CURRENT,
    viewingFragmentPatch,
} from './viewing.js';
import type { ViewingInput } from './viewing.js';

/**
 * Resolving iteration selection (M4-T9): endpoint parameters, where read-only mode applies,
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
        provenance: { harness: 'claude-code', model: 'sonnet-5' },
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
        provenance: { harness: 'claude-code', model: 'sonnet-5' },
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

    it('shows a stale route in the pill label', () => {
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

    // Before M4-T4 the server sends `iterations: []`, and only the route knows the active iteration
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
    it('snapshot takes priority over diff, empty values do not count', () => {
        expect(parseViewing('s1', 'd1')).toEqual({ kind: 'snapshot', snapshotId: 's1' });
        expect(parseViewing(null, 'd1')).toEqual({ kind: 'diff', diffId: 'd1' });
        expect(parseViewing(null, null)).toEqual(VIEWING_CURRENT);
    });

    it('current state stays out of the URL and changing the selection clears anchors from another diff', () => {
        expect(viewingFragmentPatch(VIEWING_CURRENT, VIEWING_CURRENT)).toEqual({ snapshot: null, diff: null });
        expect(viewingFragmentPatch({ kind: 'snapshot', snapshotId: 's1' }, VIEWING_CURRENT)).toEqual({
            snapshot: 's1',
            diff: null,
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
        });
    });
});

describe('picker rows', () => {
    it('snapshots appear newest first with provenance and status', () => {
        const rows = pickerRows({ snapshots: [summary(), CURRENT], iterations: [], activeIteration: null });

        expect(rows.snapshots.map((row) => row.id)).toEqual(['route-new', 'route-old']);
        expect(rows.snapshots[0]).toMatchObject({ status: 'current', model: 'sonnet-5', harness: 'claude-code' });
        expect(rows.snapshots[1]?.status).toBe('stale');
    });

    it('lists iterations without snapshots in a separate section, newest first', () => {
        const rows = pickerRows({
            snapshots: [summary()],
            iterations: [
                iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' }),
                iteration({ diffId: '182799', headCommit: 'c0ffee1', status: 'gone' }),
                iteration(),
            ],
            activeIteration: null,
        });

        // 182800 has a snapshot, so it is absent from the iterations section.
        expect(rows.iterations.map((row) => row.id)).toEqual(['182801', '182799']);
        expect(rows.iterations[0]?.status).toBe('activeIteration');
        expect(rows.iterations[1]?.status).toBe('gone');
    });

    it('an empty iteration list produces an active row from App facts', () => {
        const rows = pickerRows({
            snapshots: [summary()],
            iterations: [],
            activeIteration: { diffId: STALE.prDiffId, commit: STALE.prCommit },
        });

        expect(rows.iterations).toHaveLength(1);
        expect(rows.iterations[0]).toMatchObject({ id: '182801', commit: NEW_COMMIT, status: 'activeIteration' });
    });

    it('without a snapshots endpoint, the list uses the current route snapshot', () => {
        const list = fallbackSnapshots(routeSnapshot());

        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ snapshotId: 'route-new', diffId: '182801', status: 'current' });
        expect(fallbackSnapshots(null)).toEqual([]);
    });
});
