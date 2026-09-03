import type { PrDiff, PrMeta, Thread, UiReviewLensesResponse, UiRouteState } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo, useState, useSyncExternalStore } from 'react';

import {
    setReviewThreadResolved,
} from '../api.js';
import { CommandBox } from '../components/command-box.tsx';
import { PrHeader, prHeaderCounts } from '../components/pr-header.tsx';
import { reconnectCommand } from '../components/reconnect-command.js';
import { buildFileFilters, findFilter, PCI_FILTER_ID } from '../filters/lens-filters.js';
import type { SnapshotMenu } from '../iterations/snapshot-picker.tsx';
import { SnapshotsCard } from '../iterations/snapshot-picker.tsx';
import type { SessionStore } from '../session/session-store.js';
import type { ComposerTransport } from '../threads/composer.js';
import { createComposerTransport } from '../threads/transport.js';
import { persistentThreadStore } from '../threads/persistent-store.js';
import { threadResolvedWriterFor } from '../threads/resolved-writer.js';
import type { ThreadActions } from '../threads/thread-list.tsx';
import { OutsideThreads } from '../threads/thread-list.tsx';
import { createThreadStore } from '../threads/store.js';
import type { ThreadStore } from '../threads/store.js';
import { Markdown } from '../markdown/markdown.tsx';
import { provenanceLine, summaryParagraphs } from '../route/generation.js';
import { formatCount, plural, shortCommit } from '../text.js';
import type { ViewId } from '../session/views.js';
import type { OwnershipKind, OwnershipSegment } from './overview-model.js';
import { discussionStats, ownershipSummary } from './overview-model.js';
import { GenerationCard } from './route/generation-card.tsx';
import './view-frames.css';

/**
 * What Overview knows about route generation (README §6–7, SPEC §3). Endpoints come from App:
 * the view does not call endpoints itself, so it can render in the gallery without a server.
 */
export interface RouteGenerationProps {
    readonly route: UiRouteState | null;
    /** Task running for over a minute: "still working" line with cancellation (SPEC §3). */
    readonly longRunning?: boolean;
    readonly cancelling?: boolean;
    readonly retrying?: boolean;
    /** Failure of the endpoint itself (network, server), not generation. */
    readonly actionError?: string | null;
    readonly onRetry?: () => void;
    readonly onCancel?: () => void;
}

export interface ViewFrameProps {
    readonly view: ViewId;
    readonly token?: string;
    readonly prKey: string;
    readonly session: SessionStore;
    /** PR metadata from the snapshot. null means no host or metadata still loading, so the header does not render. */
    readonly pr?: PrMeta | null;
    readonly diff: PrDiff | null;
    readonly lenses: UiReviewLensesResponse | null;
    readonly threads: readonly Thread[] | null;
    readonly reviewHostAvailable: boolean;
    readonly diffLoading?: boolean;
    readonly lensesLoading?: boolean;
    readonly threadsLoading?: boolean;
    readonly diffError?: string | null;
    readonly lensesError?: string | null;
    readonly threadsError?: string | null;
    readonly threadNow?: number;
    readonly threadStore?: ThreadStore;
    readonly generation?: RouteGenerationProps;
    /** Snapshots and iterations for the Overview card (README §6). No data means no card. */
    readonly picker?: Omit<SnapshotMenu, 'initialOpen'>;
    /** Right edge of the PR header: the snapshot pill (README §1). */
    readonly headerAside?: ReactNode;
}

/**
 * Views without a ready route: a prompt (or an explanation for a small PR) on the Route tab
 * and Overview with generation states for Summary and the generation card.
 */
export function ViewFrame(props: ViewFrameProps) {
    if (props.view === 'route') {
        const openDiff = (): void => {
            props.session.setView('diff');
        };
        return props.generation?.route?.smallPr === true ? (
            <SmallPrRoute onReadDiff={openDiff} />
        ) : (
            <RouteInvitation prKey={props.prKey} onReadDiff={openDiff} />
        );
    }
    if (props.view === 'overview') {
        return <OverviewView {...props} />;
    }
    return (
        <main className="view-frame" id="view-diff">
            <h1 className="view-frame__title">Full diff</h1>
        </main>
    );
}

export function RouteInvitation({ prKey, onReadDiff }: { prKey: string; onReadDiff: () => void }) {
    return (
        <main className="route-empty" id="view-route">
            <section className="invitation-card">
                <div className="invitation-card__eyebrow">Route</div>
                <h1 className="invitation-card__title">There is no route for this PR yet</h1>
                <p className="invitation-card__text">
                    Run the skill in your harness to build a route. The full diff is already available without waiting for the agent.
                </p>
                <CommandBox
                    command={reconnectCommand(prKey)}
                    hint="Run in any harness to make this session a worker."
                />
                <button type="button" className="invitation-card__primary" onClick={onReadDiff}>
                    Read the full diff
                </button>
            </section>
        </main>
    );
}

/**
 * The selected iteration has no route (M4-T9). The tab explains this and sends the reviewer
 * to the reader. The route cannot be rebuilt here, as generation targets the active iteration.
 */
export function IterationWithoutRoute({
    commit,
    slice = null,
    onReadDiff,
}: {
    commit: string | null;
    /** The tab is viewing a slice between iterations (M4-T12): it never has a route. */
    slice?: { readonly baseCommit: string; readonly headCommit: string } | null;
    onReadDiff: () => void;
}) {
    return (
        <main className="route-empty" id="view-route">
            <section className="invitation-card">
                <div className="invitation-card__eyebrow">Route</div>
                <h1 className="invitation-card__title">
                    {slice === null ? 'No route for this iteration' : 'No route for a slice'}
                </h1>
                <p className="invitation-card__text">
                    {slice !== null
                        ? 'No route is built for an inter-iteration slice. It shows what is new without AI.'
                        : commit === null
                          ? 'The route is built for the active iteration. This one is read-only.'
                          : `The route is built for the active iteration. Iteration ${commit.slice(0, 7)} is read-only.`}
                </p>
                <button type="button" className="invitation-card__primary" onClick={onReadDiff}>
                    {slice === null ? 'Read the full diff' : 'To the full diff'}
                </button>
            </section>
        </main>
    );
}

/**
 * Overview in a slice between iterations (M4-T12): ownership zones, threads, and progress are calculated using
 * the iteration's `fileId`. The slice uses a different namespace, so this data
 * is never requested for it. Show an explanation and a way out instead of misleading empty cards.
 */
export function SliceWithoutOverview({
    slice,
    onReadDiff,
}: {
    slice: { readonly baseCommit: string; readonly headCommit: string };
    onReadDiff: () => void;
}) {
    return (
        <main className="route-empty" id="view-overview">
            <section className="invitation-card">
                <div className="invitation-card__eyebrow">Overview</div>
                <h1 className="invitation-card__title">No overview for a slice</h1>
                <p className="invitation-card__text">
                    Ownership zones, discussions, and reading progress are calculated for the active iteration. Slice{' '}
                    {shortCommit(slice.baseCommit)} → {shortCommit(slice.headCommit)} only shows what is new in the
                    code.
                </p>
                <button type="button" className="invitation-card__primary" onClick={onReadDiff}>
                    To the full diff
                </button>
            </section>
        </main>
    );
}

/**
 * PR below the route threshold (SPEC §4.1): the tab stays clickable and explains why there is
 * no route. Describe the threshold in words, since its value lives in server config and the UI does not know it.
 */
export function SmallPrRoute({ onReadDiff }: { onReadDiff: () => void }) {
    return (
        <main className="route-empty" id="view-route">
            <section className="invitation-card">
                <div className="invitation-card__eyebrow">Route</div>
                <h1 className="invitation-card__title">Small PR, no route needed</h1>
                <p className="invitation-card__text">
                    The change is below the threshold where a route pays off: reading a couple of files takes less time than
                    building a plan. The server did not schedule generation, so there is no queue or wait.
                </p>
                <button type="button" className="invitation-card__primary" onClick={onReadDiff}>
                    Read the full diff
                </button>
            </section>
        </main>
    );
}

export function OverviewView({
    token,
    prKey,
    session,
    pr = null,
    diff,
    lenses,
    threads,
    reviewHostAvailable,
    diffLoading = false,
    lensesLoading = false,
    threadsLoading = false,
    diffError = null,
    lensesError = null,
    threadsError = null,
    threadNow,
    threadStore: suppliedThreadStore,
    generation,
    picker,
    headerAside,
}: ViewFrameProps) {
    const [segment, setSegment] = useState<OwnershipSegment>('all');
    const sourceThreads = threads ?? EMPTY_THREADS;
    const fileIds = useMemo(() => new Set(diff?.files.map((file) => file.fileId) ?? []), [diff]);
    const localThreadStore = useMemo(() => createThreadStore(sourceThreads, fileIds), [fileIds, sourceThreads]);
    const persistentStore = useMemo(
        () =>
            diff === null
                ? localThreadStore
                : persistentThreadStore(prKey, diff.diffId, sourceThreads, fileIds),
        [diff, fileIds, localThreadStore, prKey, sourceThreads],
    );
    // In the application, App passes the shared persistent store. Overview only subscribes to it.
    const threadStore = suppliedThreadStore ?? persistentStore;

    // The third argument is the same snapshot. Stores are isomorphic, and tests render the view statically.
    const threadSnapshot = useSyncExternalStore(
        threadStore.subscribe,
        threadStore.getSnapshot,
        threadStore.getSnapshot,
    );
    const transport = useMemo<ComposerTransport>(
        () => (token === undefined ? EMPTY_THREAD_TRANSPORT : createComposerTransport(token)),
        [token],
    );
    const resolveThread = useMemo(
        () =>
            token === undefined
                ? EMPTY_RESOLVE
                : (threadId: string, resolved: boolean) => setReviewThreadResolved(token, threadId, resolved),
        [token],
    );
    const resolvedWriter = useMemo(
        () =>
            threadResolvedWriterFor(threadStore, {
                read: (threadId) =>
                    threadStore.getSnapshot().threads.find((thread) => thread.id === threadId)?.resolved ?? false,
                readConfirmed: threadStore.getServerResolved,
                apply: threadStore.setResolved,
                rollback: threadStore.restoreResolved,
                shouldRollback: threadStore.hasResolvedOverride,
                send: resolveThread,
            }),
        [resolveThread, threadStore],
    );
    const threadActions = useMemo<ThreadActions>(
        () => ({ transport, resolve: resolvedWriter.write }),
        [resolvedWriter, transport],
    );
    const [now] = useState(() => threadNow ?? Date.now());
    // Audit scope chip in the header: the same set of lenses that feeds Full diff filters.
    const pci = useMemo(
        () =>
            diff === null || lenses === null
                ? null
                : findFilter(
                      buildFileFilters({ files: diff.files, ownership: lenses.ownership, extra: lenses.extra }),
                      PCI_FILTER_ID,
                  ),
        [diff, lenses],
    );

    const openDiff = (): void => {
        session.setView('diff');
    };
    const openRoute = (): void => {
        session.setView('route');
    };
    const route = generation?.route ?? null;

    return (
        <main className="overview" id="view-overview">
            {pr === null ? null : (
                <PrHeader
                    variant="overview"
                    pr={pr}
                    counts={diff === null ? null : prHeaderCounts(diff)}
                    pci={pci}
                    now={now}
                    {...(headerAside === undefined ? {} : { aside: headerAside })}
                />
            )}
            <div className="overview__grid">
                <div className="overview__main">
                    <SummaryCard prKey={prKey} route={route} onReadDiff={openDiff} />
                    <OwnershipCard
                        diff={diff}
                        ownership={lenses?.ownership ?? null}
                        hostAvailable={reviewHostAvailable}
                        diffLoading={diffLoading}
                        lensesLoading={lensesLoading}
                        diffError={diffError}
                        lensesError={lensesError}
                        segment={segment}
                        onSegment={setSegment}
                        onOpenDiff={openDiff}
                    />
                </div>
                <aside className="overview__rail">
                    {route === null ? null : (
                        <GenerationCard
                            route={route}
                            diffFiles={diff?.files.length ?? null}
                            longRunning={generation?.longRunning ?? false}
                            cancelling={generation?.cancelling ?? false}
                            retrying={generation?.retrying ?? false}
                            actionError={generation?.actionError ?? null}
                            onOpenRoute={openRoute}
                            onOpenDiff={openDiff}
                            onRetry={generation?.onRetry ?? NOOP}
                            onCancel={generation?.onCancel ?? NOOP}
                        />
                    )}
                    <DiscussionCard
                        threads={reviewHostAvailable && threads !== null ? threadSnapshot.threads : null}
                        outside={reviewHostAvailable && threads !== null ? threadSnapshot.outside : EMPTY_THREADS}
                        store={threadStore}
                        actions={threadActions}
                        now={now}
                        loading={reviewHostAvailable && threadsLoading}
                        error={threadsError}
                    />
                    {picker === undefined ? null : (
                        <OverviewCard title="Snapshots">
                            <SnapshotsCard {...picker} />
                        </OverviewCard>
                    )}
                </aside>
            </div>
        </main>
    );
}

/**
 * "Summary" card (README §6–7). Summary arrives whole with the skeleton. The loop has no token
 * streaming (M2-T1 decision), so the reading phase shows no caret, only skeleton bars
 * of fixed height: arriving text does not shift the layout (SPEC §3).
 */
function SummaryCard({
    prKey,
    route,
    onReadDiff,
}: {
    prKey: string;
    route: UiRouteState | null;
    onReadDiff: () => void;
}) {
    const snapshot = route?.snapshot ?? null;
    if (snapshot !== null) {
        return (
            <OverviewCard title="Summary">
                {summaryParagraphs(snapshot.summary).map((paragraph) => (
                    <p key={paragraph} className="overview-card__text">
                        <Markdown text={paragraph} profile="route" />
                    </p>
                ))}
                <p className="summary-card__provenance">{provenanceLine(snapshot)}</p>
            </OverviewCard>
        );
    }

    if (route?.phase === 'reading') {
        return (
            <OverviewCard title="Summary">
                <div className="summary-skeleton" role="status" aria-label="Preparing the PR summary">
                    {SUMMARY_SKELETON.map((row, index) => (
                        <div key={`${row}-${String(index)}`} className={`summary-skeleton__line is-${row}`} />
                    ))}
                </div>
            </OverviewCard>
        );
    }

    if (route?.phase === 'failed') {
        return (
            <OverviewCard title="Summary">
                <p className="overview-card__lead">No summary available.</p>
                <p className="overview-card__text">
                    It arrives with the route skeleton, and generation did not get that far. The full diff is
                    unaffected.
                </p>
            </OverviewCard>
        );
    }

    if (route?.smallPr === true) {
        return (
            <OverviewCard title="Summary">
                <p className="overview-card__lead">Small PR, no route needed.</p>
                <p className="overview-card__text">
                    The change is below the threshold where a route pays off: the agent did not run, so there is no
                    summary.
                </p>
                <button type="button" className="invitation-card__primary" onClick={onReadDiff}>
                    Read the full diff
                </button>
            </OverviewCard>
        );
    }

    return (
        <OverviewCard title="Summary">
            <p className="overview-card__lead">There is no route yet.</p>
            <p className="overview-card__text">Run the skill so the agent can build a route and a short PR description.</p>
            <CommandBox
                command={reconnectCommand(prKey)}
                hint="Run in any harness to make this session a worker."
            />
        </OverviewCard>
    );
}

/** Skeleton bar widths: the last line of a paragraph is shorter, or the block reads like a table. */
const SUMMARY_SKELETON = ['wide', 'wide', 'wide', 'short', 'wide', 'wide', 'mid'] as const;

function OwnershipCard({
    diff,
    ownership,
    hostAvailable,
    diffLoading,
    lensesLoading,
    diffError,
    lensesError,
    segment,
    onSegment,
    onOpenDiff,
}: {
    diff: PrDiff | null;
    ownership: UiReviewLensesResponse['ownership'];
    hostAvailable: boolean;
    diffLoading: boolean;
    lensesLoading: boolean;
    diffError: string | null;
    lensesError: string | null;
    segment: OwnershipSegment;
    onSegment: (segment: OwnershipSegment) => void;
    onOpenDiff: () => void;
}) {
    const files = diff?.files ?? EMPTY_FILES;
    const fallbackNote = hostAvailable
        ? (lensesError ?? 'The host did not provide an ownership zone for this PR.')
        : 'This PR has no review host, so the ownership zone is unavailable.';
    const summary = ownershipSummary(files, ownership, segment, fallbackNote);

    const title = 'Files by ownership zone';
    const header =
        diff !== null && (ownership !== null || !lensesLoading) ? (
            <div className="ownership-card__toolbar">
                <div className="ownership-card__toolbar-row">
                    <h2 className="overview-card__title">{title}</h2>
                    <div className="ownership-card__header">
                        {summary.available
                            ? `CODEOWNERS · ${formatCount(summary.mineFiles)} of ${formatCount(summary.totalFiles)} files · ${formatCount(summary.mineLines)} of ${formatCount(summary.totalLines)} lines are yours`
                            : 'CODEOWNERS · ownership zone unavailable'}
                    </div>
                    <div className="ownership-card__toolbar-spacer" />
                    <div className="ownership-segments" aria-label="Files by ownership zone">
                        <button
                            type="button"
                            aria-pressed={segment === 'mine'}
                            disabled={!summary.available}
                            title={summary.available ? undefined : (summary.note ?? undefined)}
                            onClick={() => {
                                onSegment('mine');
                            }}
                        >
                            My files {formatCount(summary.mineFiles)}
                        </button>
                        <button
                            type="button"
                            aria-pressed={segment === 'all'}
                            onClick={() => {
                                onSegment('all');
                            }}
                        >
                            All {formatCount(summary.totalFiles)}
                        </button>
                    </div>
                </div>
                {summary.note === null ? null : <div className="ownership-card__note">{summary.note}</div>}
            </div>
        ) : undefined;

    return (
        <OverviewCard title={title} header={header} className="ownership-card">
            {diff === null && diffLoading ? (
                <p className="overview-card__empty">Loading diff…</p>
            ) : diff === null ? (
                <p className="overview-card__empty">
                    {diffError ?? 'The diff is unavailable. Files cannot be aggregated yet.'}
                </p>
            ) : ownership === null && lensesLoading ? (
                <p className="overview-card__empty">Loading ownership zone…</p>
            ) : (
                <div className="ownership-list">
                    {summary.groups.map((group) => (
                        <button
                            key={`${group.path}:${group.owner ?? ''}:${group.ownership ?? ''}`}
                            type="button"
                            className="ownership-row"
                            onClick={onOpenDiff}
                        >
                            <span className="ownership-row__main">
                                <span className="ownership-row__path">{group.path}</span>
                                {group.ownership === null ? null : (
                                    <OwnershipChip kind={group.ownership} owner={group.owner} />
                                )}
                                <span className="ownership-row__spacer" />
                                <span className="ownership-row__stats">
                                    {formatCount(group.files)} {plural(group.files, 'file', 'files', 'files')} ·{' '}
                                    {formatCount(group.lines)} {plural(group.lines, 'line', 'lines', 'lines')}
                                </span>
                                <span className="ownership-row__add">+{formatCount(group.additions)}</span>
                                <span className="ownership-row__del">−{formatCount(group.deletions)}</span>
                            </span>
                            <span className="ownership-row__note">{group.note}</span>
                        </button>
                    ))}
                </div>
            )}
        </OverviewCard>
    );
}

function OwnershipChip({ kind, owner }: { kind: OwnershipKind; owner: string | null }) {
    const label =
        kind === 'mine'
            ? owner === null
                ? 'you'
                : `you · ${owner}`
            : kind === 'other'
              ? (owner ?? 'other')
              : kind === 'generated'
                ? 'generated'
                : 'mixed';
    return <span className={`ownership-chip ownership-chip--${kind}`}>{label}</span>;
}

function DiscussionCard({
    threads,
    outside,
    store,
    actions,
    now,
    loading,
    error,
}: {
    threads: readonly Thread[] | null;
    outside: readonly Thread[];
    store: ThreadStore;
    actions: ThreadActions;
    now: number;
    loading: boolean;
    error: string | null;
}) {
    if (threads === null) {
        return (
            <OverviewCard title="Discussion">
                <p className="overview-card__empty">
                    {loading ? 'Loading discussions…' : (error ?? 'No discussions.')}
                </p>
            </OverviewCard>
        );
    }
    const counts = discussionStats(threads);
    return (
        <OverviewCard title="Discussion">
            <div className="discussion-counts">
                <DiscussionCount value={counts.open} label="open" />
                <DiscussionCount value={counts.resolved} label="resolved" />
                <DiscussionCount value={counts.bots} label="from bots" />
            </div>
            {outside.length === 0 ? (
                <p className="overview-card__empty">No PR-level threads or threads outside the diff.</p>
            ) : (
                // Collapsed: the Overview discussion card is a summary, not a feed (dogfooding #5).
                <OutsideThreads threads={outside} store={store} actions={actions} now={now} />
            )}
        </OverviewCard>
    );
}

function DiscussionCount({ value, label }: { value: number; label: string }) {
    return (
        <div className="discussion-count">
            <strong>{formatCount(value)}</strong>
            <span>{label}</span>
        </div>
    );
}

function OverviewCard({
    title,
    header,
    className = '',
    children,
}: {
    title: string;
    header?: ReactNode;
    className?: string;
    children: ReactNode;
}) {
    return (
        <section className={`overview-card${className === '' ? '' : ` ${className}`}`}>
            {header ?? <h2 className="overview-card__title">{title}</h2>}
            {children}
        </section>
    );
}

const NOOP = (): void => undefined;
const EMPTY_FILES: PrDiff['files'] = [];
const EMPTY_THREADS: readonly Thread[] = [];
const EMPTY_THREAD_TRANSPORT: ComposerTransport = {
    save: () => Promise.reject(new Error('draft writing is unavailable in the gallery')),
    update: () => Promise.reject(new Error('draft writing is unavailable in the gallery')),
    delete: () => Promise.reject(new Error('draft writing is unavailable in the gallery')),
};
const EMPTY_RESOLVE = (): Promise<void> => Promise.reject(new Error('resolve is unavailable in the gallery'));
