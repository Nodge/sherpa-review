import { fixtureIteration } from '@sherpa/fixtures';
import type { Lens, PrMeta, UiReviewLensesResponse } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { useT } from '../../i18n/index.js';
import { agentPillView } from '../../components/agent-pill-view.js';
import { AuditScopeBanner } from '../../components/audit-banner.tsx';
import type { BannerSource } from '../../components/banner-slot.tsx';
import { BannerSlot } from '../../components/banner-slot.tsx';
import { reconnectCommand } from '../../components/reconnect-command.js';
import { AgentPill } from '../../components/top-bar.tsx';
import { buildFileFilters, filterFiles, filterStats, findAuditFilter } from '../../filters/lens-filters.js';
import { createSessionStore } from '../../session/session-store.js';
import { RouteActionErrorBanner } from '../../views/route/generation-card.tsx';
import { ViewFrame } from '../../views/view-frames.tsx';

const DATA = fixtureIteration('medium');
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
        zones: null,
        audit: null,
    }),
    available: false,
    paths: [],
    note: 'Could not determine your ownership zone from CODEOWNERS.',
    zones: DATA.ownership?.zones?.map((zone) => ({ ...zone, mine: false })) ?? null,
};

const PREFIX_FALLBACK_OWNERSHIP: Lens | null =
    DATA.ownership === null ? null : { ...DATA.ownership, zones: null };

export interface OverviewGalleryState {
    readonly id: string;
    readonly group: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const OVERVIEW_STATES: readonly OverviewGalleryState[] = [
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
            <ViewState view="overview" lenses={{ ownership: UNAVAILABLE_OWNERSHIP, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }} />
        ),
    },
    {
        id: 'overview-ownership-prefix-fallback',
        group: 'Overview and Route',
        title: 'Overview: no zones, fallback prefix matching',
        render: () => (
            <ViewState
                view="overview"
                lenses={{ ownership: PREFIX_FALLBACK_OWNERSHIP, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
            />
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
        id: 'banner-two-notices',
        group: 'Banners',
        title: '2 banners and +1 notification',
        render: () => <BannerState />,
    },
    {
        id: 'agent-reconnect-popover',
        group: 'Agent indicator',
        title: 'reconnect popover',
        render: () => <AgentReconnectState />,
    },
];

function ViewState({
    view,
    lenses = { ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource: 'CODEOWNERS' },
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

/** Slot with 2 active sources: action failure at the top, audit scope under "+1". */
function AgentReconnectState() {
    const t = useT();
    return (
        <div className="gallery__viewport gallery-agent-popover">
            <AgentPill
                view={agentPillView(DISCONNECTED, [], t)}
                reconnectCommand={reconnectCommand(PR_KEY)}
                defaultOpen
            />
        </div>
    );
}

function BannerState() {
    const t = useT();
    const filters = buildFileFilters({
        files: DATA.diff.files,
        ownership: DATA.ownership,
        extra: DATA.extraLenses,
        t,
    });
    const audit = findAuditFilter(filters);
    if (audit === null) {
        return null;
    }
    const stats = filterStats(DATA.diff.files, audit);
    const paths = filterFiles(DATA.diff.files, audit).map((file) => file.path);
    const sources: readonly BannerSource[] = [
        {
            id: 'route-action-error',
            priority: 350,
            active: () => true,
            render: () => (
                <RouteActionErrorBanner message="This PR has no host adapter, so there is no data to build a route from." />
            ),
        },
        {
            id: 'audit-scope',
            priority: 100,
            active: () => true,
            render: () => (
                <AuditScopeBanner
                    filter={audit}
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
