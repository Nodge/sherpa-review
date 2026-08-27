import { fixtureData } from '@sherpa/fixtures';
import type { Lens, PrMeta, UiReviewLensesResponse } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { agentPillView } from '../../components/agent-pill-view.js';
import { AuditScopeBanner } from '../../components/audit-banner.tsx';
import type { BannerSource } from '../../components/banner-slot.tsx';
import { BannerSlot } from '../../components/banner-slot.tsx';
import { DisconnectedBanner } from '../../components/disconnected-banner.tsx';
import { reconnectCommand } from '../../components/reconnect-command.js';
import { AgentPill } from '../../components/top-bar.tsx';
import { buildFileFilters, filterFiles, filterStats, findFilter, PCI_FILTER_ID } from '../../filters/lens-filters.js';
import { createSessionStore } from '../../session/session-store.js';
import { ViewFrame } from '../../views/view-frames.tsx';

const DATA = fixtureData('medium');
const PR_KEY = 'fixture-medium';
const DISCONNECTED = {
    kind: 'disconnected',
    workerId: 'w-fixture',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-08-24T10:30:00.000Z',
    lastSeenAt: '2026-08-24T11:59:00.000Z',
} as const;

const UNAVAILABLE_OWNERSHIP: Lens = {
    ...(DATA.ownership ?? {
        id: 'mine',
        label: 'My files',
        paths: [],
    }),
    available: false,
    paths: [],
    note: 'The review host could not determine your ownership zone from CODEOWNERS.',
};

export interface M1T15GalleryState {
    readonly id: string;
    readonly group: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const M1_T15_STATES: readonly M1T15GalleryState[] = [
    {
        id: 'route-no-route',
        group: 'Overview and Route',
        title: 'Route: no route yet',
        render: () => <ViewState view="route" />,
    },
    {
        id: 'overview-ownership',
        group: 'Overview and Route',
        title: 'Overview: ownership available',
        render: () => <ViewState view="overview" />,
    },
    {
        id: 'overview-ownership-unavailable',
        group: 'Overview and Route',
        title: 'Overview: ownership zone unavailable',
        render: () => (
            <ViewState view="overview" lenses={{ ownership: UNAVAILABLE_OWNERSHIP, extra: DATA.extraLenses }} />
        ),
    },
    {
        id: 'overview-checks-failed',
        group: 'Overview and Route',
        title: 'Overview: checks failed',
        render: () => <ViewState view="overview" pr={{ ...DATA.pr, checks: 'failed' }} />,
    },
    {
        id: 'overview-checks-pending',
        group: 'Overview and Route',
        title: 'Overview: checks pending',
        render: () => <ViewState view="overview" pr={{ ...DATA.pr, checks: 'pending' }} />,
    },
    {
        id: 'overview-checks-unknown',
        group: 'Overview and Route',
        title: 'Overview: checks unknown',
        render: () => <ViewState view="overview" pr={{ ...DATA.pr, checks: null }} />,
    },
    {
        id: 'overview-pr-meta-pending',
        group: 'Overview and Route',
        title: 'Overview: PR metadata has not arrived yet',
        render: () => <ViewState view="overview" pr={null} />,
    },
    {
        id: 'banner-agent-disconnected',
        group: 'Banners',
        title: 'agent disconnected',
        render: () => <BannerState both={false} />,
    },
    {
        id: 'banner-two-notices',
        group: 'Banners',
        title: '2 banners and +1 notification',
        render: () => <BannerState both />,
    },
    {
        id: 'agent-reconnect-popover',
        group: 'Agent pill',
        title: 'reconnect popover',
        render: () => (
            <div className="gallery__viewport gallery-agent-popover">
                <AgentPill
                    view={agentPillView(DISCONNECTED, [])}
                    reconnectCommand={reconnectCommand(PR_KEY)}
                    defaultOpen
                />
            </div>
        ),
    },
];

function ViewState({
    view,
    lenses = { ownership: DATA.ownership, extra: DATA.extraLenses },
    pr = DATA.pr,
}: {
    view: 'overview' | 'route';
    lenses?: UiReviewLensesResponse;
    pr?: PrMeta | null;
}) {
    const session = useMemo(() => createSessionStore({ initial: { view, filter: 'all' } }), [view]);
    return (
        <div className="gallery__viewport">
            <ViewFrame
                view={view}
                prKey={PR_KEY}
                session={session}
                pr={pr}
                diff={DATA.diff}
                lenses={lenses}
                threads={DATA.threads}
                reviewHostAvailable
                // The same fixed "now" keeps both relative time in the PR header
                // and comment times deterministic.
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
            />
        </div>
    );
}

function BannerState({ both }: { both: boolean }) {
    const filters = buildFileFilters({ files: DATA.diff.files, ownership: DATA.ownership, extra: DATA.extraLenses });
    const pci = findFilter(filters, PCI_FILTER_ID);
    if (pci === null) {
        return null;
    }
    const stats = filterStats(DATA.diff.files, pci);
    const paths = filterFiles(DATA.diff.files, pci).map((file) => file.path);
    const sources: readonly BannerSource[] = [
        {
            id: 'agent-disconnected',
            priority: 300,
            active: () => true,
            render: () => <DisconnectedBanner prKey={PR_KEY} />,
        },
        {
            id: 'audit-scope',
            priority: 100,
            active: () => both,
            render: () => (
                <AuditScopeBanner
                    filter={pci}
                    stats={stats}
                    paths={paths}
                    onShowAll={() => undefined}
                    onDismiss={() => undefined}
                />
            ),
        },
    ];
    return (
        <div className="gallery__viewport">
            <BannerSlot sources={sources} />
        </div>
    );
}
