import type { PrDiff, PrMeta, PublishResult, Verdict } from '@sherpa/protocol';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { DiffViewStore } from '../diff-view/store.js';
import { Icon } from '../icons/icon.tsx';
import { useReadOnlyIteration, useReadOnlyReason } from '../iterations/read-only.tsx';
import { useThreadPinContext } from '../iterations/thread-pin.tsx';
import type { ReviewProgressSummary } from '../progress/summary.js';
import {
    commentBodies,
    countDraftComments,
    countPinnedDraftComments,
    countPublishedReplies,
    reviewProgressSummary,
} from '../progress/summary.js';
import { useShortcut } from '../shortcuts/context.tsx';
import type { ViewId } from '../session/views.js';
import { useUiSettings, useUiSettingsStore } from '../settings/context.tsx';
import type { ConnectionState } from '../store.js';
import { formatCount, plural } from '../text.js';
import { closePublishedComposers } from '../threads/composer.js';
import type { ComposerTransport } from '../threads/composer.js';
import type { ThreadStore } from '../threads/store.js';
import { discussionStats } from '../views/overview-model.js';
import { chatOverlaysContent } from './dock.js';
import { PrCommentsModal } from './pr-comments-modal.tsx';
import {
    availableShipMode,
    partialPublicationFailure,
    type PublicationFailure,
    publishConsequence,
    publishDisabledReason,
    requestPublicationFailure,
    type ShipMode,
} from './review-action-model.js';
import './review-action-bar.css';

const SHIP_DESCRIPTION = 'Approves this snapshot only. A new push drops the approval and asks again.';
// The promise in README §5 to revoke by CODEOWNERS zone is absent here. This publishes the regular sticky ship
// of the host. We have no zone-based mechanism (decision log, #36).
const STICKY_DESCRIPTION = 'The approval carries over to later pushes — the host’s own sticky ship.';

/**
 * The route layer in the action bar (SPEC §2.19, README §13): the guardrail counts unviewed
 * stops instead of files, and the review summary has route rows. `null` means no route, as in M1.
 */
export interface RouteProgress {
    /** Route slots in render order, including Other. */
    readonly stopIds: readonly string[];
    readonly otherStopId: string | null;
    /** Lines the model has not placed. `null` means the route view has not been opened yet. */
    readonly uncoveredLines: number | null;
    readonly viewed: ReadonlyMap<string, boolean>;
}

/** Route counts in the review summary, captured at publication time. */
export interface ReviewCompletionRoute {
    readonly stopsTotal: number;
    readonly stopsViewed: number;
    /** "Other" was read as a raw diff (README §13). */
    readonly otherViewed: boolean;
    readonly uncoveredLines: number | null;
}

export interface ReviewCompletion {
    readonly verdict: Verdict;
    readonly prId: string;
    readonly headCommit: string;
    readonly hostName: string;
    readonly publishedComments: number;
    readonly publishedReplies: number;
    readonly progress: ReviewProgressSummary;
    readonly route: ReviewCompletionRoute | null;
    readonly openThreads: number;
    readonly firstOpenThreadId: string | null;
}

export interface ReviewActionBarProps {
    readonly pr: PrMeta;
    readonly diff: PrDiff;
    readonly diffStore: DiffViewStore;
    readonly threadStore: ThreadStore;
    readonly connection: ConnectionState;
    readonly hostName: string;
    readonly route?: RouteProgress | null;
    readonly composerTransport: ComposerTransport;
    readonly onPublish: (verdict: Verdict) => Promise<PublishResult>;
    readonly onComplete: (completion: ReviewCompletion) => void;
    readonly defaultMenuOpen?: boolean;
    readonly initialFailure?: PublicationFailure | null;
    /**
     * Whether chat is open: while it is an overlay (<1280), the bar sits under its scrim. The mouse cannot
     * reach it because the scrim catches clicks. This flag disables publishing shortcuts too.
     */
    readonly chatOpen?: boolean;
}

interface PublishOptions {
    /** Retry after failure: allowed even when normal publishing is blocked. */
    readonly retry?: boolean;
    /** The reviewer selected the ship mode by hand. Save it in global settings. */
    readonly remember?: boolean;
}

/** Panel mount condition: Overview shows loading, the other views wait for usable data. */
export function reviewActionBarVisible({
    view,
    completed,
    reviewHost,
    pr,
    dataReady,
}: {
    readonly view: ViewId;
    readonly completed: boolean;
    readonly reviewHost: string | null;
    readonly pr: PrMeta | null;
    readonly dataReady: boolean;
}): boolean {
    if (completed || reviewHost === null || pr === null) {
        return false;
    }
    switch (view) {
        case 'overview':
            return true;
        case 'route':
        case 'diff':
            return dataReady;
    }
}

/** Panel without a usable diff: keeps the layout and distinguishes loading from errors. */
export function ReviewActionBarLoading({ diffError }: { readonly diffError: string | null }) {
    const errored = diffError !== null;
    const disabledReason = errored ? `The diff failed to load: ${diffError}` : 'The diff and review data are still loading.';
    return (
        <div className="review-action-bar" aria-busy={errored ? undefined : true}>
            <span
                className={`review-action-bar__progress ${errored ? 'is-error' : 'is-loading'}`}
                aria-label={errored ? undefined : 'File counter loading'}
            >
                {errored ? (
                    'diff failed to load'
                ) : (
                    <>
                        <span className="review-action-bar__progress-spinner" aria-hidden="true" />
                        <span>files</span>
                    </>
                )}
            </span>
            <span className="review-action-bar__divider" aria-hidden="true" />
            <span className="review-action-bar__no-drafts">comments loading</span>
            <span className="review-action-bar__divider" aria-hidden="true" />
            <button type="button" className="review-action-bar__button" disabled title={disabledReason}>
                Comment on the PR
            </button>
            <button
                type="button"
                className="review-action-bar__button review-action-bar__request"
                disabled
                title={disabledReason}
            >
                Request changes
            </button>
            <div className="review-action-bar__ship">
                <button type="button" className="review-action-bar__ship-primary" disabled title={disabledReason}>
                    <Icon name="thumb" size={15} className="review-action-bar__thumb" />
                    Ship
                </button>
                <button
                    type="button"
                    className="review-action-bar__ship-caret"
                    disabled
                    title={disabledReason}
                    aria-label="Choose ship mode"
                >
                    <Icon name="chev-down" size={14} />
                </button>
            </div>
        </div>
    );
}

/** Final review actions with live counters, a save check and one publishing batch. */
export function ReviewActionBar({
    pr,
    diff,
    diffStore,
    threadStore,
    connection,
    hostName,
    route = null,
    composerTransport,
    onPublish,
    onComplete,
    defaultMenuOpen = false,
    initialFailure = null,
    chatOpen = false,
}: ReviewActionBarProps) {
    const diffSnapshot = useSyncExternalStore(diffStore.subscribe, diffStore.getSnapshot, diffStore.getSnapshot);
    const threadSnapshot = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot, threadStore.getSnapshot);
    const composerGuard = useSyncExternalStore(
        threadStore.subscribeComposerGuard,
        threadStore.getComposerGuardSnapshot,
        threadStore.getComposerGuardSnapshot,
    );
    const stickyAvailable = pr.capabilities.stickyShip;
    const settings = useUiSettingsStore();
    // Ship mode is global (SPEC §2.8). Unavailable sticky always falls back to ship.
    const shipMode = useUiSettings().shipMode;
    const effectiveShipMode = availableShipMode(shipMode, stickyAvailable);
    const [menuOpen, setMenuOpen] = useState(defaultMenuOpen);
    const [cursor, setCursor] = useState(effectiveShipMode === 'sticky_ship' ? 1 : 0);
    const [prCommentsOpen, setPrCommentsOpen] = useState(false);
    const [publishing, setPublishing] = useState<Verdict | null>(null);
    const [failure, setFailure] = useState<PublicationFailure | null>(initialFailure);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const shipButtonRef = useRef<HTMLButtonElement | null>(null);
    const commentButtonRef = useRef<HTMLButtonElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const publicationRef = useRef<{
        verdict: Verdict;
        // The mode was selected by hand, so it can be saved even when retrying after failure.
        remember: boolean;
        publishedIds: Set<string>;
    } | null>(null);

    const threadPin = useThreadPinContext();
    const drafts = countDraftComments(threadSnapshot.threads);
    // Drafts written before a push will go to a commit no longer at the PR head (SPEC §4.5).
    const pinnedDrafts = countPinnedDraftComments(threadSnapshot.threads, threadPin.activeDiffId);
    const progress = reviewProgressSummary(diff.files, diffSnapshot.readState);
    const unviewed = progress.filesTotal - progress.filesSeen;
    const routeCompletion = routeCompletionOf(route);
    // A route exists, so the guardrail counts stops instead of files (SPEC §2.19).
    const unviewedStops = routeCompletion === null ? 0 : routeCompletion.stopsTotal - routeCompletion.stopsViewed;
    const draggingSelection = diffSnapshot.selectionDragging;
    // Publishing changes the PR, so it is available only in the active iteration (M4 boundaries).
    const readOnlyIteration = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();
    const retryDisabledReason = publishDisabledReason({
        connection,
        pendingComposer: composerGuard.pending,
        publishing: publishing !== null,
        readOnlyIteration,
        readOnlyReason,
    });
    const disabledReason = publishDisabledReason({
        connection,
        pendingComposer: composerGuard.pending,
        publishing: publishing !== null,
        failure: failure !== null,
        readOnlyIteration,
        readOnlyReason,
    });
    const disabled = disabledReason !== null;

    const closeMenu = useCallback((returnFocus: boolean): void => {
        setMenuOpen(false);
        if (returnFocus) {
            shipButtonRef.current?.focus();
        }
    }, [setMenuOpen]);

    useEffect(() => {
        if (!menuOpen) {
            return;
        }
        menuRef.current?.focus();
        const closeOutside = (event: MouseEvent): void => {
            if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
                closeMenu(true);
            }
        };
        document.addEventListener('mousedown', closeOutside);
        return () => {
            document.removeEventListener('mousedown', closeOutside);
        };
    }, [closeMenu, menuOpen]);

    /**
     * Publishes the verdict. `remember` is set only where the reviewer selects the ship mode by hand:
     * the main button publishes the downgraded mode (this PR has no sticky), and saving that downgrade
     * in global settings would reset the choice for every other PR.
     */
    const publish = useCallback(
        async (verdict: Verdict, { retry = false, remember = false }: PublishOptions = {}): Promise<void> => {
            if ((retry ? retryDisabledReason : disabledReason) !== null) {
                return;
            }
            const threadsBefore = threadStore.getSnapshot().threads;
            const draftCount = countDraftComments(threadsBefore);
            const publication =
                publicationRef.current?.verdict === verdict
                    ? publicationRef.current
                    : { verdict, remember, publishedIds: new Set<string>() };
            publicationRef.current = publication;
            setMenuOpen(false);
            setFailure(null);
            setPublishing(verdict);
            try {
                const result = await onPublish(verdict);
                closePublishedComposers(threadStore, result.publishedCommentIds);
                for (const commentId of result.publishedCommentIds) {
                    publication.publishedIds.add(commentId);
                }
                const currentThreads = threadStore.getSnapshot().threads;
                const partial = partialPublicationFailure(verdict, result, commentBodies(currentThreads));
                if (partial !== null) {
                    setFailure(partial);
                    return;
                }
                if (publication.remember && (verdict === 'ship' || verdict === 'sticky_ship')) {
                    settings.update({ shipMode: verdict });
                }
                const discussion = discussionStats(currentThreads);
                const publishedIds = [...publication.publishedIds];
                publicationRef.current = null;
                onComplete({
                    verdict,
                    prId: pr.id,
                    headCommit: diff.headCommit,
                    hostName,
                    publishedComments: publishedIds.length,
                    publishedReplies: countPublishedReplies(currentThreads, publishedIds),
                    progress: reviewProgressSummary(diff.files, diffStore.getSnapshot().readState),
                    route: routeCompletion,
                    openThreads: discussion.open,
                    firstOpenThreadId: currentThreads.find((thread) => !thread.resolved)?.id ?? null,
                });
            } catch (error) {
                setFailure(requestPublicationFailure(verdict, draftCount, error));
            } finally {
                setPublishing(null);
            }
        },
        [
            diff.files,
            diff.headCommit,
            diffStore,
            disabledReason,
            hostName,
            onComplete,
            onPublish,
            pr.id,
            retryDisabledReason,
            routeCompletion,
            setFailure,
            setMenuOpen,
            setPublishing,
            settings,
            threadStore,
        ],
    );

    useShortcut({
        id: 'review.shipMenu',
        keys: ['mod+enter'],
        label: 'Open the ship menu',
        consequence: publishConsequence(effectiveShipMode, drafts),
        when: () => !draggingSelection && !disabled && !prCommentsOpen && !chatOverlaysContent(chatOpen),
        action: () => {
            setCursor(effectiveShipMode === 'sticky_ship' ? 1 : 0);
            setMenuOpen(true);
        },
    });
    useShortcut({
        id: 'review.requestChanges',
        keys: ['mod+shift+enter'],
        label: 'Request changes',
        consequence: publishConsequence('request_changes', drafts),
        when: () => !draggingSelection && !disabled && !prCommentsOpen && !chatOverlaysContent(chatOpen),
        action: () => {
            void publish('request_changes');
        },
    });

    if (draggingSelection) {
        return null;
    }

    if (failure !== null) {
        return (
            <div className="review-action-bar review-action-bar--error" ref={rootRef} role="alert">
                <div className="review-action-error__summary">
                    {failure.failedCount === 0 ? (
                        'Could not finish the review'
                    ) : (
                        <>
                            {formatCount(failure.failedCount)}{' '}
                            {plural(failure.failedCount, 'comment failed to publish', 'comments failed to publish', 'comments failed to publish')}
                        </>
                    )}
                    {' · '}
                    <button
                        type="button"
                        onClick={() => void publish(failure.verdict, { retry: true })}
                        disabled={retryDisabledReason !== null}
                        title={retryDisabledReason ?? undefined}
                    >
                        retry
                    </button>
                </div>
                {failure.message === null ? null : <div className="review-action-error__message">{failure.message}</div>}
                {failure.comments.length === 0 ? null : (
                    <ul className="review-action-error__comments">
                        {failure.comments.map((comment) => (
                            <li key={comment.commentId}>
                                <span>{comment.body ?? `Comment ${comment.commentId}`}</span>
                                <small>{comment.message}</small>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        );
    }

    const draftBatch = `${formatCount(drafts)} ${plural(drafts, 'draft', 'drafts', 'drafts')}`;
    return (
        <div className="review-action-bar" ref={rootRef}>
            <span className="review-action-bar__progress">
                {formatCount(progress.filesSeen)} / {formatCount(progress.filesTotal)} files
            </span>
            <span className="review-action-bar__divider" aria-hidden="true" />
            {drafts === 0 ? (
                <span className="review-action-bar__no-drafts">no unpublished comments</span>
            ) : (
                <span className="review-action-bar__drafts">
                    <span className="review-action-bar__draft-dot" aria-hidden="true" />
                    {draftBatch} {plural(drafts, 'goes out', 'go out', 'go out')} on ship
                    {pinnedDrafts === 0 ? null : (
                        <span className="review-action-bar__pinned-drafts">
                            · {formatCount(pinnedDrafts)}{' '}
                            {plural(pinnedDrafts, 'is pinned', 'are pinned', 'are pinned')} to earlier commits
                        </span>
                    )}
                </span>
            )}
            <span className="review-action-bar__divider" aria-hidden="true" />
            <button
                ref={commentButtonRef}
                type="button"
                className="review-action-bar__button"
                aria-expanded={prCommentsOpen}
                aria-haspopup="dialog"
                onClick={() => {
                    setPrCommentsOpen(true);
                    setMenuOpen(false);
                }}
            >
                Comment on the PR
            </button>
            <button
                type="button"
                className="review-action-bar__button review-action-bar__request"
                disabled={disabled}
                title={disabledReason ?? publishConsequence('request_changes', drafts)}
                onClick={() => void publish('request_changes')}
            >
                Request changes{drafts === 0 ? '' : ` · ${formatCount(drafts)}`}
            </button>
            <div className="review-action-bar__ship">
                <button
                    ref={shipButtonRef}
                    type="button"
                    className="review-action-bar__ship-primary"
                    disabled={disabled}
                    title={disabledReason ?? publishConsequence(effectiveShipMode, drafts)}
                    onClick={() => void publish(effectiveShipMode)}
                >
                    <Icon name="thumb" size={15} className="review-action-bar__thumb" />
                    {publishing === null
                        ? `${shipModeLabel(effectiveShipMode)}${drafts === 0 ? '' : ` · ${formatCount(drafts)}`}`
                        : 'Publishing…'}
                </button>
                <button
                    type="button"
                    className="review-action-bar__ship-caret"
                    aria-haspopup="listbox"
                    aria-expanded={menuOpen}
                    disabled={disabled}
                    title={disabledReason ?? 'Choose the ship mode'}
                    onClick={() => {
                        if (menuOpen) {
                            closeMenu(false);
                        } else {
                            setCursor(effectiveShipMode === 'sticky_ship' ? 1 : 0);
                            setMenuOpen(true);
                            setPrCommentsOpen(false);
                        }
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowDown' && !menuOpen) {
                            event.preventDefault();
                            setCursor(effectiveShipMode === 'sticky_ship' ? 1 : 0);
                            setMenuOpen(true);
                        }
                    }}
                >
                    <Icon name="chev-down" size={14} />
                </button>
                {menuOpen ? (
                    <div
                        ref={menuRef}
                        className="review-action-menu"
                        role="listbox"
                        aria-label="Ship mode"
                        tabIndex={-1}
                        aria-activedescendant={`review-ship-option-${String(cursor)}`}
                        onKeyDown={(event) => {
                            if (event.key === 'ArrowDown') {
                                event.preventDefault();
                                setCursor((value) => Math.min(value + 1, 1));
                            } else if (event.key === 'ArrowUp') {
                                event.preventDefault();
                                setCursor((value) => Math.max(value - 1, 0));
                            } else if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                const mode: ShipMode = cursor === 0 ? 'ship' : 'sticky_ship';
                                if (mode === 'ship' || stickyAvailable) {
                                    void publish(mode, { remember: true });
                                }
                            } else if (event.key === 'Escape') {
                                event.preventDefault();
                                closeMenu(true);
                            } else if (event.key === 'Tab') {
                                closeMenu(false);
                            }
                        }}
                    >
                        <ShipGuard files={unviewed} stops={routeCompletion === null ? null : unviewedStops} />
                        <ShipOption
                            index={0}
                            cursor={cursor}
                            mode="ship"
                            active={effectiveShipMode === 'ship'}
                            label="Ship"
                            description={SHIP_DESCRIPTION}
                            drafts={drafts}
                            onHover={setCursor}
                            onChoose={(mode) => void publish(mode, { remember: true })}
                        />
                        <ShipOption
                            index={1}
                            cursor={cursor}
                            mode="sticky_ship"
                            active={effectiveShipMode === 'sticky_ship'}
                            label="Sticky ship"
                            description={STICKY_DESCRIPTION}
                            drafts={drafts}
                            disabled={!stickyAvailable}
                            disabledReason="This host does not support Sticky ship."
                            onHover={setCursor}
                            onChoose={(mode) => void publish(mode, { remember: true })}
                        />
                    </div>
                ) : null}
            </div>

            {prCommentsOpen ? (
                <PrCommentsModal
                    pr={pr}
                    store={threadStore}
                    transport={composerTransport}
                    onClose={() => {
                        setPrCommentsOpen(false);
                        queueMicrotask(() => {
                            commentButtonRef.current?.focus();
                        });
                    }}
                />
            ) : null}
        </div>
    );
}

/**
 * The ship menu's informational guardrail reports without blocking (SPEC §2.19). With a ready
 * route it counts stops. A file counter next to it would only confuse the reader.
 */
function ShipGuard({ files, stops }: { files: number; stops: number | null }) {
    if (stops !== null) {
        return stops === 0 ? null : (
            <div className="review-action-menu__guard">
                {formatCount(stops)}{' '}
                {plural(stops, 'stop not viewed', 'stops not viewed', 'stops not viewed')} — ship
                anyway?
            </div>
        );
    }
    return files === 0 ? null : (
        <div className="review-action-menu__guard">
            {formatCount(files)}{' '}
            {plural(files, 'file not viewed', 'files not viewed', 'files not viewed')} — ship anyway?
        </div>
    );
}

/** Route state for the warning and summary, computed from actual marks, not the snapshot. */
function routeCompletionOf(route: RouteProgress | null): ReviewCompletionRoute | null {
    if (route === null || route.stopIds.length === 0) {
        return null;
    }
    return {
        stopsTotal: route.stopIds.length,
        stopsViewed: route.stopIds.filter((stopId) => route.viewed.get(stopId) === true).length,
        otherViewed: route.otherStopId !== null && route.viewed.get(route.otherStopId) === true,
        uncoveredLines: route.uncoveredLines,
    };
}

function ShipOption({
    index,
    cursor,
    mode,
    active,
    label,
    description,
    drafts,
    disabled = false,
    disabledReason,
    onHover,
    onChoose,
}: {
    index: number;
    cursor: number;
    mode: ShipMode;
    active: boolean;
    label: string;
    description: string;
    drafts: number;
    disabled?: boolean;
    disabledReason?: string;
    onHover: (index: number) => void;
    onChoose: (mode: ShipMode) => void;
}) {
    return (
        <div
            id={`review-ship-option-${String(index)}`}
            role="option"
            aria-selected={active}
            aria-disabled={disabled}
            title={disabled ? disabledReason : undefined}
            className={`review-action-menu__option${index === cursor ? ' is-cursor' : ''}`}
            onMouseEnter={() => {
                onHover(index);
            }}
            onClick={() => {
                if (!disabled) {
                    onChoose(mode);
                }
            }}
        >
            <span className="review-action-menu__tick" aria-hidden="true">
                {active ? <Icon name="check" size={13} /> : null}
            </span>
            <span>
                <strong>{label}</strong>
                <span>{description}</span>
                {drafts === 0 ? null : (
                    <small>
                        Publishes {formatCount(drafts)} {plural(drafts, 'draft', 'drafts', 'drafts')}.
                    </small>
                )}
                {disabled ? <small>{disabledReason}</small> : null}
            </span>
        </div>
    );
}

function shipModeLabel(mode: ShipMode): string {
    return mode === 'sticky_ship' ? 'Sticky ship' : 'Ship';
}
