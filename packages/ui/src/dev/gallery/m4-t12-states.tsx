import { fixtureInterdiff, fixtureIteration } from '@sherpa/fixtures';
import type { Iteration, PrDiff } from '@sherpa/protocol';
import { useMemo } from 'react';

import type { BannerSource } from '../../components/banner-slot.tsx';
import { BANNER_PRIORITY, BannerSlot } from '../../components/banner-slot.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { ReadOnlyIterationProvider, SLICE_READ_ONLY_REASON } from '../../iterations/read-only.tsx';
import { SnapshotPill } from '../../iterations/snapshot-picker.tsx';
import type { Viewing, ViewingLabel } from '../../iterations/viewing.js';
import { pickerRows } from '../../iterations/viewing.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { DiffWorkspace, FullDiffView } from '../../views/full-diff.tsx';
import { ReadOnlyIterationBanner } from '../../views/route/iteration-banners.tsx';
import { IterationWithoutRoute, SliceWithoutOverview } from '../../views/view-frames.tsx';
import type { RouteGalleryState } from './m2-t6-states.tsx';

/**
 * Slice between iterations (M4-T12): "what is new" from the previous iteration to the active one, with no route,
 * no progress, and read-only. Data is the `medium` fixture's v1→v2 interdiff, the same one
 * the host returns for `getDiff({base, head})`.
 */

const V1 = fixtureIteration('medium', 0);
const V2 = fixtureIteration('medium', 1);
const SLICE: PrDiff = fixtureInterdiff('medium', 0, 1);
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');

const ITERATIONS: readonly Iteration[] = [
    { ...V1.iteration, status: 'previous' },
    { ...V2.iteration, status: 'active' },
];

const ROWS = pickerRows({
    snapshots: [],
    iterations: ITERATIONS,
    activeIteration: { diffId: V2.iteration.diffId, commit: V2.iteration.headCommit },
    interdiff: true,
});

const VIEWING: Viewing = { kind: 'slice', base: V1.iteration.diffId, head: V2.iteration.diffId };
const LABEL: ViewingLabel = {
    kind: 'slice',
    commit: V2.iteration.headCommit,
    baseCommit: V1.iteration.headCommit,
    status: 'slice',
};
const SLICE_COMMITS = { baseCommit: V1.iteration.headCommit, headCommit: V2.iteration.headCommit };

function pill(initialOpen = false) {
    return (
        <SnapshotPill
            label={LABEL}
            menu={{ rows: ROWS, viewing: VIEWING, now: GALLERY_NOW, onSelect: () => undefined, initialOpen }}
        />
    );
}

/** Full diff of a slice: a "slice …" pill, read-only with a slice reason, no threads or notes. */
function SliceState() {
    const session = useMemo(() => createSessionStore({ initial: { view: 'diff', filter: 'all', viewing: VIEWING } }), []);
    const threadStore = useMemo(() => createThreadStore([], new Set(SLICE.files.map((file) => file.fileId))), []);
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: SLICE.files });
        for (const file of SLICE.files) {
            created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
        return created;
    }, []);

    return (
        <ReadOnlyIterationProvider readOnly reason={SLICE_READ_ONLY_REASON}>
            <div className="gallery__viewport">
                <BannerSlot sources={READ_ONLY_BANNER} />
                <DiffWorkspace
                    pr={V2.pr}
                    diff={SLICE}
                    lenses={{ ownership: null, extra: [] }}
                    prKey="fixture-medium"
                    session={session}
                    store={store}
                    threadStore={threadStore}
                    threadNow={GALLERY_NOW}
                    slice={SLICE_COMMITS}
                    headerAside={pill()}
                    parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                    loadContent={() => Promise.resolve(null)}
                    onSetViewed={() => Promise.resolve(0)}
                />
            </div>
        </ReadOnlyIterationProvider>
    );
}

const READ_ONLY_BANNER: readonly BannerSource[] = [
    {
        id: 'read-only-iteration',
        priority: BANNER_PRIORITY.readOnlyIteration,
        active: () => true,
        render: () => (
            <ReadOnlyIterationBanner
                label={LABEL}
                createdAt={V1.iteration.createdAt}
                now={GALLERY_NOW}
                gone={false}
                onCurrent={() => undefined}
            />
        ),
    },
];

/** Full diff screens rendered by the view itself: empty slice and slice loading. */
function SliceFrameState({ diff, skeleton = false }: { diff: PrDiff | null; skeleton?: boolean }) {
    const session = useMemo(() => createSessionStore({ initial: { view: 'diff', filter: 'all', viewing: VIEWING } }), []);
    return (
        <div className="gallery__viewport">
            <FullDiffView
                token="gallery"
                prKey="fixture-medium"
                session={session}
                pr={V2.pr}
                diff={diff}
                diffError={null}
                lenses={null}
                lensesError={null}
                progress={null}
                progressError={null}
                progressWriter={null}
                store={null}
                threadStore={null}
                agentConnected={false}
                onAskSelection={() => undefined}
                isSelectionPending={() => false}
                onSelectionAnchorChange={() => undefined}
                slice={SLICE_COMMITS}
                onActiveIteration={() => undefined}
                // The gallery skips the 200 ms wait: the skeleton is the subject of this state.
                skeletonDelayMs={skeleton ? 0 : SKIP_SKELETON_MS}
                headerAside={pill()}
            />
        </div>
    );
}

/** An empty slice needs no skeleton because it never reaches data loading. */
const SKIP_SKELETON_MS = 200;

export const M4_T12_STATES: readonly RouteGalleryState[] = [
    {
        id: 'iterations-slice',
        title: 'inter-iteration slice: full diff v1 → v2, read-only',
        render: () => <SliceState />,
    },
    {
        id: 'iterations-slice-route',
        title: 'slice: Route tab explains why there is no route',
        render: () => (
            <ReadOnlyIterationProvider readOnly reason={SLICE_READ_ONLY_REASON}>
                <div className="gallery__viewport">
                    <BannerSlot sources={READ_ONLY_BANNER} />
                    <IterationWithoutRoute
                        commit={V2.iteration.headCommit}
                        slice={SLICE_COMMITS}
                        onReadDiff={() => undefined}
                    />
                </div>
            </ReadOnlyIterationProvider>
        ),
    },
    {
        id: 'iterations-slice-overview',
        title: 'slice: Overview tab explains why there are no cards',
        render: () => (
            <ReadOnlyIterationProvider readOnly reason={SLICE_READ_ONLY_REASON}>
                <div className="gallery__viewport">
                    <BannerSlot sources={READ_ONLY_BANNER} />
                    <SliceWithoutOverview slice={SLICE_COMMITS} onReadDiff={() => undefined} />
                </div>
            </ReadOnlyIterationProvider>
        ),
    },
    {
        id: 'iterations-slice-empty',
        title: 'empty slice: no changes between iterations',
        render: () => <SliceFrameState diff={{ ...SLICE, files: [] }} />,
    },
    {
        id: 'iterations-slice-loading',
        title: 'calculating slice: 3 skeleton cards and a notice about the slow host response',
        render: () => <SliceFrameState diff={null} skeleton />,
    },
];
