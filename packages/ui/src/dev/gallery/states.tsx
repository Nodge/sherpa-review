import { fixtureIteration } from '@sherpa/fixtures';
import type { UiTask, WorkerStatus } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { agentPillView } from '../../components/agent-pill-view.js';
import { useT } from '../../i18n/index.js';
import { reconnectCommand } from '../../components/reconnect-command.js';
import { ThemeToggle } from '../../components/theme-toggle.tsx';
import { AgentPill, TopBar } from '../../components/top-bar.tsx';
import { breadcrumbFor } from '../../pr-key.js';
import type { ViewId } from '../../session/views.js';
import { UI_VERSION } from '../../version.js';
import { DIFF_STATES } from './diff-states.tsx';
import { SYNTAX_STATES } from './syntax-states.tsx';
import { FULL_DIFF_STATES } from './full-diff-states.tsx';
import { REVIEW_COMPLETION_STATES } from './review-completion-states.tsx';
import { OVERVIEW_STATES } from './overview-states.tsx';
import { ROUTE_STATES } from './route-states.tsx';
import { ROUTE_COVERAGE_STATES } from './route-coverage-states.tsx';
import { ROUTE_PRESET_STATES } from './route-presets-states.tsx';
import { ROUTE_DIGEST_STATES } from './route-digest-states.tsx';
import { ROUTE_GENERATION_STATES } from './route-generation-states.tsx';
import { ROUTE_BADGE_STATES } from './route-badges-states.tsx';
import { ROUTE_LONG_PATH_STATES } from './route-long-paths-states.tsx';
import { FILTER_STATES } from './filters-states.tsx';
import { COMMENT_COMPOSER_STATES } from './comment-composer-states.tsx';
import { ROUTE_REBUILD_STATES } from './route-rebuild-states.tsx';
import { PR_COMMENTS_STATES } from './pr-comments-states.tsx';
import { LINE_COMMENT_STATES } from './line-comments-states.tsx';
import { ROUTE_STOP_FAILURE_STATES } from './route-stop-failure-states.tsx';
import { SELECTION_POPOVER_STATES } from './selection-popover-states.tsx';
import { CHAT_PANEL_STATES } from './chat-panel-states.tsx';
import { AGENT_NOTE_STATES } from './agent-notes-states.tsx';
import { AGENT_NOTE_DRAFT_STATES } from './agent-note-draft-states.tsx';
import { AGENT_ASK_DIFF_STATES, AGENT_ASK_ROUTE_STATES } from './agent-ask-states.tsx';
import { ITERATION_SECOND_PASS_STATES } from './iterations-second-pass-states.tsx';
import { ITERATION_SNAPSHOT_STATES } from './iterations-snapshots-states.tsx';
import { ITERATION_PINNED_THREAD_STATES } from './iterations-pinned-threads-states.tsx';
import { ITERATION_LOST_NOTE_STATES } from './iterations-lost-notes-states.tsx';
import { ITERATION_SLICE_STATES } from './iterations-slice-states.tsx';
import { SHORTCUT_STATES } from './shortcuts-states.tsx';
import { ROUTE_LOCALE_STATES } from './route-locale-states.tsx';
import { ONBOARDING_STATES } from './onboarding-states.tsx';
import { UPDATE_TOAST_STATES } from './update-toast-states.tsx';
import { LIMIT_STATES } from './limits-states.tsx';
import { DRAFT_BUFFER_STATES } from './draft-buffer-states.tsx';
import { DISCUSSION_STATES } from './discussion-states.tsx';
import { FILE_MENU_STATES } from './file-menu-states.tsx';
import { REVIEW_BAR_CHAT_DOCK_STATES } from './review-bar-chat-dock-states.tsx';
import { IMAGE_VIEWER_STATES } from './image-viewer-states.tsx';
import { PALETTE_STATES } from './palette-states.tsx';
import { TokenSwatches, TypographyScale } from './tokens-showcase.tsx';

/**
 * Gallery state registry: each state renders deterministically, without a server
 * or token, using `@sherpa/fixtures` fixtures.
 *
 * To add a state, add one entry to this array.
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

const ITERATION_STATES = [
    ...ITERATION_SECOND_PASS_STATES,
    ...ITERATION_SNAPSHOT_STATES,
    ...ITERATION_PINNED_THREAD_STATES,
    ...ITERATION_LOST_NOTE_STATES,
    ...ITERATION_SLICE_STATES,
];

export const GALLERY_STATES: readonly GalleryState[] = [
    ...OVERVIEW_STATES.filter((state) => state.id === START_STATE_ID),
    ...AGENT_STATES.map((state) => ({
        id: `agent-${state.id}`,
        group: 'Agent indicator',
        title: state.title,
        render: () => <AgentPillState worker={state.worker} tasks={state.tasks} />,
    })),
    {
        id: 'top-bar',
        group: 'Top bar',
        title: 'complete, fixture PR',
        render: () => <TopBarState />,
    },
    {
        id: 'theme-toggle',
        group: 'Top bar',
        title: 'light and dark themes',
        render: () => <ThemeToggle />,
    },
    ...OVERVIEW_STATES.filter((state) => state.id !== START_STATE_ID),
    ...REVIEW_COMPLETION_STATES,
    ...SHORTCUT_STATES,
    ...DRAFT_BUFFER_STATES,
    ...REVIEW_BAR_CHAT_DOCK_STATES,
    ...FILTER_STATES.map((state) => ({
        id: state.id,
        group: 'Filters',
        title: state.title,
        render: state.render,
    })),
    ...COMMENT_COMPOSER_STATES.map((state) => ({
        id: state.id,
        group: 'Comment composer',
        title: state.title,
        render: state.render,
    })),
    ...PR_COMMENTS_STATES.map((state) => ({
        id: state.id,
        group: 'PR comments',
        title: state.title,
        render: state.render,
    })),
    ...LINE_COMMENT_STATES.map((state) => ({
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
    ...SYNTAX_STATES.map((state) => ({
        id: state.id,
        group: 'Syntax highlighting',
        title: state.title,
        render: state.render,
    })),
    ...SELECTION_POPOVER_STATES.map((state) => ({
        id: state.id,
        group: 'Selection popover',
        title: state.title,
        render: state.render,
    })),
    ...CHAT_PANEL_STATES.map((state) => ({
        id: state.id,
        group: 'Agent chat',
        title: state.title,
        render: state.render,
    })),
    ...AGENT_NOTE_STATES.map((state) => ({
        id: state.id,
        group: 'Agent notes',
        title: state.title,
        render: state.render,
    })),
    ...AGENT_NOTE_DRAFT_STATES.map((state) => ({
        id: state.id,
        group: 'Agent notes',
        title: state.title,
        render: state.render,
    })),
    ...[...FULL_DIFF_STATES, ...AGENT_ASK_DIFF_STATES].map((state) => ({
        id: state.id,
        group: 'Full diff',
        title: state.title,
        render: state.render,
    })),
    ...[
        ...ROUTE_STATES,
        ...ROUTE_COVERAGE_STATES,
        ...ROUTE_PRESET_STATES,
        ...ROUTE_DIGEST_STATES,
        ...ROUTE_GENERATION_STATES,
        ...ROUTE_BADGE_STATES,
        ...ROUTE_LONG_PATH_STATES,
        ...ROUTE_REBUILD_STATES,
        ...ROUTE_STOP_FAILURE_STATES,
        ...AGENT_ASK_ROUTE_STATES,
    ].map((state) => ({
        id: state.id,
        group: 'Route',
        title: state.title,
        render: state.render,
    })),
    ...ITERATION_STATES.map((state) => ({
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
    ...ONBOARDING_STATES.map((state) => ({
        id: state.id,
        group: 'Onboarding',
        title: state.title,
        render: state.render,
    })),
    ...UPDATE_TOAST_STATES.map((state) => ({
        id: state.id,
        group: 'Update',
        title: state.title,
        render: state.render,
    })),
    ...ROUTE_LOCALE_STATES.map((state) => ({
        id: state.id,
        group: 'Route language',
        title: state.title,
        render: state.render,
    })),
    ...LIMIT_STATES.map((state) => ({
        id: state.id,
        group: 'Limits and reduced functionality',
        title: state.title,
        render: state.render,
    })),
    ...DISCUSSION_STATES.map((state) => ({
        id: state.id,
        group: 'Discussion on Overview',
        title: state.title,
        render: state.render,
    })),
    ...FILE_MENU_STATES.map((state) => ({
        id: state.id,
        group: 'Files',
        title: state.title,
        render: state.render,
    })),
    ...IMAGE_VIEWER_STATES.map((state) => ({
        id: state.id,
        group: 'Images',
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

function AgentPillState({ worker, tasks }: { worker: WorkerStatus; tasks: readonly UiTask[] }) {
    const t = useT();
    return (
        <AgentPill view={agentPillView(worker, tasks, t)} reconnectCommand={reconnectCommand('fixture-medium')} />
    );
}

/** Gallery tabs are interactive, so their selected states can be compared. */
function TopBarState() {
    const t = useT();
    const [view, setView] = useState<ViewId>('route');

    return (
        <TopBar
            version={UI_VERSION}
            breadcrumb={MEDIUM_BREADCRUMB}
            agent={agentPillView(CONNECTED, [], t)}
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
