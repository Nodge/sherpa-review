import type { PrMeta } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { agentPillView } from './agent-pill-view.js';
import { breadcrumbFor } from '../pr-key.js';
import { AgentPill, TopBar } from './top-bar.tsx';
import { createT } from '../i18n/index.js';

const t = createT('en');

const PR: PrMeta = {
    id: '4821',
    url: 'https://github.com/quillmart/quillmart/pull/4821',
    title: 'Order editing window',
    author: { login: 'alice', displayName: null, bot: false },
    fromBranch: 'alice/edit-window',
    toBranch: 'main',
    state: 'open',
    statusLabel: 'review_in_progress',
    checks: 'passed',
    updatedAt: '2026-08-24T06:00:00.000Z',
    capabilities: { stickyShip: true, fileViewedSync: true, fileContent: true, commentIssues: true, commentResolve: true, editPublished: true, iterations: false, blobs: false },
    verdicts: [],
    viewer: { login: 'alice', displayName: null, bot: false },
};

function topBar(pr: typeof PR | null): string {
    return renderToStaticMarkup(
        <TopBar
            version="0.0.0"
            breadcrumb={breadcrumbFor('github-quillmart--quillmart--4821', pr)}
            agent={agentPillView({ kind: 'never' }, [], t)}
            reconnectCommand="/sherpa github-quillmart--quillmart--4821"
            chatOpen={false}
            onToggleChat={() => undefined}
            view="overview"
            onSelectView={() => undefined}
            onOpenSearch={() => undefined}
            agentConnected
            onReplayTour={() => undefined}
            feedback={{ available: true, reason: null }}
            feedbackContext={{
                uiVersion: '0.0.0',
                prKey: 'github-quillmart--quillmart--4821',
                view: 'overview',
                routePhase: 'ready',
                worker: { kind: 'never' },
            }}
            onSendFeedback={() =>
                Promise.resolve({
                    outcome: 'created',
                    issueKey: '#1',
                    issueUrl: 'https://github.com/quillmart/quillmart/issues/1',
                    message: null,
                })
            }
        />,
    );
}

describe('top bar', () => {
    it('renders the Feedback button after search', () => {
        const html = topBar(PR);

        expect(html).toContain('class="ghost-button search-button"');
        expect(html).toContain('class="ghost-button feedback-button"');
        expect(html.indexOf('search-button')).toBeLessThan(html.indexOf('feedback-button'));
    });
});

describe('top bar brandcrumb', () => {
    it('last segment links to the PR on the host', () => {
        expect(topBar(PR)).toContain(
            '<a class="top-bar__breadcrumb-item" href="https://github.com/quillmart/quillmart/pull/4821">PR 4821</a>',
        );
    });

    it('uses fallback text from the PR key before metadata arrives', () => {
        const html = topBar(null);

        expect(html).toContain('<span class="top-bar__breadcrumb-item">PR 4821</span>');
        expect(html).not.toContain('<a class="top-bar__breadcrumb-item"');
    });
});

describe('agent indicator popover', () => {
    it('opens the reconnect command for never with the disconnected tone', () => {
        const html = renderToStaticMarkup(
            <AgentPill
                view={agentPillView({ kind: 'never' }, [], t)}
                reconnectCommand="/sherpa fixture-medium"
                defaultOpen
            />,
        );

        expect(html).toContain('Connect the agent');
        expect(html).toContain('/sherpa fixture-medium');
    });

    it('explains agent disconnection: the reader remains fully functional', () => {
        const html = renderToStaticMarkup(
            <AgentPill
                view={agentPillView({ kind: 'never' }, [], t)}
                reconnectCommand="/sherpa fixture-medium"
                defaultOpen
            />,
        );

        expect(html).toContain('The reader works in full');
        expect(html).toContain('The AI areas stay read-only.');
    });

    it('connected agent has no reconnect popover or old chat placeholder', () => {
        const html = renderToStaticMarkup(
            <AgentPill
                view={agentPillView(
                    {
                        kind: 'connected',
                        workerId: 'w-1',
                        harness: 'claude-code',
                        model: 'opus-5',
                        registeredAt: '2026-08-24T10:30:00.000Z',
                        lastSeenAt: '2026-08-24T11:59:00.000Z',
                    },
                    [], t)}
                reconnectCommand="/sherpa fixture-medium"
                defaultOpen
            />,
        );

        expect(html).not.toContain('The reader works in full');
        expect(html).not.toContain('agent-popover');
    });
});
