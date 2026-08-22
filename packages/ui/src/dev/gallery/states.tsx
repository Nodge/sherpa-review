import { fixtureData } from '@sherpa/fixtures';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { agentPillView } from '../../components/agent-pill-view.js';
import { AgentPill, TopBar } from '../../components/top-bar.tsx';
import type { ViewId } from '../../session/views.js';
import { UI_VERSION } from '../../version.js';
import { ViewFrame } from '../../views/view-frames.tsx';
import { DIFF_STATES } from './diff-states.tsx';
import { TokenSwatches, TypographyScale } from './tokens-showcase.tsx';

/**
 * Gallery state registry, the second layer of visual acceptance (CLAUDE.md). Each state
 * renders deterministically, without a server or token, using `@sherpa/fixtures`.
 *
 * Add a state by adding an entry to this array. Each subsequent UI task
 * adds its own states.
 */
export interface GalleryState {
    readonly id: string;
    readonly group: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

const MEDIUM = fixtureData('medium');

const CONNECTED = {
    kind: 'connected',
    workerId: 'w-fixture',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-08-21T10:30:00.000Z',
    lastSeenAt: '2026-08-21T11:59:00.000Z',
} as const;

const TASK = {
    type: 'echo',
    priority: 'interactive',
    attempt: 1,
    instructions: 'echo',
    progressText: null,
    result: null,
    failReason: null,
    createdAt: '2026-08-21T11:00:00.000Z',
    updatedAt: '2026-08-21T11:00:00.000Z',
} as const;

const AGENT_STATES = [
    { id: 'connected', title: 'connected', worker: CONNECTED, tasks: [] },
    {
        id: 'working',
        title: 'working',
        worker: CONNECTED,
        tasks: [
            { ...TASK, id: 1, status: 'leased' },
            { ...TASK, id: 2, status: 'queued' },
        ],
    },
    {
        id: 'failed',
        title: 'last task failed',
        worker: CONNECTED,
        tasks: [{ ...TASK, id: 1, status: 'failed' }],
    },
    {
        id: 'disconnected',
        title: 'disconnected',
        worker: { ...CONNECTED, kind: 'disconnected' },
        tasks: [],
    },
] as const;

/** Fixture PR breadcrumb: the host from its URL, followed by the number. */
const MEDIUM_BREADCRUMB = [new URL(MEDIUM.pr.url).hostname, `PR ${MEDIUM.pr.id}`];

const VIEW_STATES: readonly { id: ViewId; title: string }[] = [
    { id: 'overview', title: 'Overview' },
    { id: 'route', title: 'Route' },
    { id: 'diff', title: 'Full diff' },
];

export const GALLERY_STATES: readonly GalleryState[] = [
    ...AGENT_STATES.map((state) => ({
        id: `agent-${state.id}`,
        group: 'Agent pill',
        title: state.title,
        render: () => <AgentPill view={agentPillView(state.worker, state.tasks)} />,
    })),
    {
        id: 'top-bar',
        group: 'Top bar',
        title: 'complete, fixture PR',
        render: () => <TopBarState />,
    },
    ...VIEW_STATES.map((view) => ({
        id: `view-${view.id}`,
        group: 'View frames',
        title: view.title,
        render: () => <ViewFrame view={view.id} />,
    })),
    ...DIFF_STATES.map((state) => ({
        id: state.id,
        group: 'Diff',
        title: state.title,
        render: state.render,
    })),
    {
        id: 'tokens-swatches',
        group: 'Tokens',
        title: 'swatches',
        render: () => <TokenSwatches />,
    },
    {
        id: 'tokens-typography',
        group: 'Tokens',
        title: 'typography scale',
        render: () => <TypographyScale />,
    },
];

/** Gallery tabs are interactive, so their selected states can be compared. */
function TopBarState() {
    const [view, setView] = useState<ViewId>('route');

    return (
        <TopBar
            version={UI_VERSION}
            breadcrumb={MEDIUM_BREADCRUMB}
            agent={agentPillView(CONNECTED, [])}
            view={view}
            onSelectView={setView}
        />
    );
}
