import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { UiRouteState } from '@sherpa/protocol';
import { useMemo } from 'react';

import type { BannerSource } from '../../components/banner-slot.tsx';
import { BannerSlot } from '../../components/banner-slot.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { DiffWorkspace } from '../../views/full-diff.tsx';
import {
    GenerationFailedBanner,
    RouteActionErrorBanner,
    RouteFillingBanner,
} from '../../views/route/generation-card.tsx';
import { RouteFailedView, RouteReadingView } from '../../views/route/route-generating.tsx';
import { RouteWorkspace } from '../../views/route/route-workspace.tsx';
import { ViewFrame } from '../../views/view-frames.tsx';
import type { RouteGalleryState } from './route-states.tsx';

/**
 * Generation states: Overview phases A/B, a partially filled route, generation
 * failure, and a small PR. Data comes from `routeFixtures('medium').states` and `('small')`.
 * No endpoints, a frozen clock. Opening a state always gives the same frame.
 */

const DATA = fixtureIteration('medium');
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');

function routeState(name: 'medium' | 'small', phase: 'reading' | 'filling' | 'failed' | 'none'): UiRouteState {
    const state = routeFixtures(name)?.states[phase] ?? null;
    if (state === null) {
        throw new Error(`fixture ${name} needs route state ${phase}`);
    }
    return state;
}

function OverviewState({ route, longRunning = false }: { route: UiRouteState; longRunning?: boolean }) {
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
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
                threads={DATA.threads}
                threadStore={threadStore}
                threadNow={GALLERY_NOW}
                reviewHostAvailable
                generation={{ route, longRunning }}
            />
        </div>
    );
}

function RouteFillingState({ agentStopped = false }: { agentStopped?: boolean }) {
    const snapshot = routeState('medium', 'filling').snapshot;
    if (snapshot === null) {
        throw new Error('the fixture filling state needs a partial snapshot');
    }
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
        () => [
            {
                id: 'route-filling',
                priority: 150,
                active: () => true,
                render: () => <RouteFillingBanner snapshot={snapshot} onReadDiff={NOOP} />,
            },
        ],
        [snapshot],
    );

    return (
        <div className="gallery__viewport">
            <BannerSlot sources={banners} />
            <RouteWorkspace
                pr={DATA.pr}
                diff={DATA.diff}
                lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses }}
                snapshot={snapshot}
                agentStopped={agentStopped}
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
            />
        </div>
    );
}

/** A small PR: the same `small` fixture in full, from the header note to the empty route tab. */
function SmallPrDiffState() {
    const data = useMemo(() => fixtureIteration('small'), []);
    const session = useMemo(() => createSessionStore({ initial: { view: 'diff', filter: 'all' } }), []);
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: data.diff.files });
        for (const file of data.diff.files) {
            created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
        return created;
    }, [data.diff.files]);
    const threadStore = useMemo(
        () => createThreadStore([], new Set(data.diff.files.map((file) => file.fileId))),
        [data.diff.files],
    );

    return (
        <div className="gallery__viewport">
            <DiffWorkspace
                pr={data.pr}
                diff={data.diff}
                threadStore={threadStore}
                lenses={{ ownership: data.ownership, extra: data.extraLenses }}
                prKey="fixture-small"
                session={session}
                store={store}
                threadNow={GALLERY_NOW}
                smallPr
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={(fileId) => {
                    const file = data.diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(file === undefined ? null : fileContentOf(file));
                }}
                onSetViewed={() => Promise.resolve(0)}
            />
        </div>
    );
}

function SmallPrRouteState() {
    const session = useMemo(() => createSessionStore({ initial: { view: 'route', filter: 'all' } }), []);

    return (
        <div className="gallery__viewport">
            <ViewFrame
                view="route"
                prKey="fixture-small"
                session={session}
                diff={null}
                lenses={null}
                threads={null}
                reviewHostAvailable
                generation={{ route: routeState('small', 'none') }}
            />
        </div>
    );
}

function FailedBannerState() {
    const route = routeState('medium', 'failed');
    const banners = useMemo<BannerSource[]>(
        () => [
            {
                id: 'generation-failed',
                priority: 400,
                active: () => true,
                render: () =>
                    route.failure === null ? null : (
                        <GenerationFailedBanner message={route.failure.message} onRetry={NOOP} />
                    ),
            },
        ],
        [route.failure],
    );

    return (
        <div className="gallery__viewport">
            <BannerSlot sources={banners} />
        </div>
    );
}

/** An endpoint failed where no reason card exists: "Build route" from the palette. */
function ActionErrorBannerState() {
    const banners = useMemo<BannerSource[]>(
        () => [
            {
                id: 'route-action-error',
                priority: 350,
                active: () => true,
                render: () => (
                    <RouteActionErrorBanner message="This PR has no host adapter, so there is no source for building a route." />
                ),
            },
        ],
        [],
    );

    return (
        <div className="gallery__viewport">
            <BannerSlot sources={banners} />
        </div>
    );
}

function FailedRouteState() {
    const failure = routeState('medium', 'failed').failure;
    if (failure === null) {
        throw new Error('the fixture failed state needs a failure reason');
    }
    return (
        <div className="gallery__viewport">
            {/* Raw output is expanded: the gallery frame must also show the monospace block. */}
            <RouteFailedView failure={failure} initialRawShown onRetry={NOOP} onOpenDiff={NOOP} />
        </div>
    );
}

const NOOP = (): void => undefined;

export const ROUTE_GENERATION_STATES: readonly RouteGalleryState[] = [
    {
        id: 'overview-reading',
        title: 'Overview phase A: Summary skeleton, spinner, three progress rows',
        render: () => <OverviewState route={routeState('medium', 'reading')} />,
    },
    {
        id: 'overview-reading-long',
        title: 'Overview phase A over a minute: "still working" with cancellation',
        render: () => <OverviewState route={routeState('medium', 'reading')} longRunning />,
    },
    {
        id: 'overview-filling',
        title: 'Overview phase B: segment bar, plan list, counter from the snapshot',
        render: () => <OverviewState route={routeState('medium', 'filling')} />,
    },
    {
        id: 'overview-failed',
        title: 'Overview: compact red failure card',
        render: () => <OverviewState route={routeState('medium', 'failed')} />,
    },
    {
        id: 'route-reading',
        title: 'Route in the reading phase: three unnumbered "— / ?" placeholders',
        render: () => <RouteReadingView onOpenDiff={NOOP} />,
    },
    {
        id: 'route-filling',
        title: 'Route partially filled: skeletons in plan slots + banner',
        render: () => <RouteFillingState />,
    },
    {
        id: 'route-agent-died',
        title: 'Agent died during generation: filled content marked',
        render: () => <RouteFillingState agentStopped />,
    },
    {
        id: 'route-failed',
        title: 'Generation failed: reason, retry, and raw output',
        render: () => <FailedRouteState />,
    },
    {
        id: 'banner-generation-failed',
        title: 'Generation failure banner (outside the route tab)',
        render: () => <FailedBannerState />,
    },
    {
        id: 'banner-route-action-error',
        title: 'Generation endpoint failed: reason in the banner area',
        render: () => <ActionErrorBannerState />,
    },
    {
        id: 'route-small',
        title: 'Small PR: explanation on the route tab',
        render: () => <SmallPrRouteState />,
    },
    {
        id: 'diff-small-note',
        title: 'Small PR: unobtrusive note in the full diff header',
        render: () => <SmallPrDiffState />,
    },
];
