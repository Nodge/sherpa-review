import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { agentPillView } from './agent-pill-view.js';
import { breadcrumbFor } from '../pr-key.js';
import { AgentPill, TopBar } from './top-bar.tsx';

const PR = {
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
    capabilities: { stickyShip: true, fileViewedSync: true, fileContent: true },
} as const;

function topBar(pr: typeof PR | null): string {
    return renderToStaticMarkup(
        <TopBar
            version="0.0.0"
            breadcrumb={breadcrumbFor('github-quillmart--quillmart--4821', pr)}
            agent={agentPillView({ kind: 'never' }, [])}
            reconnectCommand="/sherpa github-quillmart--quillmart--4821"
            view="overview"
            onSelectView={() => undefined}
            onOpenSearch={() => undefined}
        />,
    );
}

describe('top bar brandcrumb', () => {
    it('last segment links to the PR on the host', () => {
        expect(topBar(PR)).toContain(
            '<a class="top-bar__breadcrumb-item" href="https://github.com/quillmart/quillmart/pull/4821">PR 4821</a>',
        );
    });

    it('uses a text fallback from the PR key before metadata arrives', () => {
        const html = topBar(null);

        expect(html).toContain('<span class="top-bar__breadcrumb-item">PR 4821</span>');
        expect(html).not.toContain('<a class="top-bar__breadcrumb-item"');
    });
});

describe('agent pill popover', () => {
    it('opens the reconnect command for never with the disconnected tone', () => {
        const html = renderToStaticMarkup(
            <AgentPill
                view={agentPillView({ kind: 'never' }, [])}
                reconnectCommand="/sherpa fixture-medium"
                defaultOpen
            />,
        );

        expect(html).toContain('Connect the agent');
        expect(html).toContain('/sherpa fixture-medium');
        expect(html).not.toContain('Agent chat will appear here in M3.');
    });
});
