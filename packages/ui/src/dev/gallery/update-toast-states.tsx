import { fixtureIteration } from '@sherpa/fixtures';
import type { UiUpdate } from '@sherpa/protocol';
import type { ReactNode } from 'react';

import { agentPillView } from '../../components/agent-pill-view.js';
import { reconnectCommand } from '../../components/reconnect-command.js';
import { TopBar } from '../../components/top-bar.tsx';
import { UpdateToast } from '../../components/update-toast.tsx';
import { useT } from '../../i18n/index.js';
import { breadcrumbFor } from '../../pr-key.js';
import { GALLERY_FEEDBACK_ISSUES } from './feedback-channels.js';

/**
 * Update toast and version button in the top bar. The data is static.
 * The gallery renders without a server, so the version check would never run here.
 */

const CURRENT = '0.4.0';
const LATEST = '0.5.0';

/** The server update channel supplies the instructions link. The gallery uses a placeholder. */
const README_URL = 'https://example.com/sherpa/README.md';

const WHATS_NEW = 'Update toast, shortcuts sheet and English UI. The language comes from the agent.';

const WITH_COMMAND: UiUpdate = {
    current: CURRENT,
    latest: LATEST,
    releasedAt: '2026-09-01T09:00:00.000Z',
    whatsNew: WHATS_NEW,
    install: {
        dir: '/Users/x/tools/sherpa',
        command: "cd '/Users/x/tools/sherpa' && sherpa-update",
        readmeUrl: README_URL,
    },
};

const COPY: UiUpdate = {
    ...WITH_COMMAND,
    install: { dir: '/Users/x/tools/sherpa/skill', command: null, readmeUrl: README_URL },
};

/** A channel that supplies neither a command nor an instructions link. */
const COPY_NO_LINK: UiUpdate = {
    ...WITH_COMMAND,
    install: { dir: '/Users/x/tools/sherpa/skill', command: null, readmeUrl: null },
};

/** A channel without an installation directory (npm package) supplies only an instructions link. */
const LINK_ONLY: UiUpdate = {
    ...WITH_COMMAND,
    install: { dir: null, command: null, readmeUrl: README_URL },
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

function UpdateTopBarState() {
    const t = useT();
    return (
        <TopBar
            version={CURRENT}
            update={WITH_COMMAND}
            onOpenUpdate={() => undefined}
            breadcrumb={breadcrumbFor('fixture-medium', MEDIUM.pr)}
            agent={agentPillView(WORKER, [], t)}
            reconnectCommand={reconnectCommand('fixture-medium')}
            chatOpen={false}
            onToggleChat={() => undefined}
            view="route"
            onSelectView={() => undefined}
            onOpenSearch={() => undefined}
            agentConnected
            onReplayTour={() => undefined}
            feedback={GALLERY_FEEDBACK_ISSUES}
            feedbackContext={{
                uiVersion: CURRENT,
                prKey: 'fixture-medium',
                view: 'route',
                routePhase: 'ready',
                worker: WORKER,
            }}
            onSendFeedback={() =>
                Promise.resolve({ outcome: 'created', issueKey: null, issueUrl: null, message: null })
            }
        />
    );
}

export const UPDATE_TOAST_STATES: readonly { readonly id: string; readonly title: string; readonly render: () => ReactNode }[] =
    [
        {
            id: 'update-toast-command',
            title: 'checkout with an update command',
            render: () => (
                <Framed>
                    <UpdateToast update={WITH_COMMAND} onLater={() => undefined} onDismissVersion={() => undefined} />
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
                        update={WITH_COMMAND}
                        onLater={() => undefined}
                        onDismissVersion={() => undefined}
                        howToOpen
                    />
                </Framed>
            ),
        },
        {
            id: 'update-toast-copy-no-link',
            title: 'copy without an instructions link',
            render: () => (
                <Framed>
                    <UpdateToast
                        update={COPY_NO_LINK}
                        onLater={() => undefined}
                        onDismissVersion={() => undefined}
                        howToOpen
                    />
                </Framed>
            ),
        },
        {
            id: 'update-toast-link-only',
            title: 'instructions link only',
            render: () => (
                <Framed>
                    <UpdateToast
                        update={LINK_ONLY}
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
                        update={WITH_COMMAND}
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
            render: () => <UpdateTopBarState />,
        },
    ];
