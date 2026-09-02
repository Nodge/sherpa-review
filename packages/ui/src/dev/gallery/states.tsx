import { fixtureIteration } from '@sherpa/fixtures';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { agentPillView } from '../../components/agent-pill-view.js';
import { reconnectCommand } from '../../components/reconnect-command.js';
import { AgentPill, TopBar } from '../../components/top-bar.tsx';
import { breadcrumbFor } from '../../pr-key.js';
import type { ViewId } from '../../session/views.js';
import { UI_VERSION } from '../../version.js';
import { DIFF_STATES } from './diff-states.tsx';
import { FULL_DIFF_STATES } from './full-diff-states.tsx';
import { M1_T14_STATES } from './m1-t14-states.tsx';
import { M1_T15_STATES } from './m1-t15-states.tsx';
import { M2_T6_STATES } from './m2-t6-states.tsx';
import { M2_T7_STATES } from './m2-t7-states.tsx';
import { M2_T8_STATES } from './m2-t8-states.tsx';
import { M2_T9_STATES } from './m2-t9-states.tsx';
import { M2_T10_STATES } from './m2-t10-states.tsx';
import { M2_T11_STATES } from './m2-t11-states.tsx';
import { M2F_T17_STATES } from './m2f-t17-states.tsx';
import { M2F_T23_STATES } from './m2f-t23-states.tsx';
import { M2F_T28_STATES } from './m2f-t28-states.tsx';
import { M2F_T24_STATES } from './m2f-t24-states.tsx';
import { M2F_T25_STATES } from './m2f-t25-states.tsx';
import { M2F_T43_STATES } from './m2f-t43-states.tsx';
import { M3_T5_STATES } from './m3-t5-states.tsx';
import { M3_T6_STATES } from './m3-t6-states.tsx';
import { M3_T7_STATES } from './m3-t7-states.tsx';
import { M3_T8_STATES } from './m3-t8-states.tsx';
import { M3_T9_DIFF_STATES, M3_T9_ROUTE_STATES } from './m3-t9-states.tsx';
import { M4_T2_STATES } from './m4-t2-states.tsx';
import { M4_T8_STATES } from './m4-t8-states.tsx';
import { M4_T9_STATES } from './m4-t9-states.tsx';
import { M4_T10_STATES } from './m4-t10-states.tsx';
import { M4_T11_STATES } from './m4-t11-states.tsx';
import { M4_T12_STATES } from './m4-t12-states.tsx';
import { PALETTE_STATES } from './palette-states.tsx';
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

const MEDIUM = fixtureIteration('medium');

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
            { ...TASK, id: 1, status: 'leased', heldByWorker: true },
            { ...TASK, id: 2, status: 'queued', heldByWorker: false },
        ],
    },
    {
        id: 'failed',
        title: 'last task failed',
        worker: CONNECTED,
        tasks: [{ ...TASK, id: 1, status: 'failed', heldByWorker: false }],
    },
    {
        id: 'disconnected',
        title: 'disconnected',
        worker: { ...CONNECTED, kind: 'disconnected' },
        tasks: [],
    },
] as const;

/** Fixture PR breadcrumb: host from the PR key, last segment linked using metadata. */
const MEDIUM_BREADCRUMB = breadcrumbFor('fixture-medium', MEDIUM.pr);

/**
 * The gallery opens with what the reviewer sees when the app starts (`DEFAULT_VIEW` is Overview),
 * so this state comes first. The rest of the registry order stays the same.
 */
const START_STATE_ID = 'overview-ownership';

const M4_ITERATION_STATES = [
    ...M4_T8_STATES,
    ...M4_T9_STATES,
    ...M4_T10_STATES,
    ...M4_T11_STATES,
    ...M4_T12_STATES,
];
const M4_ITERATION_IDS = new Set(M4_ITERATION_STATES.map((state) => state.id));

export const GALLERY_STATES: readonly GalleryState[] = [
    ...M1_T15_STATES.filter((state) => state.id === START_STATE_ID),
    ...AGENT_STATES.map((state) => ({
        id: `agent-${state.id}`,
        group: 'Agent pill',
        title: state.title,
        render: () => (
            <AgentPill
                view={agentPillView(state.worker, state.tasks)}
                reconnectCommand={reconnectCommand('fixture-medium')}
            />
        ),
    })),
    {
        id: 'top-bar',
        group: 'Top bar',
        title: 'complete, fixture PR',
        render: () => <TopBarState />,
    },
    ...M1_T15_STATES.filter((state) => state.id !== START_STATE_ID),
    ...M1_T14_STATES,
    ...M2F_T17_STATES.map((state) => ({
        id: state.id,
        group: 'Filters',
        title: state.title,
        render: state.render,
    })),
    ...M2F_T23_STATES.map((state) => ({
        id: state.id,
        group: 'Comment composer',
        title: state.title,
        render: state.render,
    })),
    ...M2F_T24_STATES.map((state) => ({
        id: state.id,
        group: 'PR comments',
        title: state.title,
        render: state.render,
    })),
    ...M2F_T25_STATES.map((state) => ({
        id: state.id,
        group: 'Line comments',
        title: state.title,
        render: state.render,
    })),
    ...DIFF_STATES.map((state) => ({
        id: state.id,
        group: 'Diff',
        title: state.title,
        render: state.render,
    })),
    ...M3_T5_STATES.map((state) => ({
        id: state.id,
        group: 'Selection popover',
        title: state.title,
        render: state.render,
    })),
    ...M3_T6_STATES.map((state) => ({
        id: state.id,
        group: 'Agent chat',
        title: state.title,
        render: state.render,
    })),
    ...M3_T7_STATES.map((state) => ({
        id: state.id,
        group: 'Agent notes',
        title: state.title,
        render: state.render,
    })),
    ...M3_T8_STATES.map((state) => ({
        id: state.id,
        group: 'Agent notes',
        title: state.title,
        render: state.render,
    })),
    ...[...FULL_DIFF_STATES, ...M3_T9_DIFF_STATES].map((state) => ({
        id: state.id,
        group: 'Full diff',
        title: state.title,
        render: state.render,
    })),
    ...[
        ...M2_T6_STATES,
        ...M2_T7_STATES,
        ...M2_T8_STATES,
        ...M2_T9_STATES,
        ...M2_T10_STATES,
        ...M2_T11_STATES,
        ...M2F_T28_STATES,
        ...M2F_T43_STATES,
        ...M3_T9_ROUTE_STATES,
    ].map((state) => ({
        id: state.id,
        group: 'Route',
        title: state.title,
        render: state.render,
    })),
    // T2 placeholders stay until real states take their ids (T8–T11 have already taken theirs).
    ...[...M4_ITERATION_STATES, ...M4_T2_STATES.filter((state) => !M4_ITERATION_IDS.has(state.id))].map((state) => ({
        id: state.id,
        group: 'Iterations',
        title: state.title,
        render: state.render,
    })),
    ...PALETTE_STATES.map((state) => ({
        id: state.id,
        group: 'Command palette',
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
            reconnectCommand={reconnectCommand('fixture-medium')}
            chatOpen={false}
            onToggleChat={() => undefined}
            view={view}
            onSelectView={setView}
            onOpenSearch={() => undefined}
            feedback={{ available: true, reason: null }}
            feedbackContext={{
                uiVersion: UI_VERSION,
                prKey: 'fixture-medium',
                view,
                routePhase: 'ready',
                worker: CONNECTED,
            }}
            onSendFeedback={() =>
                Promise.resolve({
                    outcome: 'created',
                    issueKey: '#123456',
                    issueUrl: 'https://github.com/quillmart/quillmart/issues/123456',
                    message: null,
                })
            }
        />
    );
}
