import type { DraftBufferEntry, PrDiff, PrMeta, PublishResult, UiReviewHost, Verdict } from '@sherpa/protocol';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { DraftDestination } from '../app/review-state.js';
import type { DiffViewStore } from '../diff-view/store.js';
import { Icon } from '../icons/icon.tsx';
import type { IconName } from '../icons/icon.tsx';
import type { Translate } from '../i18n/index.js';
import { useFormat, useT } from '../i18n/index.js';
import { useReadOnlyIteration, useReadOnlyReason } from '../iterations/read-only.tsx';
import { useThreadPinContext } from '../iterations/thread-pin.tsx';
import type { ReviewProgressSummary } from '../progress/summary.js';
import {
    commentBodies,
    countDraftComments,
    countIssueDraftComments,
    countPinnedDraftComments,
    countPublishedReplies,
    reviewProgressSummary,
} from '../progress/summary.js';
import { useEscapeLayer, useShortcut } from '../shortcuts/context.tsx';
import { useUiSettings, useUiSettingsStore } from '../settings/context.tsx';
import type { ConnectionState } from '../store.js';
import { closePublishedComposers } from '../threads/composer.js';
import type { ComposerTransport } from '../threads/composer.js';
import type { ThreadStore } from '../threads/store.js';
import type { ThreadActions } from '../threads/thread-list.tsx';
import { discussionStats } from '../views/overview-model.js';
import { chatOverlaysContent } from './dock.js';
import type { PrCommentsGate } from './pr-comments-gate.js';
import { usePrCommentsGate } from './pr-comments-gate.js';
import { PrCommentsModal } from './pr-comments-modal.tsx';
import {
    availableShipMode,
    draftsCounterKey,
    noDraftsKey,
    partialPublicationFailure,
    type PublicationFailure,
    publishConsequenceKey,
    publishDisabledReason,
    requestPublicationFailure,
    SHIP_MENU_MODES,
    type ShipMode,
    shipModeLabelKey,
    shipModeOf,
    shipModesOf,
    shipOptionDisabledKey,
    unreachableVerdict,
} from './review-action-model.js';
import './review-action-bar.css';

const EMPTY_DRAFT_BUFFER: readonly DraftBufferEntry[] = [];

// The sticky description makes no promise of ownership-zone revocation from docs/design/README.md §5. It publishes regular
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
    /** Draft destination (`UiReviewHost.drafts`): local review has its own delivery text. */
    readonly draftDestination: DraftDestination;
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
    /** Host label (`UiReviewHost.label`) for the publishing summary. */
    readonly hostName: string;
    /** Draft destination (`UiReviewHost.drafts`), which determines counter and publishing consequence text. */
    readonly draftDestination: DraftDestination;
    readonly route?: RouteProgress | null;
    readonly composerTransport: ComposerTransport;
    /** Thread actions for the comments modal: Resolve, edit and delete published comments. */
    readonly threadActions?: ThreadActions;
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
    /** The reviewer selected a mode in the Ship menu. Save it in global settings. */
    readonly remember?: boolean;
}

/**
 * Mount the bar only with usable review data. There is no bar while data loads,
 * because a placeholder would show publishing modes this PR might not support.
 */
export function reviewActionBarVisible({
    completed,
    reviewHost,
    pr,
    dataReady,
}: {
    readonly completed: boolean;
    readonly reviewHost: UiReviewHost | null;
    readonly pr: PrMeta | null;
    readonly dataReady: boolean;
}): boolean {
    return !completed && reviewHost !== null && pr !== null && dataReady;
}

/** Final review actions with live counters, a save check and one publishing batch. */
export function ReviewActionBar({
    pr,
    diff,
    diffStore,
    threadStore,
    connection,
    hostName,
    draftDestination: destination,
    route = null,
    composerTransport,
    draftBuffer = EMPTY_DRAFT_BUFFER,
    onPublish,
    onComplete,
    defaultMenuOpen = false,
    prComments,
    threadActions,
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
    // The bar shows exactly the modes the host accepts on this PR, without distinguishing hosts.
    const publishVerdicts = pr.capabilities.publishVerdicts;
    const requestChangesAvailable = publishVerdicts.includes('request_changes');
    const shipModes = shipModesOf(publishVerdicts);
    // One mode (local review, own PR on GitHub) gives a button without a caret or menu.
    const hasShipMenu = shipModes.length > 1;
    const settings = useUiSettingsStore();
    // Ship mode is global (docs/design/SPEC-elements.md §2.8). An unavailable mode falls back to one the PR supports.
    const shipMode = useUiSettings().shipMode;
    const effectiveShipMode = availableShipMode(shipMode, shipModes);
    // null means the host accepts no split-button modes on this PR, so the button is absent.
    const effectiveCursor = effectiveShipMode === null ? 0 : SHIP_MENU_MODES.indexOf(effectiveShipMode);
    const [menuOpen, setMenuOpen] = useState(defaultMenuOpen && hasShipMenu);
    const [cursor, setCursor] = useState(effectiveCursor);
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
    // Buffered entries are drafts in the same batch. They publish once they reach the host.
    // Count only creates: an edit belongs to a draft already counted in the threads.
    const buffered = draftBuffer.length;
    const bufferedNew = draftBuffer.filter((entry) => entry.commentId === null).length;
    const drafts = countDraftComments(threadSnapshot.threads) + bufferedNew;
    // The counter suffix "· N issue" shows how many of these drafts open an issue (§1).
    const issueDrafts =
        countIssueDraftComments(threadSnapshot.threads) +
        draftBuffer.filter((entry) => entry.commentId === null && entry.draft.issue === true).length;
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
    // The host may not accept publishing without a verdict, and without drafts there is nothing to publish.
    const publishCommentsReason =
        disabledReason ??
        (publishVerdicts.includes('comment')
            ? drafts === 0
                ? t(noDraftsKey(destination))
                : null
            : t('ship.mode.comment.unavailable'));
    const primaryDisabledReason = effectiveShipMode === 'comment' ? publishCommentsReason : disabledReason;
    const optionDisabledReason = (mode: ShipMode): string | null => {
        const key = shipOptionDisabledKey(mode, shipModes, drafts, destination);
        return key === null ? null : t(key);
    };

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
     * Publishes a verdict. `remember` is set only for menu selections: the primary part may
     * publish a fallback mode (this PR has no sticky). Saving that fallback in global
     * settings would reset the choice on all other PRs.
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
                const chosenShipMode = shipModeOf(verdict);
                if (publication.remember && chosenShipMode !== null) {
                    settings.update({ shipMode: chosenShipMode });
                }
                const discussion = discussionStats(currentThreads);
                const publishedIds = [...publication.publishedIds];
                publicationRef.current = null;
                onComplete({
                    verdict,
                    prId: pr.id,
                    headCommit: diff.headCommit,
                    hostName,
                    draftDestination: destination,
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
            destination,
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
        ...(effectiveShipMode === null ? {} : { consequence: publishConsequenceKey(effectiveShipMode, destination) }),
        consequenceArg: drafts,
        when: () =>
            hasShipMenu &&
            !draggingSelection &&
            !disabled &&
            !prCommentsOpen &&
            !chatOverlaysContent(chatOpen),
        action: () => {
            setCursor(effectiveCursor);
            setMenuOpen(true);
        },
    });
    useShortcut({
        id: 'review.requestChanges',
        keys: ['mod+shift+enter'],
        label: 'shortcut.review.requestChanges',
        scope: 'global',
        section: 'ship',
        consequence: publishConsequenceKey('request_changes', destination),
        consequenceArg: drafts,
        when: () =>
            requestChangesAvailable &&
            !draggingSelection &&
            !disabled &&
            !prCommentsOpen &&
            !chatOverlaysContent(chatOpen),
        action: () => {
            void publish('request_changes');
        },
    });
    useShortcut({
        id: 'review.publishComments',
        keys: [],
        label: 'shortcut.review.publishComments',
        scope: 'global',
        section: 'ship',
        consequence: publishConsequenceKey('comment', destination),
        consequenceArg: drafts,
        when: () =>
            publishCommentsReason === null &&
            !draggingSelection &&
            !prCommentsOpen &&
            !chatOverlaysContent(chatOpen),
        action: () => {
            void publish('comment');
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
                        className="ctl ctl--link-muted"
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
                <span className="review-action-bar__no-drafts">{t(noDraftsKey(destination))}</span>
            ) : (
                <span className="review-action-bar__drafts">
                    <span className="review-action-bar__draft-dot" aria-hidden="true" />
                    {t(draftsCounterKey(destination), drafts)}
                    {issueDrafts === 0 ? null : <> {t('ship.drafts.issues', issueDrafts)}</>}
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
            <span className="review-action-bar__divider" aria-hidden="true" />
            <button
                ref={commentButtonRef}
                type="button"
                className="ctl ctl--ghost review-action-bar__button"
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
            {requestChangesAvailable ? (
                <button
                    type="button"
                    className="ctl ctl--danger-ghost review-action-bar__button"
                    disabled={disabled}
                    title={disabledReason ?? t(publishConsequenceKey('request_changes', destination), drafts)}
                    onClick={() => void publish('request_changes')}
                >
                    {t('shortcut.review.requestChanges')}
                    {drafts === 0 ? '' : ` · ${format.count(drafts)}`}
                </button>
            ) : null}
            {effectiveShipMode === null ? null : (
                <div className="review-action-bar__ship">
                    <button
                        ref={shipButtonRef}
                        type="button"
                        className="ctl ctl--primary review-action-bar__ship-primary"
                        disabled={primaryDisabledReason !== null}
                        title={primaryDisabledReason ?? t(publishConsequenceKey(effectiveShipMode, destination), drafts)}
                        onClick={() => void publish(effectiveShipMode)}
                    >
                        <ShipModeIcon mode={effectiveShipMode} />
                        {publishing === null
                            ? `${t(shipModeLabelKey(effectiveShipMode))}${drafts === 0 ? '' : ` · ${format.count(drafts)}`}`
                            : t('ship.publishing')}
                    </button>
                    {hasShipMenu ? (
                        <button
                            type="button"
                            className="ctl ctl--primary review-action-bar__ship-caret"
                            aria-haspopup="listbox"
                            aria-expanded={menuOpen}
                            disabled={disabled}
                            title={disabledReason ?? t('ship.chooseMode')}
                            onClick={() => {
                                if (menuOpen) {
                                    closeMenu(false);
                                } else {
                                    setCursor(effectiveCursor);
                                    setMenuOpen(true);
                                    prCommentsGate.close();
                                }
                            }}
                            onKeyDown={(event) => {
                                if (event.key === 'ArrowDown' && !menuOpen) {
                                    event.preventDefault();
                                    setCursor(effectiveCursor);
                                    setMenuOpen(true);
                                }
                            }}
                        >
                            <Icon name="chev-down" size={14} />
                        </button>
                    ) : null}
                    {hasShipMenu && menuOpen ? (
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
                                    setCursor((value) => Math.min(value + 1, SHIP_MENU_MODES.length - 1));
                                } else if (event.key === 'ArrowUp') {
                                    event.preventDefault();
                                    setCursor((value) => Math.max(value - 1, 0));
                                } else if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    const mode = SHIP_MENU_MODES[cursor];
                                    if (mode !== undefined && optionDisabledReason(mode) === null) {
                                        void publish(mode, { remember: true });
                                    }
                                } else if (event.key === 'Tab') {
                                    closeMenu(false);
                                }
                            }}
                        >
                            <ShipGuard files={unviewed} stops={routeCompletion === null ? null : unviewedStops} />
                            {SHIP_MENU_MODES.map((mode, index) => (
                                <ShipOption
                                    key={mode}
                                    index={index}
                                    cursor={cursor}
                                    mode={mode}
                                    active={effectiveShipMode === mode}
                                    label={t(shipModeLabelKey(mode))}
                                    description={shipOptionDescription(mode, drafts, destination, t)}
                                    drafts={mode === 'comment' ? 0 : drafts}
                                    disabledReason={optionDisabledReason(mode)}
                                    onHover={setCursor}
                                    onChoose={(chosen) => void publish(chosen, { remember: true })}
                                />
                            ))}
                        </div>
                    ) : null}
                </div>
            )}

            {prCommentsOpen ? (
                <PrCommentsModal
                    pr={pr}
                    store={threadStore}
                    transport={composerTransport}
                    {...(threadActions === undefined ? {} : { actions: threadActions })}
                    draftBuffer={draftBuffer}
                    draftDestination={destination}
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
    disabledReason,
    onHover,
    onChoose,
}: {
    index: number;
    cursor: number;
    mode: ShipMode;
    active: boolean;
    label: string;
    description: string | null;
    /** Draft count for the "Will publish N" suffix. Zero omits the suffix. */
    drafts: number;
    disabledReason: string | null;
    onHover: (index: number) => void;
    onChoose: (mode: ShipMode) => void;
}) {
    const t = useT();
    const disabled = disabledReason !== null;
    return (
        <div
            id={`review-ship-option-${String(index)}`}
            role="option"
            aria-selected={active}
            aria-disabled={disabled}
            title={disabledReason ?? undefined}
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
                {description === null ? null : <span>{description}</span>}
                {drafts === 0 ? null : <small>{t('ship.option.publishes', drafts)}</small>}
                {disabled ? <small>{disabledReason}</small> : null}
            </span>
        </div>
    );
}

/**
 * Menu row explanation. For Comment it describes the consequence. Without drafts the row is disabled,
 * and omits "will publish 0" because the row itself shows the reason.
 */
function shipOptionDescription(
    mode: ShipMode,
    drafts: number,
    destination: DraftDestination,
    t: Translate,
): string | null {
    switch (mode) {
        case 'ship':
            return t('ship.mode.ship.description');
        case 'sticky_ship':
            return t('ship.mode.sticky.description');
        case 'comment':
            return drafts === 0 ? null : t(publishConsequenceKey('comment', destination), drafts);
        default:
            return unreachableVerdict(mode);
    }
}

/** Primary-part icon: thumbs up for ship modes. The set has no comment bubble, so Comment has no icon. */
function ShipModeIcon({ mode }: { mode: ShipMode }) {
    const name = shipModeIcon(mode);
    return name === null ? null : <Icon name={name} size={15} className="review-action-bar__thumb" />;
}

function shipModeIcon(mode: ShipMode): IconName | null {
    switch (mode) {
        case 'ship':
        case 'sticky_ship':
            return 'thumb';
        case 'comment':
            return null;
        default:
            return unreachableVerdict(mode);
    }
}
