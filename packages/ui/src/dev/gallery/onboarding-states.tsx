import { fileContentOf, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, Thread, WorkerStatus } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { ChatPanel } from '../../components/chat-panel.tsx';
import { ViewTabs } from '../../components/view-tabs.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import type { TourStepId } from '../../onboarding/index.js';
import { TourLayer, TourScaffold, tourSteps } from '../../onboarding/index.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { RouteReadingView } from '../../views/route/route-generating.tsx';
import { RouteWorkspace } from '../../views/route/route-workspace.tsx';
import { RouteInvitation } from '../../views/view-frames.tsx';
import { FixtureReviewActionBar } from './review-completion-states.tsx';
import type { RouteGalleryState } from './route-states.tsx';

/**
 * Onboarding tour. The frame has real `data-tour` targets: tabs,
 * the `medium` fixture route, agent panel and action panel. The ring and card
 * use the same geometry as the app, and the state is deterministic.
 *
 * No persistence or keyboard handling here: the layer receives the step through props and transitions are no-ops.
 */

const DATA = fixtureIteration('medium');
const GALLERY_NOW = Date.parse('2026-08-31T12:00:00.000Z');

const CONNECTED: WorkerStatus = {
    kind: 'connected',
    workerId: 'gallery-worker',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-08-31T09:00:00.000Z',
    lastSeenAt: '2026-08-31T11:59:00.000Z',
};

function readySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
}

function RouteUnderTour() {
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

    return (
        <RouteWorkspace
            pr={DATA.pr}
            diff={DATA.diff}
            lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
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
            onSetStopFileViewed={() => Promise.resolve(0)}
        />
    );
}

/** The agent panel is the target of step 06. In the app, the step itself opens it. */
function ChatUnderTour() {
    return (
        <ChatPanel
            worker={CONNECTED}
            tasks={[]}
            exchanges={[]}
            notes={[]}
            loading={false}
            error={null}
            reconnectCommand="/sherpa fixture-medium"
            anchor={null}
            focusRequest={0}
            scrollRequest={null}
            onScrollRequestHandled={NOOP}
            onClose={NOOP}
            onRemoveAnchor={NOOP}
            onAsk={() => Promise.reject(new Error('the gallery does not ask the agent'))}
            onCancel={() => Promise.resolve()}
            onRetry={() => Promise.resolve()}
            onNavigate={NOOP}
            onNavigateToNote={NOOP}
            now={GALLERY_NOW}
        />
    );
}

/**
 * State frame: view tabs and the action panel are always present as the targets of steps 07 and 08,
 * and the app displays them at every step too.
 */
function TourFrame({
    stepId,
    withChat = true,
    chatOpen = false,
    children,
}: {
    stepId: TourStepId;
    /** `false` means the agent is disconnected: the chat step is omitted and the counter becomes `/ 07` (§5). */
    withChat?: boolean;
    chatOpen?: boolean;
    children: ReactNode;
}) {
    const steps = tourSteps(withChat);
    const index = steps.findIndex((step) => step.id === stepId);
    const step = steps[index];
    if (step === undefined) {
        throw new Error(`step ${stepId} is missing from this tour pass`);
    }

    return (
        <div className="gallery__viewport tour-gallery">
            <div className="tour-gallery__tabs">
                <ViewTabs view="route" onSelect={NOOP} />
            </div>
            <div className="tour-gallery__body">
                {children}
                {chatOpen ? <ChatUnderTour /> : null}
            </div>
            <FixtureReviewActionBar threads={NO_THREADS} />
            <TourLayer
                step={step}
                index={index}
                total={steps.length}
                epoch={`gallery:${stepId}`}
                onNext={NOOP}
                onBack={NOOP}
                onSkip={NOOP}
            />
        </div>
    );
}

const NOOP = (): void => undefined;
const NO_THREADS: readonly Thread[] = [];

export const ONBOARDING_STATES: readonly RouteGalleryState[] = [
    {
        id: 'tour-step-01-narrative',
        title: 'step 01: narrative column of the first stop',
        render: () => (
            <TourFrame stepId="narrative">
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-step-02-fold',
        title: 'step 02: first low-tier stop fold',
        render: () => (
            <TourFrame stepId="fold">
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-step-03-stopdiff',
        title: 'step 03: diff column of the first stop',
        render: () => (
            <TourFrame stepId="stopdiff">
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-step-04-progress',
        title: 'step 04: viewed stop counter',
        render: () => (
            <TourFrame stepId="progress">
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-step-05-presets',
        title: 'step 05: Triage / Full tour toggle',
        render: () => (
            <TourFrame stepId="presets">
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-step-06-chat',
        title: 'step 06: agent panel, the only step that changes state',
        render: () => (
            <TourFrame stepId="chat" chatOpen>
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-step-07-fulldiff',
        title: 'step 07: Full diff tab (the view stays the same)',
        render: () => (
            <TourFrame stepId="fulldiff">
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-step-08-ship',
        title: 'step 08: action panel, primary action is Start reviewing',
        render: () => (
            <TourFrame stepId="ship">
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-offline-counter',
        title: 'without an agent: chat step omitted, counter / 07',
        render: () => (
            <TourFrame stepId="fulldiff" withChat={false}>
                <RouteUnderTour />
            </TourFrame>
        ),
    },
    {
        id: 'tour-fallback-missing',
        title: 'step target missing from DOM: no ring, card at the bottom center',
        render: () => (
            <TourFrame stepId="narrative">
                <RouteInvitation prKey="fixture-medium" onReadDiff={NOOP} />
            </TourFrame>
        ),
    },
    {
        id: 'tour-scaffold-reading',
        title: 'tour scaffold above the generation skeleton: step 01 on a placeholder',
        render: () => (
            <TourFrame stepId="narrative">
                <RouteReadingView onOpenDiff={NOOP} />
                <TourScaffold />
            </TourFrame>
        ),
    },
    {
        id: 'tour-scaffold-progress',
        title: 'scaffold above the skeleton: step 04 outlines the scaffold bar rather than the one below',
        render: () => (
            <TourFrame stepId="progress">
                <RouteReadingView onOpenDiff={NOOP} />
                <TourScaffold />
            </TourFrame>
        ),
    },
    {
        id: 'tour-scaffold-invitation',
        title: 'tour scaffold above the invitation: step 03 on the placeholder diff column',
        render: () => (
            <TourFrame stepId="stopdiff">
                <RouteInvitation prKey="fixture-medium" onReadDiff={NOOP} />
                <TourScaffold />
            </TourFrame>
        ),
    },
];
