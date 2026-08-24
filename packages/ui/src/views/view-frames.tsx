import type { PrDiff, Thread, UiReviewLensesResponse } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo, useState, useSyncExternalStore } from 'react';

import {
    deleteReviewDraft,
    saveReviewDraft,
    setReviewThreadResolved,
    updateReviewDraft,
} from '../api.js';
import { CommandBox } from '../components/command-box.tsx';
import { reconnectCommand } from '../components/reconnect-command.js';
import type { SessionStore } from '../session/session-store.js';
import type { ComposerTransport } from '../threads/composer.js';
import { persistentThreadStore } from '../threads/persistent-store.js';
import { threadResolvedWriterFor } from '../threads/resolved-writer.js';
import type { ThreadActions } from '../threads/thread-list.tsx';
import { OutsideThreads } from '../threads/thread-list.tsx';
import { createThreadStore } from '../threads/store.js';
import type { ThreadStore } from '../threads/store.js';
import { formatCount, plural } from '../text.js';
import type { ViewId } from '../session/views.js';
import type { OwnershipKind, OwnershipSegment } from './overview-model.js';
import { discussionStats, ownershipSummary } from './overview-model.js';
import './view-frames.css';

export interface ViewFrameProps {
    readonly view: ViewId;
    readonly token?: string;
    readonly prKey: string;
    readonly session: SessionStore;
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
}

/** M1 views without generated content: Route invitation and Overview built only from host data. */
export function ViewFrame(props: ViewFrameProps) {
    if (props.view === 'route') {
        return (
            <RouteInvitation
                prKey={props.prKey}
                onReadDiff={() => {
                    props.session.setView('diff');
                }}
            />
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

export function OverviewView({
    token,
    prKey,
    session,
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

    const threadSnapshot = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot);
    const transport = useMemo<ComposerTransport>(
        () =>
            token === undefined
                ? EMPTY_THREAD_TRANSPORT
                : {
                      save: (draft) => saveReviewDraft(token, draft),
                      update: (commentId, body) => updateReviewDraft(token, commentId, body),
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

    return (
        <main className="overview" id="view-overview">
            <div className="overview__main">
                <SummaryPlaceholder prKey={prKey} />
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
                    onOpenDiff={() => {
                        session.setView('diff');
                    }}
                />
            </div>
            <aside className="overview__rail">
                <DiscussionCard
                    threads={reviewHostAvailable && threads !== null ? threadSnapshot.threads : null}
                    outside={reviewHostAvailable && threads !== null ? threadSnapshot.outside : EMPTY_THREADS}
                    store={threadStore}
                    actions={threadActions}
                    now={now}
                    loading={reviewHostAvailable && threadsLoading}
                    error={threadsError}
                />
                <OverviewCard title="Snapshots">
                    <p className="overview-card__empty">No snapshots yet. They will appear with the first route.</p>
                </OverviewCard>
            </aside>
        </main>
    );
}

function SummaryPlaceholder({ prKey }: { prKey: string }) {
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

    return (
        <OverviewCard title="Files by ownership" className="ownership-card">
            {diff === null && diffLoading ? (
                <p className="overview-card__empty">Loading diff…</p>
            ) : diff === null ? (
                <p className="overview-card__empty">
                    {diffError ?? 'The diff is unavailable. Files cannot be aggregated yet.'}
                </p>
            ) : ownership === null && lensesLoading ? (
                <p className="overview-card__empty">Loading ownership zone…</p>
            ) : (
                <>
                    <div className="ownership-card__toolbar">
                        <div>
                            <div className="ownership-card__header">
                                {summary.available
                                    ? `CODEOWNERS · ${formatCount(summary.mineFiles)} of ${formatCount(summary.totalFiles)} files · ${formatCount(summary.mineLines)} of ${formatCount(summary.totalLines)} lines are yours`
                                    : 'CODEOWNERS · ownership zone unavailable'}
                            </div>
                            {summary.note === null ? null : <div className="ownership-card__note">{summary.note}</div>}
                        </div>
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
                                My zone {formatCount(summary.mineFiles)}
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
                    <div className="ownership-list">
                        {summary.groups.map((group) => (
                            <button key={group.path} type="button" className="ownership-row" onClick={onOpenDiff}>
                                <span className="ownership-row__path">{group.path}</span>
                                {group.ownership === null ? null : <OwnershipChip kind={group.ownership} />}
                                <span className="ownership-row__stats">
                                    {formatCount(group.files)} {plural(group.files, 'file', 'files', 'files')} ·{' '}
                                    {formatCount(group.lines)} {plural(group.lines, 'line', 'lines', 'lines')}
                                </span>
                                <span className="ownership-row__delta">
                                    <span className="ownership-row__add">+{formatCount(group.additions)}</span>/
                                    <span className="ownership-row__del">−{formatCount(group.deletions)}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                </>
            )}
        </OverviewCard>
    );
}

function OwnershipChip({ kind }: { kind: OwnershipKind }) {
    const labels: Readonly<Record<OwnershipKind, string>> = {
        mine: 'your zone',
        other: 'other',
        mixed: 'mixed',
        generated: 'generated',
    };
    return <span className={`ownership-chip ownership-chip--${kind}`}>{labels[kind]}</span>;
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
                <OutsideThreads threads={outside} store={store} actions={actions} now={now} defaultOpen />
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
    className = '',
    children,
}: {
    title: string;
    className?: string;
    children: ReactNode;
}) {
    return (
        <section className={`overview-card${className === '' ? '' : ` ${className}`}`}>
            <h2 className="overview-card__title">{title}</h2>
            {children}
        </section>
    );
}

const EMPTY_FILES: PrDiff['files'] = [];
const EMPTY_THREADS: readonly Thread[] = [];
const EMPTY_THREAD_TRANSPORT: ComposerTransport = {
    save: () => Promise.reject(new Error('draft writing is unavailable in the gallery')),
    update: () => Promise.reject(new Error('draft writing is unavailable in the gallery')),
    delete: () => Promise.reject(new Error('draft writing is unavailable in the gallery')),
};
const EMPTY_RESOLVE = (): Promise<void> => Promise.reject(new Error('resolve is unavailable in the gallery'));
