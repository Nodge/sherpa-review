import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteCarried, RouteSnapshot, RouteStopChange, UiRouteStale } from '@sherpa/protocol';
import { useMemo } from 'react';

import type { BannerSource } from '../../components/banner-slot.tsx';
import { BANNER_PRIORITY, BannerSlot } from '../../components/banner-slot.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import type { RouteFilter } from '../../session/session-store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteSecondPassBanner, RouteStaleBanner } from '../../views/route/iteration-banners.tsx';
import { RouteWorkspace } from '../../views/route/route-workspace.tsx';
import type { RouteGalleryState } from './route-states.tsx';

/**
 * Second pass states: stale banner, rebuild banner, what is new filter,
 * badges and the why this stop changed block.
 *
 * Fixtures hold one iteration, so stop classifications and `stale` are built here
 * on top of the existing `medium` snapshot. Their shape comes from the iteration contract.
 */

const DATA = fixtureIteration('medium');
const GALLERY_NOW = Date.parse('2026-08-31T12:00:00.000Z');

/** Active host iteration ahead of the snapshot iteration (docs/design/README.md §9). */
const PR_COMMIT = 'a71d4e2c9b8f5301d6e4a2c7b09f8e3d5a4c6b21';
const PR_DIFF_ID = '182801';

/** Thread on line 33 of `edit-policy.ts`, within the anchors of stop s02. */
const REASON_THREAD_ID = '4820263';

function readySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
}

const CHANGED_WITH_REASON: RouteStopChange = {
    kind: 'changed',
    reason: 'The author moved the check for whether an order is still editable into `EditWindow.allows`, following the reviewer thread about the policy reading the clock twice.',
    threadIds: [REASON_THREAD_ID],
};

const DEFAULT_CHANGES: Readonly<Record<string, RouteStopChange>> = {
    s02: CHANGED_WITH_REASON,
    s03: { kind: 'changed', reason: null, threadIds: [] },
    s06: { kind: 'new', reason: null, threadIds: [] },
};

/**
 * Second pass snapshot: 2 changed stops, one new stop, progress carried over.
 * The carryover denominator is 6 stops with anchors. Carryover cannot cover Other.
 */
function secondPassSnapshot(
    changes: Readonly<Record<string, RouteStopChange>> = DEFAULT_CHANGES,
    carried: RouteCarried = { kept: 3, total: 6, zeroReason: null },
): RouteSnapshot {
    const snapshot = readySnapshot();
    return {
        ...snapshot,
        snapshotId: 'route-medium-a71d4e2',
        commit: PR_COMMIT,
        diffId: PR_DIFF_ID,
        previousSnapshotId: snapshot.snapshotId,
        carried,
        stops: snapshot.stops.map((stop) => ({ ...stop, change: changes[stop.id] ?? null })),
    };
}

/** Local review iterations: `headCommit` is a diff fingerprint, rather than a commit. */
const LOCAL_ROUTE_DIFF_ID = '6c1f9a3d41f07f0b2f0f9cbb2b6d2f4a1d1a7f8c0e6d5b4a3928176c5d4e3f20';
const LOCAL_TREE_DIFF_ID = 'a3d52f80b91c4e7d6a2f0c8b5e4d3a291f7c6b5a4938271605d4c3b2a1908f7e';

function staleOf(snapshot: RouteSnapshot): UiRouteStale {
    return {
        routeCommit: snapshot.commit,
        prCommit: PR_COMMIT,
        prDiffId: PR_DIFF_ID,
        newIterations: 2,
        affectedStopIds: ['s02', 's03', 's06'],
    };
}

/**
 * The same stale state in local review: there is no PR, the working tree moved ahead, and a diff
 * fingerprint identifies the iteration. The first characters distinguish both sides.
 */
function localStaleOf(): UiRouteStale {
    return {
        routeCommit: LOCAL_ROUTE_DIFF_ID,
        prCommit: LOCAL_TREE_DIFF_ID,
        prDiffId: LOCAL_TREE_DIFF_ID,
        newIterations: 1,
        affectedStopIds: ['s02'],
    };
}

interface IterationStateProps {
    readonly snapshot: RouteSnapshot;
    readonly routeFilter?: RouteFilter;
    /** Slot sources use the same priorities as App. The priority order chooses the banner, not the markup. */
    readonly banners?: readonly BannerSource[];
}

function IterationState({ snapshot, routeFilter = 'all', banners = [] }: IterationStateProps) {
    const session = useMemo(
        () => createSessionStore({ initial: { view: 'route', filter: 'all', routeFilter } }),
        [routeFilter],
    );
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: DATA.diff.files });
        for (const file of DATA.diff.files) {
            created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
        return created;
    }, []);
    const threadStore = useMemo(
        () => createThreadStore(DATA.threads, new Set(DATA.diff.files.map((file) => file.fileId))),
        [],
    );

    return (
        <div className="gallery__viewport">
            <BannerSlot sources={banners} />
            <RouteWorkspace
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
                snapshot={snapshot}
                session={session}
                store={store}
                threadStore={threadStore}
                threadNow={GALLERY_NOW}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={(fileId) => {
                    const file = DATA.diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(file === undefined ? null : fileContentOf(file));
                }}
                onSetViewed={() => Promise.resolve(0)}
                onSetStopViewed={() => Promise.resolve(0)}
                onSetStopFileViewed={() => Promise.resolve(0)}
                onOpenThread={() => undefined}
            />
        </div>
    );
}

function staleBanners(snapshot: RouteSnapshot, localHost = false): readonly BannerSource[] {
    return [
        {
            id: 'route-stale',
            priority: BANNER_PRIORITY.routeStale,
            active: () => true,
            render: () => (
                <RouteStaleBanner
                    stale={localHost ? localStaleOf() : staleOf(snapshot)}
                    stops={snapshot.stops}
                    localHost={localHost}
                    onRegenerate={() => undefined}
                    onOpenDiffWithoutRoute={() => undefined}
                />
            ),
        },
    ];
}

function secondPassBanners(snapshot: RouteSnapshot): readonly BannerSource[] {
    return [
        {
            id: 'route-second-pass',
            priority: BANNER_PRIORITY.routeSecondPass,
            active: () => true,
            render: () => (
                <RouteSecondPassBanner
                    commit={snapshot.commit}
                    carried={snapshot.carried}
                    changedStops={snapshot.stops.filter((stop) => stop.change !== null).length}
                    onShowNew={() => undefined}
                    onDismiss={() => undefined}
                />
            ),
        },
    ];
}

/** Snapshot with a single classified stop. Its badge is visible without the filter. */
function oneChange(stopId: string, change: RouteStopChange): RouteSnapshot {
    return secondPassSnapshot({ [stopId]: change });
}

export const ITERATION_SECOND_PASS_STATES: readonly RouteGalleryState[] = [
    {
        id: 'iterations-stale-banner',
        title: 'stale route: PR moved 2 iterations ahead',
        render: () => {
            const snapshot = readySnapshot();
            return <IterationState snapshot={snapshot} banners={staleBanners(snapshot)} />;
        },
    },
    {
        id: 'iterations-stale-banner-local',
        title: 'stale route: local review, working tree moved ahead',
        render: () => {
            const snapshot = readySnapshot();
            return <IterationState snapshot={snapshot} banners={staleBanners(snapshot, true)} />;
        },
    },
    {
        id: 'iterations-second-pass-banner',
        title: 'second pass: progress carried over, filter offered',
        render: () => {
            const snapshot = secondPassSnapshot();
            return <IterationState snapshot={snapshot} banners={secondPassBanners(snapshot)} />;
        },
    },
    {
        id: 'iterations-second-pass-zero-carry',
        title: 'second pass: zero carryover, some stops changed',
        render: () => {
            const snapshot = secondPassSnapshot(DEFAULT_CHANGES, { kept: 0, total: 6, zeroReason: 'no_overlap' });
            return <IterationState snapshot={snapshot} banners={secondPassBanners(snapshot)} />;
        },
    },
    {
        id: 'iterations-filter-new',
        title: 'what is new filter: 3 stops and a toolbar chip',
        render: () => <IterationState snapshot={secondPassSnapshot()} routeFilter="new" />,
    },
    {
        id: 'iterations-stop-changed',
        title: 'changed badge in the stop header',
        render: () => <IterationState snapshot={oneChange('s03', { kind: 'changed', reason: null, threadIds: [] })} />,
    },
    {
        id: 'iterations-stop-new',
        title: 'new badge in the stop header',
        render: () => <IterationState snapshot={oneChange('s06', { kind: 'new', reason: null, threadIds: [] })} />,
    },
    {
        id: 'iterations-why-changed',
        title: 'why this stop changed block with a thread link',
        render: () => <IterationState snapshot={oneChange('s02', CHANGED_WITH_REASON)} />,
    },
];
