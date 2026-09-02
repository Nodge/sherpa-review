import { fileContentOf, fixtureData, routeFixtures } from '@sherpa/fixtures';
import type { Iteration, RouteSnapshot, UiSnapshotSummary } from '@sherpa/protocol';
import { useMemo } from 'react';

import type { BannerSource } from '../../components/banner-slot.tsx';
import { BANNER_PRIORITY, BannerSlot } from '../../components/banner-slot.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { ReadOnlyIterationProvider } from '../../iterations/read-only.tsx';
import { SnapshotPill } from '../../iterations/snapshot-picker.tsx';
import type { Viewing, ViewingLabel } from '../../iterations/viewing.js';
import { pickerRows, VIEWING_CURRENT } from '../../iterations/viewing.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { ReadOnlyIterationBanner } from '../../views/route/iteration-banners.tsx';
import { RouteWorkspace } from '../../views/route/route-view.tsx';
import { ViewFrame } from '../../views/view-frames.tsx';
import type { RouteGalleryState } from './m2-t6-states.tsx';

/**
 * Snapshot picker and read-only mode for a previous iteration (M4-T9). The fixture has one snapshot, so
 * the list and statuses are built here on top of the ready `medium` snapshot. The server will fill them in T4,
 * using the shape from the M4-T1 contract.
 */

const DATA = fixtureData('medium');
const GALLERY_NOW = Date.parse('2026-08-31T12:00:00.000Z');

const OLD_COMMIT = '5c1d0aa8b7e6f4302d9c8b7a6f5e4d3c2b1a0999';
const GONE_COMMIT = 'b0d3f77a1c8e4562d0a9b8c7f6e5d4c3b2a10088';
const PR_COMMIT = 'a71d4e2c9b8f5301d6e4a2c7b09f8e3d5a4c6b21';
const PR_DIFF_ID = '182801';

function readySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
}

const CURRENT = readySnapshot();

function summary(patch: Partial<UiSnapshotSummary>): UiSnapshotSummary {
    return {
        snapshotId: CURRENT.snapshotId,
        diffId: CURRENT.diffId,
        commit: CURRENT.commit,
        baseCommit: CURRENT.baseCommit,
        createdAt: CURRENT.createdAt,
        provenance: CURRENT.provenance,
        previousSnapshotId: null,
        status: 'current',
        ...patch,
    };
}

/** Removed commit, previous snapshot and current snapshot, in order of appearance. */
const SNAPSHOTS: readonly UiSnapshotSummary[] = [
    summary({
        snapshotId: 'route-medium-b0d3f77',
        diffId: '182798',
        commit: GONE_COMMIT,
        createdAt: '2026-08-29T09:00:00.000Z',
        provenance: { harness: 'claude-code', model: 'opus-5' },
        status: 'gone',
    }),
    summary({
        snapshotId: 'route-medium-5c1d0aa',
        diffId: '182799',
        commit: OLD_COMMIT,
        createdAt: '2026-08-31T06:00:00.000Z',
        provenance: { harness: 'claude-code', model: 'opus-5' },
        status: 'stale',
    }),
    summary({ createdAt: '2026-08-31T11:00:00.000Z', previousSnapshotId: 'route-medium-5c1d0aa' }),
];

/** Active iteration with no route yet (the author pushed, the route has not been rebuilt). */
const ITERATIONS: readonly Iteration[] = [
    {
        diffId: PR_DIFF_ID,
        baseCommit: CURRENT.baseCommit,
        headCommit: PR_COMMIT,
        createdAt: '2026-08-31T11:40:00.000Z',
        status: 'active',
    },
];

const ROWS = pickerRows({ snapshots: SNAPSHOTS, iterations: ITERATIONS, activeIteration: null });

function pill(label: ViewingLabel, viewing: Viewing, initialOpen = false) {
    return (
        <SnapshotPill
            label={label}
            menu={{ rows: ROWS, viewing, now: GALLERY_NOW, onSelect: () => undefined, initialOpen }}
        />
    );
}

interface ReadingStateProps {
    readonly label: ViewingLabel;
    readonly viewing: Viewing;
    readonly createdAt: string | null;
    readonly gone?: boolean;
    readonly menuOpen?: boolean;
    readonly readOnly?: boolean;
}

/** Route tab below the picker: the same banner sources and priority order as App. */
function ReadingState({
    label,
    viewing,
    createdAt,
    gone = false,
    menuOpen = false,
    readOnly = true,
}: ReadingStateProps) {
    const session = useMemo(() => createSessionStore({ initial: { view: 'route', filter: 'all', viewing } }), [viewing]);
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: DATA.diff.files, storage: null });
        for (const file of DATA.diff.files) {
            created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
        return created;
    }, []);
    const threadStore = useMemo(
        () => createThreadStore(DATA.threads, new Set(DATA.diff.files.map((file) => file.fileId))),
        [],
    );
    const banners: readonly BannerSource[] = [
        {
            id: 'read-only-iteration',
            priority: BANNER_PRIORITY.readOnlyIteration,
            active: () => readOnly,
            render: () => (
                <ReadOnlyIterationBanner
                    label={label}
                    createdAt={createdAt}
                    now={GALLERY_NOW}
                    gone={gone}
                    onCurrent={() => undefined}
                />
            ),
        },
    ];

    return (
        <ReadOnlyIterationProvider readOnly={readOnly}>
            <div className="gallery__viewport">
                <BannerSlot sources={banners} />
                <RouteWorkspace
                    pr={DATA.pr}
                    diff={DATA.diff}
                    lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
                    snapshot={CURRENT}
                    session={session}
                    store={store}
                    threadStore={threadStore}
                    threadNow={GALLERY_NOW}
                    headerAside={pill(label, viewing, menuOpen)}
                    parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                    loadContent={(fileId) => {
                        const file = DATA.diff.files.find((candidate) => candidate.fileId === fileId);
                        return Promise.resolve(file === undefined ? null : fileContentOf(file));
                    }}
                    onSetViewed={() => Promise.resolve(0)}
                    onSetStopViewed={() => Promise.resolve(0)}
                    onOpenThread={() => undefined}
                />
            </div>
        </ReadOnlyIterationProvider>
    );
}

/** Overview with the "Snapshots" card in the right rail (README §6). */
function OverviewSnapshotsState() {
    const session = useMemo(() => createSessionStore({ initial: { view: 'overview', filter: 'all' } }), []);
    const threadStore = useMemo(
        () => createThreadStore(DATA.threads, new Set(DATA.diff.files.map((file) => file.fileId))),
        [],
    );

    return (
        <div className="gallery__viewport">
            <ViewFrame
                view="overview"
                prKey="fixture-medium"
                session={session}
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
                threads={DATA.threads}
                threadStore={threadStore}
                threadNow={GALLERY_NOW}
                reviewHostAvailable
                picker={{ rows: ROWS, viewing: VIEWING_CURRENT, now: GALLERY_NOW, onSelect: () => undefined }}
            />
        </div>
    );
}

const OLD_LABEL: ViewingLabel = { kind: 'snapshot', commit: OLD_COMMIT, status: 'stale' };
const GONE_LABEL: ViewingLabel = { kind: 'snapshot', commit: GONE_COMMIT, status: 'gone' };
const CURRENT_LABEL: ViewingLabel = { kind: 'snapshot', commit: CURRENT.commit, status: 'current' };

export const M4_T9_STATES: readonly RouteGalleryState[] = [
    {
        id: 'iterations-snapshot-picker',
        title: 'picker menu: 3 snapshots and the active iteration without a route',
        render: () => (
            <ReadingState
                label={CURRENT_LABEL}
                viewing={VIEWING_CURRENT}
                createdAt={CURRENT.createdAt}
                menuOpen
                readOnly={false}
            />
        ),
    },
    {
        id: 'iterations-old-snapshot-readonly',
        title: 'previous snapshot: read-only banner, disabled marks and composer',
        render: () => (
            <ReadingState
                label={OLD_LABEL}
                viewing={{ kind: 'snapshot', snapshotId: 'route-medium-5c1d0aa' }}
                createdAt="2026-08-31T06:00:00.000Z"
            />
        ),
    },
    {
        id: 'iterations-snapshot-gone-readonly',
        title: 'snapshot of a removed commit: commit no longer in the PR',
        render: () => (
            <ReadingState
                label={GONE_LABEL}
                viewing={{ kind: 'snapshot', snapshotId: 'route-medium-b0d3f77' }}
                createdAt="2026-08-29T09:00:00.000Z"
                gone
            />
        ),
    },
    {
        id: 'iterations-overview-snapshots-card',
        title: 'Overview: Snapshots card with provenance',
        render: () => <OverviewSnapshotsState />,
    },
];
