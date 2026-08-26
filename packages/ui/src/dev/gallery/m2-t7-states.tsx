import { fileContentOf, fixtureData, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, UiFileProgress } from '@sherpa/protocol';
import { useMemo } from 'react';

import type { ReviewCompletion } from '../../components/review-action-bar.tsx';
import { ReviewComplete } from '../../components/review-complete.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { buildCoverageStrip } from '../../route/coverage-model.js';
import { buildRouteModel, stopSeenRanges } from '../../route/route-model.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { CoverageStrip } from '../../views/route/coverage-strip.tsx';
import { RouteWorkspace } from '../../views/route/route-view.tsx';
import type { RouteGalleryState } from './m2-t6-states.tsx';

/**
 * Coverage strip and stop progress states (M2-T7). Everything is calculated synchronously from the `medium`
 * fixture: the strip counts are the same 862 / 196 / 327 / 305 / 34 as in the model tests.
 */

const DATA = fixtureData('medium');
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');

function readySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
}

function models(): Map<string, ReturnType<typeof parseFileDiff>> {
    return new Map(DATA.diff.files.map((file) => [file.fileId, parseFileDiff(toParseRequest(file))]));
}

function routeModel() {
    return buildRouteModel({ snapshot: readySnapshot(), files: DATA.diff.files, models: models() });
}

/** A bar with fixture counts, using the same input as the route view. */
function StripState({ full = false, loading = false }: { full?: boolean; loading?: boolean }) {
    const model = useMemo(() => {
        const built = routeModel();
        const totals = full
            ? {
                  ...built.totals,
                  covered: built.totals.changed,
                  uncovered: 0,
                  byTier: { ...built.totals.byTier, low: built.totals.byTier.low + 34, other: 0 },
              }
            : built.totals;
        return buildCoverageStrip({ totals, entries: built.entries });
    }, [full]);

    return (
        <div className="gallery__viewport">
            <div style={{ padding: '30px', maxWidth: '1100px' }}>
                <CoverageStrip
                    model={loading ? null : model}
                    loading={loading ? { kind: 'plan', ready: 3, total: 7 } : null}
                    viewedStops={loading ? 0 : 3}
                    totalStops={7}
                />
            </div>
        </div>
    );
}

/**
 * A route with partially viewed stops: seen ranges of marked stops are already stored
 * in progress, so chips show both `read` and `partial`.
 */
function ViewedRouteState({ stopIds }: { stopIds: readonly string[] }) {
    const session = useMemo(() => createSessionStore({ initial: { view: 'route', filter: 'all' } }), []);
    const parsed = useMemo(() => models(), []);
    const progress = useMemo<UiFileProgress[]>(() => {
        const built = buildRouteModel({ snapshot: readySnapshot(), files: DATA.diff.files, models: parsed });
        const byFile = new Map<string, UiFileProgress>();
        for (const entry of built.entries) {
            if (!stopIds.includes(entry.view.stop.id)) {
                continue;
            }
            for (const range of stopSeenRanges(entry)) {
                const record = byFile.get(range.fileId) ?? { fileId: range.fileId, viewed: false, seenRanges: [] };
                byFile.set(range.fileId, {
                    ...record,
                    seenRanges: [...record.seenRanges, { side: range.side, start: range.start, end: range.end }],
                });
            }
        }
        return [...byFile.values()];
    }, [parsed, stopIds]);
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: DATA.diff.files, storage: null, progress });
        for (const [fileId, model] of parsed) {
            created.setModel(fileId, model);
        }
        return created;
    }, [parsed, progress]);
    const threadStore = useMemo(
        () => createThreadStore(DATA.threads, new Set(DATA.diff.files.map((file) => file.fileId))),
        [],
    );

    return (
        <div className="gallery__viewport">
            <RouteWorkspace
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
                snapshot={readySnapshot()}
                session={session}
                store={store}
                threadStore={threadStore}
                threadNow={GALLERY_NOW}
                initialStopViewed={stopIds}
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={(fileId) => {
                    const file = DATA.diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(file === undefined ? null : fileContentOf(file));
                }}
                onOpenInEditor={() => Promise.resolve('the gallery does not open an editor')}
                onSetViewed={() => Promise.resolve(0)}
                onSetStopViewed={() => Promise.resolve(0)}
            />
        </div>
    );
}

const ROUTE_COMPLETION: ReviewCompletion = {
    verdict: 'ship',
    prId: DATA.pr.id,
    headCommit: DATA.diff.headCommit,
    hostName: 'FixtureHost',
    publishedComments: 2,
    publishedReplies: 1,
    progress: { filesSeen: 18, filesTotal: 18, linesSeen: 862, linesTotal: 862, percentSeen: 100 },
    route: { stopsTotal: 7, stopsViewed: 7, otherViewed: true, uncoveredLines: 34 },
    openThreads: 0,
    firstOpenThreadId: null,
};

export const M2_T7_STATES: readonly RouteGalleryState[] = [
    {
        id: 'coverage-strip-ready',
        title: 'coverage strip: 862 lines, tiers 196/327/305, 34 uncovered',
        render: () => <StripState />,
    },
    {
        id: 'coverage-strip-full',
        title: 'coverage bar: 100% explained (no hatching or third clause)',
        render: () => <StripState full />,
    },
    {
        id: 'coverage-strip-loading',
        title: 'coverage bar: route generating, "coverage known after the plan"',
        render: () => <StripState loading />,
    },
    {
        id: 'route-partially-viewed',
        title: 'route: two stops viewed, partials appear in chips',
        render: () => <ViewedRouteState stopIds={['s01', 's03']} />,
    },
    {
        id: 'review-complete-route',
        title: 'Review complete with route line counts',
        render: () => (
            <div className="gallery__viewport">
                <ReviewComplete
                    completion={ROUTE_COMPLETION}
                    onOpenThread={() => undefined}
                    onOpenFullDiff={() => undefined}
                />
            </div>
        ),
    },
];
