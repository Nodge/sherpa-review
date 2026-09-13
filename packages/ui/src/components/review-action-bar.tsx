import type { DraftBufferEntry, PrDiff, PrMeta, PublishResult, Verdict } from '@sherpa/protocol';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { DiffViewStore } from '../diff-view/store.js';
import { Icon } from '../icons/icon.tsx';
import { useFormat, useT } from '../i18n/index.js';
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
import { useEscapeLayer, useShortcut } from '../shortcuts/context.tsx';
import type { ViewId } from '../session/views.js';
import { useUiSettings, useUiSettingsStore } from '../settings/context.tsx';
import type { ConnectionState } from '../store.js';
import { closePublishedComposers } from '../threads/composer.js';
import type { ComposerTransport } from '../threads/composer.js';
import type { ThreadStore } from '../threads/store.js';
import { discussionStats } from '../views/overview-model.js';
import { chatOverlaysContent } from './dock.js';
import type { PrCommentsGate } from './pr-comments-gate.js';
import { usePrCommentsGate } from './pr-comments-gate.js';
import { PrCommentsModal } from './pr-comments-modal.tsx';
import {
    availableShipMode,
    partialPublicationFailure,
    type PublicationFailure,
    publishConsequenceKey,
    publishDisabledReason,
    requestPublicationFailure,
    type ShipMode,
} from './review-action-model.js';
import './review-action-bar.css';

const EMPTY_DRAFT_BUFFER: readonly DraftBufferEntry[] = [];

// The sticky description does not promise revocation by CODEOWNERS zone from docs/design/README.md §5. It publishes a regular
// host sticky ship. There is no zone-specific mechanism.

/**
 * Route data in the action bar (docs/design/SPEC-elements.md §2.19, docs/design/README.md
 * §13): the warning counts unviewed stops instead of files, and the review summary shows route rows. `null` means no route,
 * so the warning and summary count files.
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
    /** Other was read as raw diff (docs/design/README.md §13). */
    readonly otherViewed: boolean;
    readonly uncoveredLines: number | null;
}

export interface ReviewCompletion {
    readonly verdict: Verdict;
    readonly prId: string;
    readonly headCommit: string;
    readonly hostName: string;
    /** Adapter name (`uiState.reviewHost`). Local review has its own delivery message. */
    readonly reviewHost: string;
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
    /** Adapter name passed to the publication result. The host label stays in `hostName`. */
    readonly reviewHost: string;
    readonly route?: RouteProgress | null;
    readonly composerTransport: ComposerTransport;
    /** Drafts in the server buffer: count in the batch and block ship until sent. */
    readonly draftBuffer?: readonly DraftBufferEntry[];
    readonly onPublish: (verdict: Verdict) => Promise<PublishResult>;
    readonly onComplete: (completion: ReviewCompletion) => void;
    readonly defaultMenuOpen?: boolean;
    /**
     * Shared PR comments modal state: both the bar and the Discussion card in Overview open it
     * (docs/design/SPEC-additions-2026-08-26.md §1e). Without it, the bar keeps its own state for use in the gallery.
     */
    readonly prComments?: PrCommentsGate;
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
    const t = useT();
    const errored = diffError !== null;
    const disabledReason =
        diffError === null ? t('ship.loading.reason') : t('ship.diffFailed.reason', diffError);
    return (
        <div className="review-action-bar" aria-busy={errored ? undefined : true} data-tour="ship">
            <span
                className={`review-action-bar__progress ${errored ? 'is-error' : 'is-loading'}`}
                aria-label={errored ? undefined : t('ship.loading.filesAria')}
            >
                {errored ? (
                    t('ship.diffFailed')
                ) : (
                    <>
                        <span className="review-action-bar__progress-spinner" aria-hidden="true" />
                        <span>{t('ship.loading.files')}</span>
                    </>
                )}
            </span>
            <span className="review-action-bar__divider" aria-hidden="true" />
            <span className="review-action-bar__no-drafts">{t('ship.loading.comments')}</span>
            <span className="review-action-bar__divider" aria-hidden="true" />
            <button type="button" className="review-action-bar__button" disabled title={disabledReason}>
                {t('ship.prComment')}
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
                    {t('ship.mode.ship')}
                </button>
                <button
                    type="button"
                    className="review-action-bar__ship-caret"
                    disabled
                    title={disabledReason}
                    aria-label={t('ship.chooseMode')}
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
    reviewHost,
    route = null,
    composerTransport,
    draftBuffer = EMPTY_DRAFT_BUFFER,
    onPublish,
    onComplete,
    defaultMenuOpen = false,
    prComments,
    initialFailure = null,
    chatOpen = false,
}: ReviewActionBarProps) {
    const t = useT();
    const format = useFormat();
    const diffSnapshot = useSyncExternalStore(diffStore.subscribe, diffStore.getSnapshot, diffStore.getSnapshot);
    const threadSnapshot = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot, threadStore.getSnapshot);
    const composerGuard = useSyncExternalStore(
        threadStore.subscribeComposerGuard,
        threadStore.getComposerGuardSnapshot,
        threadStore.getComposerGuardSnapshot,
    );
    const stickyAvailable = pr.capabilities.stickyShip;
    const settings = useUiSettingsStore();
    // Ship mode is global (docs/design/SPEC-elements.md §2.8). Unavailable sticky always falls back to ship.
    const shipMode = useUiSettings().shipMode;
    const effectiveShipMode = availableShipMode(shipMode, stickyAvailable);
    const [menuOpen, setMenuOpen] = useState(defaultMenuOpen);
    const [cursor, setCursor] = useState(effectiveShipMode === 'sticky_ship' ? 1 : 0);
    const ownPrComments = usePrCommentsGate();
    const prCommentsGate = prComments ?? ownPrComments;
    const prCommentsOpen = prCommentsGate.open;
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
    // Buffered records are drafts in the batch. They will be published on ship once they reach the host.
    // Count only creates: an edit belongs to a draft already counted in the threads.
    const buffered = draftBuffer.length;
    const bufferedNew = draftBuffer.filter((entry) => entry.commentId === null).length;
    const drafts = countDraftComments(threadSnapshot.threads) + bufferedNew;
    const openThreads = discussionStats(threadSnapshot.threads).open;
    // Drafts written before a push target a commit no longer at the PR head
    // (docs/design/SPEC-elements.md §4.5).
    const pinnedDrafts = countPinnedDraftComments(threadSnapshot.threads, threadPin.activeDiffId);
    const progress = reviewProgressSummary(diff.files, diffSnapshot.readState);
    const unviewed = progress.filesTotal - progress.filesSeen;
    const routeCompletion = routeCompletionOf(route);
    // With a route, the warning counts stops instead of files (docs/design/SPEC-elements.md §2.19).
    const unviewedStops = routeCompletion === null ? 0 : routeCompletion.stopsTotal - routeCompletion.stopsViewed;
    const draggingSelection = diffSnapshot.selectionDragging;
    // Publishing changes the PR, so it is available only in the active iteration.
    const readOnlyIteration = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();
    const retryDisabledReason = publishDisabledReason({
        t,
        connection,
        pendingComposer: composerGuard.pending,
        bufferedDrafts: buffered,
        publishing: publishing !== null,
        readOnlyIteration,
        readOnlyReason,
    });
    const disabledReason = publishDisabledReason({
        t,
        connection,
        pendingComposer: composerGuard.pending,
        bufferedDrafts: buffered,
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

    useEscapeLayer('popover', () => {
        closeMenu(true);
    }, menuOpen);

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
                const partial = partialPublicationFailure(verdict, result, commentBodies(currentThreads), t);
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
                    reviewHost,
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
            reviewHost,
            routeCompletion,
            setFailure,
            setMenuOpen,
            setPublishing,
            settings,
            t,
            threadStore,
        ],
    );

    useShortcut({
        id: 'review.shipMenu',
        keys: ['mod+enter'],
        label: 'shortcut.review.shipMenu',
        scope: 'global',
        section: 'ship',
        consequence: publishConsequenceKey(effectiveShipMode),
        consequenceArg: drafts,
        when: () => !draggingSelection && !disabled && !prCommentsOpen && !chatOverlaysContent(chatOpen),
        action: () => {
            setCursor(effectiveShipMode === 'sticky_ship' ? 1 : 0);
            setMenuOpen(true);
        },
    });
    useShortcut({
        id: 'review.requestChanges',
        keys: ['mod+shift+enter'],
        label: 'shortcut.review.requestChanges',
        scope: 'global',
        section: 'ship',
        consequence: publishConsequenceKey('request_changes'),
        consequenceArg: drafts,
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
                    {failure.failedCount === 0
                        ? t('ship.error.failed')
                        : t('ship.error.comments', failure.failedCount)}
                    {' · '}
                    <button
                        type="button"
                        onClick={() => void publish(failure.verdict, { retry: true })}
                        disabled={retryDisabledReason !== null}
                        title={retryDisabledReason ?? undefined}
                    >
                        {t('ship.error.retry')}
                    </button>
                </div>
                {failure.message === null ? null : <div className="review-action-error__message">{failure.message}</div>}
                {failure.comments.length === 0 ? null : (
                    <ul className="review-action-error__comments">
                        {failure.comments.map((comment) => (
                            <li key={comment.commentId}>
                                <span>{comment.body ?? t('ship.error.comment', comment.commentId)}</span>
                                <small>{comment.message}</small>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        );
    }

    return (
        <div className="review-action-bar" ref={rootRef} data-tour="ship">
            <span className="review-action-bar__progress">
                {t('ship.progress', progress.filesSeen, progress.filesTotal)}
            </span>
            <span className="review-action-bar__divider" aria-hidden="true" />
            {drafts === 0 ? (
                <span className="review-action-bar__no-drafts">{t('ship.noDrafts')}</span>
            ) : (
                <span className="review-action-bar__drafts">
                    <span className="review-action-bar__draft-dot" aria-hidden="true" />
                    {t('ship.drafts', drafts)}
                    {buffered === 0 ? null : (
                        <span className="review-action-bar__pinned-drafts">
                            {' '}
                            {t('ship.drafts.buffered', buffered)}
                        </span>
                    )}
                    {pinnedDrafts === 0 ? null : (
                        <span className="review-action-bar__pinned-drafts">
                            {' '}
                            {t('ship.drafts.pinned', pinnedDrafts)}
                        </span>
                    )}
                </span>
            )}
            {openThreads === 0 ? null : (
                <>
                    <span className="review-action-bar__divider" aria-hidden="true" />
                    <span className="review-action-bar__open-threads">{t('ship.openThreads', openThreads)}</span>
                </>
            )}
            <span className="review-action-bar__divider" aria-hidden="true" />
            <button
                ref={commentButtonRef}
                type="button"
                className="review-action-bar__button"
                aria-expanded={prCommentsOpen}
                aria-haspopup="dialog"
                onClick={() => {
                    prCommentsGate.openModal(() => {
                        commentButtonRef.current?.focus();
                    });
                    setMenuOpen(false);
                }}
            >
                {t('ship.prComment')}
            </button>
            <button
                type="button"
                className="review-action-bar__button review-action-bar__request"
                disabled={disabled}
                title={disabledReason ?? t('ship.consequence.requestChanges', drafts)}
                onClick={() => void publish('request_changes')}
            >
                {t('shortcut.review.requestChanges')}
                {drafts === 0 ? '' : ` · ${format.count(drafts)}`}
            </button>
            <div className="review-action-bar__ship">
                <button
                    ref={shipButtonRef}
                    type="button"
                    className="review-action-bar__ship-primary"
                    disabled={disabled}
                    title={disabledReason ?? t(publishConsequenceKey(effectiveShipMode), drafts)}
                    onClick={() => void publish(effectiveShipMode)}
                >
                    <Icon name="thumb" size={15} className="review-action-bar__thumb" />
                    {publishing === null
                        ? `${t(shipModeKey(effectiveShipMode))}${drafts === 0 ? '' : ` · ${format.count(drafts)}`}`
                        : t('ship.publishing')}
                </button>
                <button
                    type="button"
                    className="review-action-bar__ship-caret"
                    aria-haspopup="listbox"
                    aria-expanded={menuOpen}
                    disabled={disabled}
                    title={disabledReason ?? t('ship.chooseMode')}
                    onClick={() => {
                        if (menuOpen) {
                            closeMenu(false);
                        } else {
                            setCursor(effectiveShipMode === 'sticky_ship' ? 1 : 0);
                            setMenuOpen(true);
                            prCommentsGate.close();
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
                        aria-label={t('ship.menu')}
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
                            label={t('ship.mode.ship')}
                            description={t('ship.mode.ship.description')}
                            drafts={drafts}
                            onHover={setCursor}
                            onChoose={(mode) => void publish(mode, { remember: true })}
                        />
                        <ShipOption
                            index={1}
                            cursor={cursor}
                            mode="sticky_ship"
                            active={effectiveShipMode === 'sticky_ship'}
                            label={t('ship.mode.sticky')}
                            description={t('ship.mode.sticky.description')}
                            drafts={drafts}
                            disabled={!stickyAvailable}
                            disabledReason={t('ship.mode.sticky.unavailable')}
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
                    draftBuffer={draftBuffer}
                    onClose={prCommentsGate.close}
                />
            ) : null}
        </div>
    );
}

/**
 * The ship menu warning informs without blocking (docs/design/SPEC-elements.md §2.19). With a ready
 * route it counts stops. A file counter next to it would only confuse the reader.
 */
function ShipGuard({ files, stops }: { files: number; stops: number | null }) {
    const t = useT();
    if (stops !== null) {
        return stops === 0 ? null : <div className="review-action-menu__guard">{t('ship.guard.stops', stops)}</div>;
    }
    return files === 0 ? null : <div className="review-action-menu__guard">{t('ship.guard.files', files)}</div>;
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
    const t = useT();
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
                {drafts === 0 ? null : <small>{t('ship.option.publishes', drafts)}</small>}
                {disabled ? <small>{disabledReason}</small> : null}
            </span>
        </div>
    );
}

function shipModeKey(mode: ShipMode): 'ship.mode.ship' | 'ship.mode.sticky' {
    return mode === 'sticky_ship' ? 'ship.mode.sticky' : 'ship.mode.ship';
}
