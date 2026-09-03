import { fixtureIteration } from '@sherpa/fixtures';
import type { UiUpdate } from '@sherpa/protocol';
import type { ReactNode } from 'react';

import { agentPillView } from '../../components/agent-pill-view.js';
import { reconnectCommand } from '../../components/reconnect-command.js';
import { TopBar } from '../../components/top-bar.tsx';
import { UpdateToast } from '../../components/update-toast.tsx';
import { breadcrumbFor } from '../../pr-key.js';

/**
 * Update toast and version button in the top bar (M5-T9, task breakdown decision 8). Static data:
 * The gallery renders without a server, so the version check would never run here.
 */

const CURRENT = '0.4.0';
const LATEST = '0.5.0';

const WHATS_NEW = 'Update toast, shortcuts sheet and English UI. The language comes from the agent.';

const SOURCE_CHECKOUT: UiUpdate = {
    current: CURRENT,
    latest: LATEST,
    releasedAt: '2026-09-01T09:00:00.000Z',
    whatsNew: WHATS_NEW,
    install: {
        
        dir: '/Users/alice/projects/quillmart',
        command: "cd '/Users/alice/projects/quillmart' && git pull",
    },
};

const COPY: UiUpdate = {
    ...SOURCE_CHECKOUT,
    install: { kind: 'copy', dir: '/Users/alice/tools/sherpa/skill', command: null },
};

const MEDIUM = fixtureIteration('medium');

const WORKER = {
    kind: 'connected',
    workerId: 'w-fixture',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-08-21T10:30:00.000Z',
    lastSeenAt: '2026-08-21T11:59:00.000Z',
} as const;

/**
 * The gallery toast stays in normal flow within the state card boundaries.
 * `position: fixed` would move it out to the full viewport.
 */
function Framed({ children }: { children: ReactNode }) {
    return <div className="update-toast-frame">{children}</div>;
}

export const M5_T9_STATES: readonly { readonly id: string; readonly title: string; readonly render: () => ReactNode }[] =
    [
        {
            id: 'update-toast-checkout',
            title: 'repository checkout',
            render: () => (
                <Framed>
                    <UpdateToast update={SOURCE_CHECKOUT} onLater={() => undefined} onDismissVersion={() => undefined} />
                </Framed>
            ),
        },
        {
            id: 'update-toast-copy',
            title: 'directory copy',
            render: () => (
                <Framed>
                    <UpdateToast update={COPY} onLater={() => undefined} onDismissVersion={() => undefined} />
                </Framed>
            ),
        },
        {
            id: 'update-toast-how',
            title: '"How to update" expanded',
            render: () => (
                <Framed>
                    <UpdateToast
                        update={SOURCE_CHECKOUT}
                        onLater={() => undefined}
                        onDismissVersion={() => undefined}
                        howToOpen
                    />
                </Framed>
            ),
        },
        {
            id: 'update-toast-no-motion',
            title: 'without an entrance animation',
            render: () => (
                <Framed>
                    <UpdateToast
                        update={SOURCE_CHECKOUT}
                        onLater={() => undefined}
                        onDismissVersion={() => undefined}
                        noMotion
                    />
                </Framed>
            ),
        },
        {
            id: 'update-top-bar-dot',
            title: 'version with an update dot',
            render: () => (
                <TopBar
                    version={CURRENT}
                    update={SOURCE_CHECKOUT}
                    onOpenUpdate={() => undefined}
                    breadcrumb={breadcrumbFor('fixture-medium', MEDIUM.pr)}
                    agent={agentPillView(WORKER, [])}
                    reconnectCommand={reconnectCommand('fixture-medium')}
                    chatOpen={false}
                    onToggleChat={() => undefined}
                    view="route"
                    onSelectView={() => undefined}
                    onOpenSearch={() => undefined}
                    feedback={{ available: true, reason: null }}
                    feedbackContext={{
                        uiVersion: CURRENT,
                        prKey: 'fixture-medium',
                        view: 'route',
                        routePhase: 'ready',
                        worker: WORKER,
                    }}
                    onSendFeedback={() => Promise.resolve({ outcome: 'created', issueKey: null, issueUrl: null, message: null })}
                />
            ),
        },
    ];
