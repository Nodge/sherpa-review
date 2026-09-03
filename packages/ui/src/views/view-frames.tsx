import type { PrDiff, PrMeta, Thread, UiReviewLensesResponse, UiRouteState } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo, useState, useSyncExternalStore } from 'react';

import {
    deleteReviewDraft,
    saveReviewDraft,
    setReviewThreadResolved,
    updateReviewDraft,
} from '../api.js';
import { CommandBox } from '../components/command-box.tsx';
import { PrHeader, prHeaderCounts } from '../components/pr-header.tsx';
import { reconnectCommand } from '../components/reconnect-command.js';
import { buildFileFilters, findFilter, PCI_FILTER_ID } from '../filters/lens-filters.js';
import { shortCommit, useFormat, useT } from '../i18n/index.js';
import type { SnapshotMenu } from '../iterations/snapshot-picker.tsx';
import { SnapshotsCard } from '../iterations/snapshot-picker.tsx';
import type { SessionStore } from '../session/session-store.js';
import type { ComposerTransport } from '../threads/composer.js';
import { persistentThreadStore } from '../threads/persistent-store.js';
import { threadResolvedWriterFor } from '../threads/resolved-writer.js';
import type { ThreadActions } from '../threads/thread-list.tsx';
import { OutsideThreads } from '../threads/thread-list.tsx';
import { createThreadStore } from '../threads/store.js';
import type { ThreadStore } from '../threads/store.js';
import { Markdown } from '../markdown/markdown.tsx';
import { provenanceLine, summaryParagraphs } from '../route/generation.js';
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
    return <FullDiffFrame />;
}

function FullDiffFrame() {
    const t = useT();
    return (
        <main className="view-frame" id="view-diff">
            <h1 className="view-frame__title">{t('view.diff')}</h1>
        </main>
    );
}

export function RouteInvitation({ prKey, onReadDiff }: { prKey: string; onReadDiff: () => void }) {
    const t = useT();
    return (
        <main className="route-empty" id="view-route">
            <section className="invitation-card">
                <div className="invitation-card__eyebrow">{t('view.route')}</div>
                <h1 className="invitation-card__title">{t('route.invitation.title')}</h1>
                <p className="invitation-card__text">{t('route.invitation.text')}</p>
                <CommandBox
                    command={reconnectCommand(prKey)}
                    hint={t('command.hint')}
                    actionLabel={t('command.copy')}
                />
                <button type="button" className="invitation-card__primary" onClick={onReadDiff}>
                    {t('route.readFullDiff')}
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
    const t = useT();
    return (
        <main className="route-empty" id="view-route">
            <section className="invitation-card">
                <div className="invitation-card__eyebrow">{t('view.route')}</div>
                <h1 className="invitation-card__title">
                    {slice === null ? t('route.iteration.title') : t('route.slice.title')}
                </h1>
                <p className="invitation-card__text">
                    {slice !== null
                        ? t('route.slice.text')
                        : commit === null
                          ? t('route.iteration.text')
                          : t('route.iteration.textCommit', shortCommit(commit))}
                </p>
                <button type="button" className="invitation-card__primary" onClick={onReadDiff}>
                    {slice === null ? t('route.readFullDiff') : t('route.toFullDiff')}
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
    const t = useT();
    return (
        <main className="route-empty" id="view-overview">
            <section className="invitation-card">
                <div className="invitation-card__eyebrow">{t('view.overview')}</div>
                <h1 className="invitation-card__title">{t('overview.slice.title')}</h1>
                <p className="invitation-card__text">
                    {t('overview.slice.text', shortCommit(slice.baseCommit), shortCommit(slice.headCommit))}
                </p>
                <button type="button" className="invitation-card__primary" onClick={onReadDiff}>
                    {t('route.toFullDiff')}
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
    const t = useT();
    return (
        <main className="route-empty" id="view-route">
            <section className="invitation-card">
                <div className="invitation-card__eyebrow">{t('view.route')}</div>
                <h1 className="invitation-card__title">{t('route.smallPr.title')}</h1>
                <p className="invitation-card__text">{t('route.smallPr.text')}</p>
                <button type="button" className="invitation-card__primary" onClick={onReadDiff}>
                    {t('route.readFullDiff')}
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
    const t = useT();
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
        () =>
            token === undefined
                ? EMPTY_THREAD_TRANSPORT
                : {
                      save: (draft) => saveReviewDraft(token, draft),
                      update: (commentId, body, issue) => updateReviewDraft(token, commentId, body, issue),
                      delete: (commentId) => deleteReviewDraft(token, commentId),
                  },
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

    // Empty PR (SPEC §4.1): empty Overview cards would mislead. There is nothing to derive ownership zones, discussions or progress
    // from. The action panel lives one level above, so ship remains available.
    if (diff !== null && diff.files.length === 0) {
        return (
            <main className="route-empty" id="view-overview">
                <section className="invitation-card">
                    <div className="invitation-card__eyebrow">{t('view.overview')}</div>
                    <h1 className="invitation-card__title">{t('emptyPr.title')}</h1>
                    <p className="invitation-card__text">{t('emptyPr.text')}</p>
                </section>
            </main>
        );
    }

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
                        <OverviewCard title={t('overview.snapshots')}>
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
    const t = useT();
    const snapshot = route?.snapshot ?? null;
    if (snapshot !== null) {
        return (
            <OverviewCard title={t('overview.summary')}>
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
            <OverviewCard title={t('overview.summary')}>
                <div className="summary-skeleton" role="status" aria-label={t('overview.summary.loading')}>
                    {SUMMARY_SKELETON.map((row, index) => (
                        <div key={`${row}-${String(index)}`} className={`summary-skeleton__line is-${row}`} />
                    ))}
                </div>
            </OverviewCard>
        );
    }

    if (route?.phase === 'failed') {
        return (
            <OverviewCard title={t('overview.summary')}>
                <p className="overview-card__lead">{t('overview.summary.failed.lead')}</p>
                <p className="overview-card__text">{t('overview.summary.failed.text')}</p>
            </OverviewCard>
        );
    }

    if (route?.smallPr === true) {
        return (
            <OverviewCard title={t('overview.summary')}>
                <p className="overview-card__lead">{t('overview.summary.smallPr.lead')}</p>
                <p className="overview-card__text">{t('overview.summary.smallPr.text')}</p>
                <button type="button" className="invitation-card__primary" onClick={onReadDiff}>
                    {t('route.readFullDiff')}
                </button>
            </OverviewCard>
        );
    }

    return (
        <OverviewCard title={t('overview.summary')}>
            <p className="overview-card__lead">{t('overview.summary.noRoute.lead')}</p>
            <p className="overview-card__text">{t('overview.summary.noRoute.text')}</p>
            <CommandBox command={reconnectCommand(prKey)} hint={t('command.hint')} actionLabel={t('command.copy')} />
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
    const t = useT();
    const format = useFormat();
    const files = diff?.files ?? EMPTY_FILES;
    const fallbackNote = hostAvailable
        ? (lensesError ?? t('overview.ownership.noZone'))
        : t('overview.ownership.noHost');
    const summary = ownershipSummary(files, ownership, segment, fallbackNote);

    const title = t('overview.ownership.title');
    const header =
        diff !== null && (ownership !== null || !lensesLoading) ? (
            <div className="ownership-card__toolbar">
                <div className="ownership-card__toolbar-row">
                    <h2 className="overview-card__title">{title}</h2>
                    <div className="ownership-card__header">
                        {summary.available
                            ? t(
                                  'overview.ownership.stats',
                                  summary.mineFiles,
                                  summary.totalFiles,
                                  summary.mineLines,
                                  summary.totalLines,
                              )
                            : t('overview.ownership.statsUnavailable')}
                    </div>
                    <div className="ownership-card__toolbar-spacer" />
                    <div className="ownership-segments" aria-label={t('overview.ownership.segments')}>
                        <button
                            type="button"
                            aria-pressed={segment === 'mine'}
                            disabled={!summary.available}
                            title={summary.available ? undefined : (summary.note ?? undefined)}
                            onClick={() => {
                                onSegment('mine');
                            }}
                        >
                            {t('overview.ownership.mine', summary.mineFiles)}
                        </button>
                        <button
                            type="button"
                            aria-pressed={segment === 'all'}
                            onClick={() => {
                                onSegment('all');
                            }}
                        >
                            {t('overview.ownership.all', summary.totalFiles)}
                        </button>
                    </div>
                </div>
                {summary.note === null ? null : <div className="ownership-card__note">{summary.note}</div>}
            </div>
        ) : undefined;

    return (
        <OverviewCard title={title} header={header} className="ownership-card">
            {diff === null && diffLoading ? (
                <p className="overview-card__empty">{t('overview.diff.loading')}</p>
            ) : diff === null ? (
                <p className="overview-card__empty">{diffError ?? t('overview.diff.unavailable')}</p>
            ) : ownership === null && lensesLoading ? (
                <p className="overview-card__empty">{t('overview.ownership.loading')}</p>
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
                                    {t('overview.ownership.rowStats', group.files, group.lines)}
                                </span>
                                <span className="ownership-row__add">+{format.count(group.additions)}</span>
                                <span className="ownership-row__del">−{format.count(group.deletions)}</span>
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
    const t = useT();
    // The owner from CODEOWNERS is the host's zone name, used as is without translation.
    const label =
        kind === 'mine'
            ? owner === null
                ? t('overview.ownership.chip.mine')
                : t('overview.ownership.chip.mineOwner', owner)
            : kind === 'other'
              ? (owner ?? t('overview.ownership.chip.other'))
              : kind === 'generated'
                ? t('overview.ownership.chip.generated')
                : t('overview.ownership.chip.mixed');
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
    const t = useT();
    if (threads === null) {
        return (
            <OverviewCard title={t('overview.discussion')}>
                <p className="overview-card__empty">
                    {loading ? t('overview.discussion.loading') : (error ?? t('overview.discussion.empty'))}
                </p>
            </OverviewCard>
        );
    }
    const counts = discussionStats(threads);
    return (
        <OverviewCard title={t('overview.discussion')}>
            <div className="discussion-counts">
                <DiscussionCount value={counts.open} label={t('overview.discussion.open')} />
                <DiscussionCount value={counts.resolved} label={t('overview.discussion.resolved')} />
                <DiscussionCount value={counts.bots} label={t('overview.discussion.bots')} />
            </div>
            {outside.length === 0 ? (
                <p className="overview-card__empty">{t('overview.discussion.noOutside')}</p>
            ) : (
                // Collapsed: the Overview discussion card is a summary, not a feed (dogfooding #5).
                <OutsideThreads threads={outside} store={store} actions={actions} now={now} />
            )}
        </OverviewCard>
    );
}

function DiscussionCount({ value, label }: { value: number; label: string }) {
    const format = useFormat();
    return (
        <div className="discussion-count">
            <strong>{format.count(value)}</strong>
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
const GALLERY_WRITE = 'Sherpa gallery: writing drafts is not available';
const EMPTY_THREAD_TRANSPORT: ComposerTransport = {
    save: () => Promise.reject(new Error(GALLERY_WRITE)),
    update: () => Promise.reject(new Error(GALLERY_WRITE)),
    delete: () => Promise.reject(new Error(GALLERY_WRITE)),
};
const EMPTY_RESOLVE = (): Promise<void> =>
    Promise.reject(new Error('Sherpa gallery: resolving threads is not available'));
