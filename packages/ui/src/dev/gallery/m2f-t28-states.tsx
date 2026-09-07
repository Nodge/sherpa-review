import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, UiRouteFailure } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import type { BannerSource } from '../../components/banner-slot.tsx';
import { BannerSlot } from '../../components/banner-slot.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { GenerationFailedBanner, RouteRegeneratingBanner } from '../../views/route/generation-card.tsx';
import { RouteWorkspace } from '../../views/route/route-workspace.tsx';
import type { RouteGalleryState } from './m2-t6-states.tsx';

const DATA = fixtureIteration('medium');
const GALLERY_NOW = Date.parse('2026-08-31T12:00:00.000Z');

function readySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
}

function rebuildFailure(): UiRouteFailure {
    const failure = routeFixtures('medium')?.states.failed?.failure ?? null;
    if (failure === null) {
        throw new Error('the medium fixture needs a skeleton failure');
    }
    return failure;
}

function RebuildState({ banner }: { banner: ReactNode }) {
    const session = useMemo(() => createSessionStore({ initial: { view: 'route', filter: 'all' } }), []);
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
    const banners = useMemo<BannerSource[]>(
        () => [{ id: 'm2f-t28', priority: 1, active: () => true, render: () => banner }],
        [banner],
    );

    return (
        <div className="gallery__viewport">
            <BannerSlot sources={banners} />
            <RouteWorkspace
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
                snapshot={readySnapshot()}
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
                onFillStop={() => undefined}
            />
        </div>
    );
}

export const M2F_T28_STATES: readonly RouteGalleryState[] = [
    {
        id: 'route-rebuilding-ready',
        title: 'rebuild over ready: old route readable until the new plan arrives',
        render: () => (
            <RebuildState banner={<RouteRegeneratingBanner onCancel={() => undefined} />} />
        ),
    },
    {
        id: 'route-rebuild-failed-ready',
        title: 'rebuild failure over ready: old route with retry above',
        render: () => (
            <RebuildState
                banner={
                    <GenerationFailedBanner
                        message={rebuildFailure().message}
                        rebuilding
                        onRetry={() => undefined}
                    />
                }
            />
        ),
    },
];
