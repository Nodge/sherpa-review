import type {
    AgentNote,
    FileContent,
    FileDiff,
    PrDiff,
    PrMeta,
    RouteSnapshot,
    Thread,
    UiChatAskAnchor,
    UiReviewLensesResponse,
    UiReviewProgressResponse,
} from '@sherpa/protocol';
import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
    fetchFileContent,
    setReviewThreadResolved,
} from '../api.js';
import { placeRangeQuestion } from '../components/chat-prompts.js';
import type { PrHeaderCounts } from '../components/pr-header.tsx';
import { PrHeader, prHeaderCounts } from '../components/pr-header.tsx';
import { chatAnchorFromSelection, SelectionPopover } from '../components/selection-popover.tsx';
import type { AuthorLens } from '../components/toolbar-controls.tsx';
import { ToolbarRightCluster } from '../components/toolbar-controls.tsx';
import type { DiffClient } from '../diff/client.js';
import { createDiffClient } from '../diff/client.js';
import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { expandContext } from '../diff-view/context-expansion.js';
import type { HunkExpandRequest } from '../diff-view/hunk-expansion.js';
import { hunkContextRequests } from '../diff-view/hunk-expansion.js';
import type { FileExpansion } from '../diff-view/expand.js';
import type { Feedback } from '../diff-view/file-card.tsx';
import { shownFileModel } from '../diff-view/file-card.tsx';
import type { DiffListHandle } from '../diff-view/file-list.tsx';
import { DiffFileList } from '../diff-view/file-list.tsx';
import { findLineRow, flashRow } from '../diff-view/line-target.js';
import { selectedLineRange } from '../diff-view/selection.js';
import type { DiffViewSnapshot, DiffViewStore } from '../diff-view/store.js';
import { createDiffViewStore, fileCollapseReason } from '../diff-view/store.js';
import '../diff-view/diff-view.css';
import type { FileFilter } from '../filters/lens-filters.js';
import {
    ALL_FILTER_ID,
    buildFileFilters,
    filterFiles,
    findFilter,
    PCI_FILTER_ID,
    selectFilter,
    zeroResultText,
} from '../filters/lens-filters.js';
import { readFragmentParam } from '../fragment.js';
import { PENDING_DELAY_MS, useDelayedPending } from '../components/use-delayed-pending.js';
import type { MessageKey } from '../i18n/index.js';
import { shortCommit, useT } from '../i18n/index.js';
import { useTurnNoteIntoDraft } from '../notes/use-note-draft.js';
import type { PaletteNavigation } from '../palette/diff-source.tsx';
import { usePrStateStore } from '../pr-state/context.tsx';
import { collapsedFromMap, collapsedToMap } from '../pr-state/pr-state-store.js';
import { readSelectionLink } from '../selection-link.js';
import { createProgressWriter } from '../progress/progress-writer.js';
import type { ProgressWriter, StopFileWriterHooks, StopWriterHooks } from '../progress/progress-writer.js';
import { buildRouteMargin } from '../route/margin-model.js';
import type { MarginStripActions } from '../route/route-margin.tsx';
import type { SessionStore, ThreadsShow } from '../session/session-store.js';
import { useUiSettingsStore } from '../settings/context.tsx';
import { useShortcut } from '../shortcuts/context.tsx';
import { neighbourId, unreadNeighbourId } from '../shortcuts/navigation.js';
import type { ComposerTransport } from '../threads/composer.js';
import { createComposerTransport } from '../threads/transport.js';
import type { ThreadSourceCounts } from '../threads/model.js';
import { authorDisplayName, countThreadSources, threadFileId, threadIsVisible } from '../threads/model.js';
import { persistentThreadStore } from '../threads/persistent-store.js';
import { createThreadActions } from '../threads/actions.js';
import { openFileComposer, openNewComposer, openReply, OutsideThreads } from '../threads/thread-list.tsx';
import type { ThreadActions } from '../threads/thread-list.tsx';
import type { ThreadStore } from '../threads/store.js';
import type { FileOutlineModel, OutlineEntry } from '../tree/file-panel.tsx';
import { FilePanel } from '../tree/file-panel.tsx';
import './full-diff.css';

/**
 * Full diff view (docs/design/README.md §10): the PR header and sticky toolbar span the full width, with
 * the file tree panel and diff cards below. A single filter model serves the tree and the cards. It lives in the session
 * store and survives reloads through the URL fragment.
 */

export interface FullDiffViewProps {
    readonly token: string;
    readonly prKey: string;
    readonly session: SessionStore;
    readonly pr: PrMeta | null;
    /** Raw patches load at the App level so the palette works over any view. */
    readonly diff: PrDiff | null;
    readonly diffError: string | null;
    readonly lenses: UiReviewLensesResponse | null;
    readonly lensesError: string | null;
    readonly progress: UiReviewProgressResponse | null;
    readonly progressError: string | null;
    /** Shared writer from App: one instance for the panel and Full diff. */
    readonly progressWriter: ProgressWriter | null;
    readonly store: DiffViewStore | null;
    readonly threadStore: ThreadStore | null;
    readonly agentConnected: boolean;
    readonly onAskSelection: (anchor: UiChatAskAnchor) => void;
    readonly isSelectionPending: (anchor: UiChatAskAnchor | null) => boolean;
    readonly onSelectionAnchorChange: (anchor: UiChatAskAnchor | null) => void;
    /**
     * Prefill the chat composer with a question (docs/design/README.md §10). The hatched strip asks about its
     * range. The question stays unsent so the reviewer can read it and send it.
     */
    readonly onComposeQuestion?: (text: string, anchor?: UiChatAskAnchor) => void;
    readonly notes?: readonly AgentNote[];
    readonly onOpenNoteInChat?: (note: AgentNote) => void;
    readonly onDeleteNote?: (noteId: number) => Promise<void>;
    readonly selectionNavigationRequest?: number;
    readonly paletteNavigation?: PaletteNavigation | null;
    readonly onPaletteActiveFileChange?: (fileId: string | null) => void;
    readonly onFilterChangeHandler?: (handler: ((id: string) => void) | null) => void;
    /**
     * Ready route for the reader margins (docs/design/README.md §10). Only `ready`: in `filling`, coverage
     * is incomplete, and "not placed" would misrepresent an empty plan slot. No snapshot means no layer.
     */
    readonly routeSnapshot?: RouteSnapshot | null;
    readonly onJumpToStop?: ((stopId: string) => void) | undefined;
    /** PR below the route threshold: a subdued note in the reader header (docs/design/SPEC-elements.md §4.1). */
    readonly smallPr?: boolean;
    /** Right edge of the PR header: the snapshot picker from App (docs/design/README.md §1). */
    readonly headerAside?: ReactNode;
    /** The tab shows a slice between iterations: the commits on each side. */
    readonly slice?: SliceCommits | null;
    /** Exit the slice: an empty slice or endpoint error returns to the active iteration. */
    readonly onActiveIteration?: () => void;
    /** Skeleton delay (docs/design/SPEC-elements.md §3: nothing for 200 ms). At 0, the gallery shows it immediately. */
    readonly skeletonDelayMs?: number;
}

export interface SliceCommits {
    readonly baseCommit: string;
    readonly headCommit: string;
}

export function FullDiffView({
    token,
    prKey,
    session,
    pr,
    diff,
    diffError,
    lenses,
    lensesError,
    progress,
    progressError,
    progressWriter,
    store,
    threadStore,
    agentConnected,
    onAskSelection,
    isSelectionPending,
    onSelectionAnchorChange,
    onComposeQuestion,
    notes = EMPTY_NOTES,
    onOpenNoteInChat = EMPTY_OPEN_NOTE,
    onDeleteNote = EMPTY_DELETE_NOTE,
    selectionNavigationRequest = 0,
    paletteNavigation = null,
    onPaletteActiveFileChange,
    onFilterChangeHandler,
    routeSnapshot = null,
    onJumpToStop,
    smallPr = false,
    headerAside,
    slice = null,
    onActiveIteration,
    skeletonDelayMs = SKELETON_DELAY_MS,
}: FullDiffViewProps) {
    const t = useT();
    const clientRef = useRef<DiffClient | null>(null);
    // One worker per view, started on the first parse and closed with the view. Use a ref instead of
    // `useMemo`: a closed client cannot restart, and StrictMode mounts the view twice.
    useEffect(
        () => () => {
            clientRef.current?.close();
            clientRef.current = null;
        },
        [],
    );

    const diffId = diff?.diffId ?? null;
    const parse = useCallback(
        (file: FileDiff) => {
            clientRef.current ??= createDiffClient();
            return clientRef.current.parseFile(diffId ?? '', toParseRequest(file));
        },
        [diffId],
    );
    const loadContent = useCallback((fileId: string) => fetchFileContent(token, fileId), [token]);
    const threadTransport = useMemo(() => createComposerTransport(token), [token]);
    const resolveThread = useCallback(
        (threadId: string, resolved: boolean) => setReviewThreadResolved(token, threadId, resolved),
        [token],
    );
    const [fragmentTarget, setFragmentTarget] = useState(() => ({
        fileId: readFragmentParam(window.location.hash, 'file'),
        threadId: readFragmentParam(window.location.hash, 'thread'),
        selection: readSelectionLink(window.location.hash),
    }));
    useEffect(() => {
        const read = (): void => {
            setFragmentTarget({
                fileId: readFragmentParam(window.location.hash, 'file'),
                threadId: readFragmentParam(window.location.hash, 'thread'),
                selection: readSelectionLink(window.location.hash),
            });
        };
        window.addEventListener('hashchange', read);
        return () => {
            window.removeEventListener('hashchange', read);
        };
    }, []);
    const requestedSelectionTarget = useMemo(
        () =>
            selectionNavigationRequest === 0 ? fragmentTarget.selection : readSelectionLink(window.location.hash),
        [fragmentTarget.selection, selectionNavigationRequest],
    );
    const failure = diffError ?? lensesError ?? (progress === null ? progressError : null);
    // The view chrome stays the same in every frame: the PR header with its indicator and the panel stay in place while content
    // loads or fails (docs/design/SPEC-elements.md §3: incoming data does not shift the layout).
    const frame = { pr, counts: diff === null ? null : prHeaderCounts(diff), headerAside };
    if (failure !== null) {
        return (
            <StatusFrame {...frame}>
                <p className="full-diff__status">{failure}</p>
                {slice === null || onActiveIteration === undefined ? null : (
                    <ActiveIterationAction onActiveIteration={onActiveIteration} />
                )}
            </StatusFrame>
        );
    }
    // An empty slice gets its own screen instead of an empty file list: there are no changes between iterations.
    if (slice !== null && diff !== null && diff.files.length === 0) {
        return (
            <StatusFrame {...frame}>
                <div className="full-diff__zero">
                    <p className="full-diff__zero-text">
                        {t('fullDiff.sliceEmpty', shortCommit(slice.baseCommit), shortCommit(slice.headCommit))}
                    </p>
                    {onActiveIteration === undefined ? null : (
                        <button type="button" className="ctl ctl--secondary full-diff__zero-action" onClick={onActiveIteration}>
                            {t('iteration.toActive')}
                        </button>
                    )}
                </div>
            </StatusFrame>
        );
    }
    // Empty PR (docs/design/SPEC-elements.md §4.1): no changes at all, so show a dedicated screen instead of an empty file list.
    // The action panel lives one level up and stays in place: an empty PR can still be shipped.
    if (slice === null && diff !== null && diff.files.length === 0) {
        return (
            <StatusFrame {...frame}>
                <EmptyPrNotice />
            </StatusFrame>
        );
    }
    if (
        pr === null ||
        diff === null ||
        lenses === null ||
        progress === null ||
        progressWriter === null ||
        store === null ||
        threadStore === null
    ) {
        return (
            <StatusFrame {...frame}>
                <DiffSkeleton delayMs={skeletonDelayMs} note={slice === null ? null : SLICE_LOADING_NOTE} />
            </StatusFrame>
        );
    }

    return (
        <DiffWorkspace
            pr={pr}
            diff={diff}
            lenses={lenses}
            progress={progress}
            prKey={prKey}
            session={session}
            store={store}
            threadStore={threadStore}
            paletteNavigation={paletteNavigation}
            {...(onPaletteActiveFileChange === undefined ? {} : { onPaletteActiveFileChange })}
            {...(onFilterChangeHandler === undefined ? {} : { onFilterChangeHandler })}
            parse={parse}
            loadContent={loadContent}
            progressWriter={progressWriter}
            threadTransport={threadTransport}
            onResolveThread={resolveThread}
            initialFileId={requestedSelectionTarget?.fileId ?? fragmentTarget.fileId}
            initialThreadId={fragmentTarget.threadId}
            initialSelectionTarget={requestedSelectionTarget}
            selectionNavigationRequest={selectionNavigationRequest}
            agentConnected={agentConnected}
            onAskSelection={onAskSelection}
            isSelectionPending={isSelectionPending}
            onSelectionAnchorChange={onSelectionAnchorChange}
            {...(onComposeQuestion === undefined ? {} : { onComposeQuestion })}
            notes={notes}
            onOpenNoteInChat={onOpenNoteInChat}
            onDeleteNote={onDeleteNote}
            routeSnapshot={routeSnapshot}
            onJumpToStop={onJumpToStop}
            smallPr={smallPr}
            {...(headerAside === undefined ? {} : { headerAside })}
            slice={slice}
        />
    );
}

/** Skeleton delay: nothing flashes for the first 200 ms (docs/design/SPEC-elements.md §3). */
const SKELETON_DELAY_MS = PENDING_DELAY_MS;

/**
 * The host calculates the slice (2.8–3.7 s on the review host), so text explains the wait. The host
 * is unnamed here: the UI does not distinguish hosts, and the name only lives in App state.
 */
const SLICE_LOADING_NOTE: MessageKey = 'fullDiff.slice.loading';

/**
 * Status frame: the PR header with its `aside` (the slice indicator and picker stay in place
 * throughout the wait), the same toolbar and the same file panel and card column as
 * the loaded view. No counters until the diff arrives, so the metadata row omits them.
 */
function StatusFrame({
    pr,
    counts,
    headerAside,
    children,
}: {
    pr: PrMeta | null;
    counts: PrHeaderCounts | null;
    headerAside?: ReactNode;
    children: ReactNode;
}) {
    const t = useT();
    return (
        <main className="full-diff full-diff--status">
            {pr === null ? null : (
                <PrHeader
                    pr={pr}
                    counts={counts}
                    pci={null}
                    pciActive={false}
                    onTogglePci={NO_PCI_TOGGLE}
                    aside={headerAside}
                />
            )}
            <div className="full-diff__toolbar">
                <h1 className="full-diff__title">{t('view.diff')}</h1>
            </div>
            <div className="full-diff__body">
                <div className="full-diff__panel-placeholder" aria-hidden="true" />
                <div className="full-diff__main">{children}</div>
            </div>
        </main>
    );
}

/** Empty PR screen (docs/design/SPEC-elements.md §4.1). Overview shows the same two lines. */
export function EmptyPrNotice() {
    const t = useT();
    return (
        <div className="full-diff__zero full-diff__zero--empty-pr">
            <p className="full-diff__zero-text">{t('emptyPr.title')}</p>
            <p className="full-diff__zero-note">{t('emptyPr.text')}</p>
        </div>
    );
}

/** No PCI chip in the status frame, since lenses have not loaded yet. */
const NO_PCI_TOGGLE = (): void => undefined;

function ActiveIterationAction({ onActiveIteration }: { onActiveIteration: () => void }) {
    const t = useT();
    return (
        <div className="full-diff__status-actions">
            <button type="button" className="ctl ctl--secondary full-diff__zero-action" onClick={onActiveIteration}>
                {t('iteration.toActive')}
            </button>
        </div>
    );
}

/**
 * File list skeleton (docs/design/SPEC-elements.md §3: "per-file skeleton cards, 3 visible"). The first 200 ms show
 * nothing so a fast response does not flash. Each card has the height of a collapsed file card,
 * so incoming data does not shift the layout.
 */
function DiffSkeleton({ delayMs, note }: { delayMs: number; note: MessageKey | null }) {
    const t = useT();
    const shown = useDelayedPending(true, delayMs);

    if (!shown) {
        return null;
    }
    return (
        <div className="full-diff__skeleton" role="status" aria-label={t('fullDiff.skeleton.aria')}>
            {note === null ? null : <p className="full-diff__skeleton-note">{t(note)}</p>}
            {SKELETON_CARDS.map((card) => (
                <div key={card} className="diff-skeleton-card" aria-hidden="true">
                    <div className="diff-skeleton-card__head" />
                    <div className="diff-skeleton-card__row" />
                </div>
            ))}
        </div>
    );
}

const SKELETON_CARDS = [0, 1, 2] as const;

/** "Expand file" in a slice: head content cannot be mapped to its `fileId`. */
const SLICE_NO_CONTENT_REASON: MessageKey = 'fullDiff.slice.noContent';

/** "Ask agent" in a slice: the question would anchor to a `fileId` absent from the iteration. */
const SLICE_NO_ASK_REASON: MessageKey = 'fullDiff.slice.noAsk';

export interface DiffWorkspaceProps {
    readonly pr: PrMeta;
    readonly diff: PrDiff;
    readonly lenses: UiReviewLensesResponse;
    /** Initial reading progress. Without it, the store uses defaults (the gallery supplies a store). */
    readonly progress?: UiReviewProgressResponse;
    readonly threads?: readonly Thread[];
    readonly prKey: string;
    readonly session: SessionStore;
    /** See the comment on `parse` in `diff-view/file-list.tsx`. */
    readonly parse: (file: FileDiff) => Promise<DiffFileModel>;
    readonly loadContent: (fileId: string) => Promise<FileContent | null>;
    /** Write a mark for a standalone workspace (gallery and tests). */
    readonly onSetViewed?: (fileId: string, viewed: boolean) => Promise<number>;
    /** In the application, one writer is created one level up and survives Full diff remounts. */
    readonly progressWriter?: ProgressWriter;
    /** Reread progress on an SSE event for a standalone workspace. */
    readonly reloadProgress?: () => Promise<UiReviewProgressResponse>;
    readonly progressRevision?: number | null;
    readonly reloadThreads?: () => Promise<readonly Thread[]>;
    readonly threadsRevision?: number | null;
    readonly threadTransport?: ComposerTransport;
    readonly onResolveThread?: (threadId: string, resolved: boolean) => Promise<void>;
    readonly initialFileId?: string | null;
    readonly initialThreadId?: string | null;
    readonly initialSelectionTarget?: { readonly fileId: string; readonly side: 'old' | 'new'; readonly start: number } | null;
    readonly selectionNavigationRequest?: number;
    readonly agentConnected?: boolean;
    readonly onAskSelection?: (anchor: UiChatAskAnchor) => void;
    readonly isSelectionPending?: (anchor: UiChatAskAnchor | null) => boolean;
    readonly onSelectionAnchorChange?: (anchor: UiChatAskAnchor | null) => void;
    /** See `FullDiffViewProps.onComposeQuestion`. Without it, the strip has no "place" button. */
    readonly onComposeQuestion?: (text: string, anchor?: UiChatAskAnchor) => void;
    readonly notes?: readonly AgentNote[];
    readonly onOpenNoteInChat?: (note: AgentNote) => void;
    readonly onDeleteNote?: (noteId: number) => Promise<void>;
    /** Ready route in the reader margins (docs/design/README.md §10). At null, Full diff has no route. */
    readonly routeSnapshot?: RouteSnapshot | null;
    readonly onJumpToStop?: ((stopId: string) => void) | undefined;
    /** See `FullDiffViewProps.smallPr`. */
    readonly smallPr?: boolean;
    /** See `FullDiffViewProps.headerAside`. */
    readonly headerAside?: ReactNode;
    /**
     * The tab shows a slice between iterations: its `fileId` values belong to another
     * namespace, so file contents are not requested from the host.
     */
    readonly slice?: SliceCommits | null;
    /** Fixed clock for the gallery. The application captures the time when the view mounts. */
    readonly threadNow?: number;
    /** Diff view store. Without it, a new one is created. The gallery supplies a prefilled store. */
    readonly store?: DiffViewStore;
    readonly threadStore?: ThreadStore;
    readonly paletteNavigation?: PaletteNavigation | null;
    readonly onPaletteActiveFileChange?: (fileId: string | null) => void;
    readonly onFilterChangeHandler?: (handler: ((id: string) => void) | null) => void;
    /** Gallery only: the "outside the diff" group in the footer must appear expanded. */
    readonly outsideThreadsOpen?: boolean;
}

export function DiffWorkspace(props: DiffWorkspaceProps) {
    const t = useT();
    const {
        pr,
        diff,
        lenses,
        prKey,
        session,
        parse,
        loadContent,
        onSetViewed = EMPTY_SET_VIEWED,
        reloadProgress,
        progressRevision = null,
        reloadThreads,
        threadsRevision = null,
        initialFileId = null,
        initialThreadId = null,
        initialSelectionTarget = null,
        selectionNavigationRequest = 0,
        agentConnected = false,
        onAskSelection = EMPTY_ASK_SELECTION,
        isSelectionPending = NO_SELECTION_PENDING,
        onSelectionAnchorChange = NO_SELECTION_ANCHOR_CHANGE,
        onComposeQuestion,
        notes = EMPTY_NOTES,
        onOpenNoteInChat = EMPTY_OPEN_NOTE,
        onDeleteNote = EMPTY_DELETE_NOTE,
        routeSnapshot = null,
        onJumpToStop,
        paletteNavigation = null,
        onPaletteActiveFileChange,
        onFilterChangeHandler,
        outsideThreadsOpen = false,
        slice = null,
    } = props;
    /** File contents are requested by iteration `fileId`: slice IDs belong to another namespace. */
    const contentAvailable = pr.capabilities.fileContent && slice === null;
    // For the same reason, asking the agent is disabled in a slice: the question would anchor to a `fileId` absent
    // from the active iteration, and the answer note would lose its file. The selection also stays out of
    // the chat composer because there is no way to anchor it there.
    const selectionAnchorChange = slice === null ? onSelectionAnchorChange : NO_SELECTION_ANCHOR_CHANGE;
    const [threadNow] = useState(() => props.threadNow ?? Date.now());
    // Card collapse state comes from the PR state on the server. Capture it once so
    // a late endpoint response does not recreate the store while the reviewer is reading.
    const prState = usePrStateStore();
    const initialCollapsed = useMemo(() => collapsedToMap(prState.getSnapshot().diffCollapsed), [prState]);

    const initialProgress = props.progress;
    const settings = useUiSettingsStore();
    const createdStore = useMemo(
        () =>
            createDiffViewStore({
                files: diff.files,
                ...(initialProgress === undefined ? {} : { progress: initialProgress.files }),
                collapsed: initialCollapsed,
                // Only the gallery and tests use a private store here, but they still take the mode from settings.
                diffMode: settings.getSnapshot().diffMode,
                onDiffModeChange: (mode) => {
                    settings.update({ diffMode: mode });
                },
            }),
        [diff, initialCollapsed, initialProgress, settings],
    );
    const store = props.store ?? createdStore;
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    useEffect(() => {
        // With a supplied store, the view does not own collapse state. The store creator (App) writes it.
        if (props.store === undefined) {
            prState.update({ diffCollapsed: collapsedFromMap(snapshot.collapsePreferences) });
        }
    }, [prState, props.store, snapshot.collapsePreferences]);
    useEffect(() => {
        if (props.store !== undefined && props.progressWriter === undefined && initialProgress !== undefined) {
            store.setProgress(initialProgress.files);
        }
    }, [initialProgress, props.progressWriter, props.store, store]);
    const fileIds = useMemo(() => new Set(diff.files.map((file) => file.fileId)), [diff.files]);
    const initialThreads = props.threads ?? EMPTY_THREADS;
    const threadStore = useMemo(
        () => props.threadStore ?? persistentThreadStore(prKey, diff.diffId, initialThreads, fileIds),
        [diff.diffId, fileIds, initialThreads, prKey, props.threadStore],
    );
    useEffect(() => {
        if (props.threads !== undefined) {
            threadStore.setServerThreads(props.threads);
        }
    }, [props.threads, threadStore]);
    const threadSnapshot = useSyncExternalStore(threadStore.subscribe, threadStore.getSnapshot);
    const threadTransport = props.threadTransport ?? EMPTY_THREAD_TRANSPORT;
    const resolveThread = props.onResolveThread ?? EMPTY_RESOLVE;
    const threadActions = useMemo<ThreadActions>(
        () => createThreadActions(threadStore, threadTransport, resolveThread),
        [resolveThread, threadStore, threadTransport],
    );
    const turnNoteIntoDraft = useTurnNoteIntoDraft({
        threadStore,
        clearSelection: store.clearSelection,
        commentIssues: pr.capabilities.commentIssues,
    });
    const noteActions = useMemo(
        () => ({ onOpenInChat: onOpenNoteInChat, onTurnIntoDraft: turnNoteIntoDraft, onDelete: onDeleteNote }),
        [onDeleteNote, onOpenNoteInChat, turnNoteIntoDraft],
    );
    const { filter: filterId, threadsShow, threadAuthor } = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const filters = useMemo(
        () => buildFileFilters({ files: diff.files, ownership: lenses.ownership, extra: lenses.extra, t }),
        [diff.files, lenses, t],
    );
    const filter = selectFilter(filters, filterId);

    // An unknown or disabled filter in the URL is corrected in the URL itself. Otherwise, the link
    // would keep promising a view that does not exist.
    useEffect(() => {
        if (filter.id !== filterId) {
            session.setFilter(filter.id);
        }
    }, [filter.id, filterId, session]);

    // The top card in the viewport tells the view which file the reviewer is reading now.
    // Filter changes ("kept in view", docs/design/SPEC-elements.md §2.7) and navigation to the next file after
    // marking both need it, so a ref also holds it for handlers to read without being recreated.
    const [topFileId, setTopFileId] = useState<string | null>(null);
    const topRef = useRef<string | null>(null);
    useEffect(() => {
        topRef.current = topFileId;
    }, [topFileId]);

    // Reading progress: optimistic writes, rollback on failure and tab synchronization through SSE.
    // `ProgressWriter` handles write order, rollback and revisions. The view only renders.
    const [writesSettled, setWritesSettled] = useState(0);
    const [writeError, setWriteError] = useState<{ fileId: string; viewed: boolean } | null>(null);
    const createdWriter = useMemo(
        () =>
            createProgressWriter({
                initialRevision: initialProgress?.progressRevision ?? 0,
                read: (fileId) => store.getSnapshot().progress.get(fileId) ?? null,
                apply: store.markViewed,
                restore: store.restoreProgress,
                send: onSetViewed,
                // Full diff has no stop marks: the route has its own view.
                stops: NO_STOP_WRITES,
                stopFiles: NO_STOP_FILE_WRITES,
                // In-flight writes defer the reread. The decision is reconsidered after the response.
                onSettled: () => {
                    setWritesSettled((settled) => settled + 1);
                },
            }),
        [initialProgress?.progressRevision, onSetViewed, store],
    );
    const writer = props.progressWriter ?? createdWriter;

    /**
     * The file from which the screen moves to the next one after marking. An effect computes and
     * starts the navigation because the list still has the old card heights in the handler. The list
     * receives the same id and does not anchor to the collapsed card.
     */
    const [advanceFrom, setAdvanceFrom] = useState<string | null>(null);

    const markViewed = useCallback(
        async function mark(fileId: string, viewed: boolean): Promise<Feedback> {
            setWriteError(null);
            // "Scrolling follows collapsing": when the reviewer marks the file
            // they are reading, the screen moves to the next one. Clearing a mark, marking
            // any other file and noninteractive toggles leave scrolling alone.
            if (viewed && fileId === topRef.current) {
                setAdvanceFrom(fileId);
            }
            if (await writer.write(fileId, viewed)) {
                return null;
            }
            // The optimistic write failed: the control has already returned to its previous state (docs/design/SPEC-elements.md §1.2),
            // so all that remains is offering a retry.
            return { text: t('diff.file.notSaved'), retry: () => mark(fileId, viewed) };
        },
        [t, writer],
    );

    /**
     * A write from the tree: the tree row has no room for a hint, so the panel shows
     * the failure. The marked file card may not even be in the DOM (virtualization).
     */
    const writeFromTree = useCallback(
        (fileId: string, viewed: boolean) => {
            void markViewed(fileId, viewed).then((feedback) => {
                setWriteError(feedback === null ? null : { fileId, viewed });
            });
        },
        [markViewed],
    );

    // Toggle with `v`: read the state from the store because the key event carries none.
    const toggleViewed = useCallback(
        (fileId: string) => {
            writeFromTree(fileId, store.getSnapshot().readState.get(fileId)?.state !== 'read');
        },
        [store, writeFromTree],
    );

    // `writesSettled` is a dependency for the deferred decision: our write event arrives
    // before the endpoint response, and without reevaluation it would leave an extra request.
    useEffect(() => {
        if (reloadProgress === undefined || !writer.shouldReload(progressRevision)) {
            return;
        }
        let alive = true;
        const mark = writer.beginReload();
        void reloadProgress().then(
            (response) => {
                const merged = alive ? writer.finishReload(response, mark) : null;
                if (merged !== null) {
                    store.setProgress(merged.files);
                }
            },
            () => {
                // Progress could not be reread. Keep the last known state on screen.
            },
        );
        return () => {
            alive = false;
        };
    }, [progressRevision, writesSettled, reloadProgress, store, writer]);

    const seenThreadsRevision = useRef<number | null>(null);
    const [threadsReloadAttempt, setThreadsReloadAttempt] = useState(0);
    useEffect(() => {
        if (
            reloadThreads === undefined ||
            threadsRevision === null ||
            threadsRevision === seenThreadsRevision.current
        ) {
            return;
        }
        let alive = true;
        let retry: ReturnType<typeof setTimeout> | null = null;
        void reloadThreads().then(
            (threads) => {
                if (alive) {
                    threadStore.setServerThreads(threads);
                    seenThreadsRevision.current = threadsRevision;
                    setThreadsReloadAttempt(0);
                }
            },
            () => {
                if (alive) {
                    // The revision was not marked as seen: retry the same snapshot without a new host write.
                    retry = setTimeout(() => {
                        setThreadsReloadAttempt((attempt) => attempt + 1);
                    }, Math.min(1000 * 2 ** threadsReloadAttempt, 15_000));
                }
            },
        );
        return () => {
            alive = false;
            if (retry !== null) {
                clearTimeout(retry);
            }
        };
    }, [reloadThreads, threadStore, threadsReloadAttempt, threadsRevision]);

    const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
    const [scrollMarginElement, setScrollMarginElement] = useState<HTMLElement | null>(null);
    const listRef = useRef<DiffListHandle | null>(null);
    const [toolbarHeight, setToolbarHeight] = useState<number | null>(null);
    const [viewportHeight, setViewportHeight] = useState<number | null>(null);

    // The tree panel uses the scrollport height, not the window height: a top bar and banner may sit above the view.
    useLayoutEffect(() => {
        if (scrollElement === null) {
            return;
        }
        const report = (): void => {
            setViewportHeight(scrollElement.clientHeight);
        };
        report();
        const observer = new ResizeObserver(report);
        observer.observe(scrollElement);
        return () => {
            observer.disconnect();
        };
    }, [scrollElement]);
    const linkedThread = useMemo(
        () => threadSnapshot.threads.find((thread) => thread.id === initialThreadId) ?? null,
        [initialThreadId, threadSnapshot.threads],
    );
    // A thread's `fileId` comes from the active iteration, so find the file by `path` in a previous one.
    const linkedFileId = useMemo(
        () => (linkedThread === null ? null : threadFileId(linkedThread, threadSnapshot.iterationLayout)),
        [linkedThread, threadSnapshot.iterationLayout],
    );
    const [keptFileId, setKeptFileId] = useState<string | null>(null);

    // The reviewer's next scroll clears the mark (docs/design/SPEC-elements.md §2.7). The list itself
    // distinguishes its own scroll adjustments: programmatic scrolling does not reach this handler.
    const onScroll = useCallback(() => {
        setKeptFileId(null);
    }, []);

    // The file to scroll back to after the list changes. Scrolling directly in
    // the handler would use the old set of files and therefore the wrong index.
    const pendingScroll = useRef<string | null>(null);

    const changeFilter = useCallback(
        (id: string) => {
            const next = selectFilter(filters, id);
            if (next.id === filter.id) {
                return;
            }
            const top = topRef.current;
            const kept = top !== null && next.fileIds !== null && !next.fileIds.has(top) ? top : null;
            setKeptFileId(kept);
            // Nothing under the cursor disappears (docs/design/SPEC-elements.md §2.7), and scrolling anchors to the top
            // card (docs/design/SPEC-elements.md §2.6): the list returns to it automatically after a filter change.
            pendingScroll.current = kept ?? top;
            session.setFilter(next.id);
        },
        [filter.id, filters, session],
    );
    useEffect(() => {
        if (onFilterChangeHandler === undefined) {
            return;
        }
        onFilterChangeHandler(changeFilter);
        return () => {
            onFilterChangeHandler(null);
        };
    }, [changeFilter, onFilterChangeHandler]);

    const shown = useMemo(() => {
        const ids = filter.fileIds;
        if (ids === null) {
            return diff.files;
        }
        return diff.files.filter(
            (file) =>
                ids.has(file.fileId) ||
                file.fileId === keptFileId ||
                file.fileId === linkedFileId ||
                file.fileId === initialFileId,
        );
    }, [diff.files, filter, initialFileId, keptFileId, linkedFileId]);
    const treeFiles = useMemo(() => filterFiles(diff.files, filter), [diff.files, filter]);

    useEffect(() => {
        if (initialThreadId === null) {
            return;
        }
        if (linkedFileId !== null) {
            void listRef.current?.scrollToFile(linkedFileId);
        }
        const selector = `#thread-${CSS.escape(initialThreadId)}`;
        const scroll = (): boolean => {
            const element = document.querySelector<HTMLElement>(selector);
            if (element === null) {
                return false;
            }
            element.scrollIntoView({ block: 'center' });
            element.focus({ preventScroll: true });
            return true;
        };
        if (scroll()) {
            return;
        }
        const observer = new MutationObserver(() => {
            if (scroll()) {
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        return () => {
            observer.disconnect();
        };
    }, [
        initialThreadId,
        linkedFileId,
        shown,
        snapshot.expansion,
        snapshot.models,
        snapshot.whitespaceShown,
    ]);

    // Use an effect instead of a handler call: by this point the list has rerendered with the new set
    // of files, and its imperative API knows the right index.
    useEffect(() => {
        const target = pendingScroll.current;
        if (target === null) {
            return;
        }
        pendingScroll.current = null;
        void listRef.current?.scrollToFile(target);
    }, [shown]);

    // Move to the next file after marking. Compute the target here instead of in the handler:
    // the mark is already in the store, and we can see which cards below are collapsed. Wait one more frame
    // so the list can replace the collapsed card's measurement with its new estimate.
    useEffect(() => {
        if (advanceFrom === null) {
            return;
        }
        const snapshot = store.getSnapshot();
        const next = nextFileToAdvance(shown, advanceFrom, (file) => fileCollapseReason(snapshot, file) !== null);
        if (next === null) {
            setAdvanceFrom(null);
            return;
        }
        const frame = requestAnimationFrame(() => {
            setAdvanceFrom(null);
            // Leave the target collapsed: navigation expands neither viewed nor generated files.
            void listRef.current?.scrollToFile(next, { reveal: false });
        });
        return () => {
            cancelAnimationFrame(frame);
        };
    }, [advanceFrom, shown, store]);

    const pci = findFilter(filters, PCI_FILTER_ID);
    // The reference must stay stable because rebuilding the tree depends on it.
    const emptyIds = useMemo(() => new Set<string>(), []);
    const pciFileIds = pci?.fileIds ?? emptyIds;
    const mineFileIds = useMemo(() => {
        const { ownership } = lenses;
        if (ownership?.available !== true) {
            return null;
        }
        const paths = new Set(ownership.paths);
        return new Set(diff.files.filter((file) => paths.has(file.path)).map((file) => file.fileId));
    }, [diff.files, lenses]);

    /**
     * Route in the margins (docs/design/README.md §10). The file→stops map is computed from anchors and available immediately.
     * Uncovered ranges come from parsed patches, so files the reviewer has not
     * scrolled to are parsed in the background. Otherwise the footer note counts would never add up.
     */
    const [failedParse, setFailedParse] = useState<ReadonlySet<string>>(EMPTY_FILE_IDS);
    // "Already parsed" is a property of a specific store: models live there, and when the diff changes
    // (recreating the store), the same fileId values need parsing again. Otherwise, they would remain
    // undercounted in the note forever.
    const backgroundParsed = useRef<{ store: DiffViewStore; ids: Set<string> }>({ store, ids: new Set() });
    useEffect(() => {
        if (backgroundParsed.current.store !== store) {
            backgroundParsed.current = { store, ids: new Set() };
            setFailedParse((previous) => (previous.size === 0 ? previous : EMPTY_FILE_IDS));
        }
        if (routeSnapshot === null) {
            return;
        }
        const timer = setTimeout(() => {
            const parsed = backgroundParsed.current.ids;
            for (const file of diff.files) {
                if (parsed.has(file.fileId) || store.getSnapshot().models.has(file.fileId)) {
                    continue;
                }
                parsed.add(file.fileId);
                void parse(file).then(
                    (model) => {
                        store.setModel(file.fileId, model);
                    },
                    () => {
                        // Patch parsing failed: its lines will not count, and the note will say so.
                        setFailedParse((previous) => new Set(previous).add(file.fileId));
                    },
                );
            }
        }, BACKGROUND_PARSE_DELAY);
        return () => {
            clearTimeout(timer);
        };
    }, [diff.files, parse, routeSnapshot, store]);
    const routeMargin = useMemo(
        () =>
            routeSnapshot === null
                ? null
                : buildRouteMargin({
                      snapshot: routeSnapshot,
                      files: diff.files,
                      models: snapshot.models,
                      failed: failedParse,
                  }),
        [diff.files, failedParse, routeSnapshot, snapshot.models],
    );
    // Strip entry point (docs/design/README.md §10): a question anchored to this exact range. While the question
    // is in flight, the strip shows a chip using the same flag as the selection popover.
    const marginActions = useMemo<MarginStripActions | null>(
        () =>
            onComposeQuestion === undefined
                ? null
                : {
                      agentConnected,
                      isPending: isSelectionPending,
                      onAskToPlace: (anchor) => {
                          onComposeQuestion(placeRangeQuestion(anchor, t), anchor);
                      },
                  },
        [agentConnected, isSelectionPending, onComposeQuestion, t],
    );

    const [focusedLine, setFocusedLine] = useState<{
        fileId: string;
        side: 'old' | 'new';
        line: number;
    } | null>(null);
    const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
    const activePaletteFileId = focusedLine?.fileId ?? selectedFileId ?? topFileId;
    useEffect(() => {
        onPaletteActiveFileChange?.(activePaletteFileId);
    }, [activePaletteFileId, onPaletteActiveFileChange]);

    const openFile = useCallback(
        (fileId: string) => {
            setSelectedFileId(fileId);
            if (!shown.some((file) => file.fileId === fileId)) {
                pendingScroll.current = fileId;
                setKeptFileId(null);
                session.setFilter(ALL_FILTER_ID);
                return;
            }
            void listRef.current?.scrollToFile(fileId);
        },
        [session, shown],
    );

    const lineNavigationCleanup = useRef<(() => void) | null>(null);
    const lineNavigationId = useRef(0);
    useEffect(
        () => () => {
            lineNavigationId.current += 1;
            lineNavigationCleanup.current?.();
        },
        [],
    );
    const goToLine = useCallback(
        async (fileId: string, side: 'old' | 'new', line: number, highlight = true): Promise<void> => {
            lineNavigationId.current += 1;
            const navigationId = lineNavigationId.current;
            lineNavigationCleanup.current?.();
            lineNavigationCleanup.current = null;

            // Every fold must expand before scrolling and looking up the DOM target (docs/design/SPEC-elements.md §2.11).
            store.revealFile(fileId);
            store.openFile(fileId);
            store.showWhitespace(fileId);
            const converged = await (listRef.current?.scrollToFile(fileId) ?? Promise.resolve(false));
            if (!converged || navigationId !== lineNavigationId.current) {
                return;
            }

            let observer: MutationObserver | null = null;
            let timeout: ReturnType<typeof setTimeout> | null = null;
            const stop = (): void => {
                observer?.disconnect();
                observer = null;
                if (timeout !== null) {
                    clearTimeout(timeout);
                    timeout = null;
                }
                if (lineNavigationCleanup.current === stop) {
                    lineNavigationCleanup.current = null;
                }
            };
            const reveal = (): boolean => {
                const card = document.querySelector<HTMLElement>(`[data-file="${CSS.escape(fileId)}"]`);
                if (card === null) {
                    return false;
                }
                const row = findLineRow(card, side, line);
                if (row === null) {
                    return false;
                }
                row.scrollIntoView({ block: 'center' });
                if (highlight) {
                    flashRow(row);
                }
                stop();
                return true;
            };

            lineNavigationCleanup.current = stop;
            if (reveal()) {
                return;
            }

            let expansionStarted = false;
            const expandHiddenContext = (): void => {
                if (expansionStarted || !store.getSnapshot().models.has(fileId)) {
                    return;
                }
                expansionStarted = true;
                void expandContext({
                    store,
                    fileId,
                    request: { kind: 'file' },
                    contentAvailable,
                    loadContent,
                    t,
                }).then(() => {
                    if (navigationId === lineNavigationId.current) {
                        reveal();
                    }
                });
            };
            observer = new MutationObserver(() => {
                if (!reveal()) {
                    expandHiddenContext();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
            timeout = setTimeout(stop, LINE_NAVIGATION_SEARCH_MS);
            expandHiddenContext();
        },
        [contentAvailable, loadContent, store, t],
    );
    const openedSelectionTarget = useRef<string | null>(null);
    useEffect(() => {
        if (initialSelectionTarget === null) {
            openedSelectionTarget.current = null;
            return;
        }
        const key = `${initialSelectionTarget.fileId}:${initialSelectionTarget.side}:${String(initialSelectionTarget.start)}:${String(selectionNavigationRequest)}`;
        if (openedSelectionTarget.current === key) {
            return;
        }
        openedSelectionTarget.current = key;
        void goToLine(initialSelectionTarget.fileId, initialSelectionTarget.side, initialSelectionTarget.start, false);
    }, [goToLine, initialSelectionTarget, selectionNavigationRequest]);

    const handledPaletteNavigation = useRef<number | null>(null);
    useEffect(() => {
        const navigation = paletteNavigation;
        if (navigation === null || handledPaletteNavigation.current === navigation.id) {
            return;
        }
        const { target } = navigation;
        setSelectedFileId(target.fileId);
        if (!shown.some((file) => file.fileId === target.fileId)) {
            // Do not set the usual pendingScroll: it preserves position on filter changes
            // and must not fire later after the palette has already navigated.
            pendingScroll.current = null;
            setKeptFileId(null);
            session.setFilter(ALL_FILTER_ID);
            return;
        }

        handledPaletteNavigation.current = navigation.id;
        if (target.kind === 'file') {
            void listRef.current?.scrollToFile(target.fileId);
        } else {
            void goToLine(target.fileId, target.side, target.line);
        }
    }, [goToLine, paletteNavigation, session, shown]);

    // Outline for a single-file PR: hunks from the parsed model (docs/design/SPEC-elements.md §2.20).
    const only = diff.files.length === 1 ? diff.files[0] : undefined;
    // If the only file is filtered out, there is no outline. The panel must say
    // that this filter is empty.
    const outline = useMemo(
        () =>
            only === undefined || treeFiles.length === 0
                ? null
                : outlineOf(snapshot.models.get(only.fileId) ?? null),
        [only, treeFiles, snapshot.models],
    );
    const openHunk = useCallback(
        (index: number) => {
            if (only === undefined) {
                return;
            }
            // There is no symbol navigation, so this approximates it: a single-file PR card is always
            // in the DOM, and native scrolling is enough to reach the hunk start.
            document
                .querySelector(`[data-file="${CSS.escape(only.fileId)}"] [data-hunk="${String(index)}"]`)
                ?.scrollIntoView({ block: 'start' });
        },
        [only],
    );

    const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
    const focusLine = useCallback((fileId: string, side: 'old' | 'new', line: number) => {
        setFocusedLine({ fileId, side, line });
        setSelectedFileId(fileId);
    }, []);
    const blurLine = useCallback(() => {
        setFocusedLine(null);
    }, []);
    const commentLine = useCallback(
        (fileId: string, side: 'old' | 'new', line: number) => {
            const file = diff.files.find((candidate) => candidate.fileId === fileId);
            if (file === undefined) {
                return;
            }
            const position = commentPosition(snapshot.selection, shownModelOf(snapshot, fileId), fileId, side, line);
            const key = `new:${fileId}:${position.side}:${String(position.line)}`;
            openNewComposer(threadStore, key, { fileId, path: file.path, position }, pr.capabilities.commentIssues);
            // The range moved into the composer, so the live selection is no longer needed. Leaving it
            // would keep the line pencil visible and mix it into the next comment.
            store.clearSelection();
        },
        [diff.files, pr.capabilities.commentIssues, snapshot, store, threadStore],
    );

    const commentFile = useCallback(
        (fileId: string) => {
            const file = diff.files.find((candidate) => candidate.fileId === fileId);
            if (file !== undefined) {
                openFileComposer(threadStore, fileId, file.path, pr.capabilities.commentIssues);
            }
        },
        [diff.files, pr.capabilities.commentIssues, threadStore],
    );

    useShortcut({
        id: 'thread.commentLine',
        keys: ['c'],
        label: 'shortcut.thread.commentLine',
        scope: 'full-diff',
        section: 'comments',
        when: () => focusedLine !== null,
        action: () => {
            if (focusedLine !== null) {
                commentLine(focusedLine.fileId, focusedLine.side, focusedLine.line);
            }
        },
    });
    useShortcut({
        id: 'thread.reply',
        keys: ['r'],
        label: 'shortcut.thread.reply',
        scope: 'full-diff',
        section: 'comments',
        when: () => focusedThreadId !== null,
        action: () => {
            const thread = threadSnapshot.threads.find((candidate) => candidate.id === focusedThreadId);
            if (thread !== undefined) {
                openReply(threadStore, thread);
            }
        },
    });

    const searchRef = useRef<HTMLInputElement | null>(null);
    useShortcut({
        id: 'diff.filterFiles',
        keys: ['f'],
        label: 'shortcut.diff.filterFiles',
        scope: 'full-diff',
        section: 'navigation',
        action: () => {
            searchRef.current?.focus();
        },
    });

    // --- Full diff navigation keys (docs/design/SPEC-elements.md §5) ---

    /**
     * Scroll to a file without expanding it: `j`/`k`/`n`/`p` follow the list just like navigation
     * after marking and leave a collapsed target alone.
     */
    const goToFileQuietly = useCallback((fileId: string | null) => {
        if (fileId !== null) {
            void listRef.current?.scrollToFile(fileId, { reveal: false });
        }
    }, []);
    useShortcut({
        id: 'diff.nextFile',
        keys: ['j'],
        label: 'shortcut.diff.nextFile',
        scope: 'full-diff',
        section: 'navigation',
        action: () => {
            goToFileQuietly(neighbourId(shown, topRef.current, 1, fileIdOf));
        },
    });
    useShortcut({
        id: 'diff.prevFile',
        keys: ['k'],
        label: 'shortcut.diff.prevFile',
        scope: 'full-diff',
        section: 'navigation',
        action: () => {
            goToFileQuietly(neighbourId(shown, topRef.current, -1, fileIdOf));
        },
    });
    /**
     * `n`/`p` go to the next unread file. `partial` counts as unviewed because it
     * still has unseen lines. Navigation works at file level: the keys
     * do not jump to ranges within a file.
     */
    const goToUnread = useCallback(
        (direction: 1 | -1) => {
            const readState = store.getSnapshot().readState;
            goToFileQuietly(
                unreadNeighbourId(
                    shown,
                    topRef.current,
                    direction,
                    fileIdOf,
                    (file) => readState.get(file.fileId)?.state !== 'read',
                ),
            );
        },
        [goToFileQuietly, shown, store],
    );
    useShortcut({
        id: 'diff.nextUnread',
        keys: ['n'],
        label: 'shortcut.diff.nextUnread',
        scope: 'full-diff',
        section: 'reading',
        action: () => {
            goToUnread(1);
        },
    });
    useShortcut({
        id: 'diff.prevUnread',
        keys: ['p'],
        label: 'shortcut.diff.prevUnread',
        scope: 'full-diff',
        section: 'reading',
        action: () => {
            goToUnread(-1);
        },
    });
    const focusedHunkRequests = useCallback((): readonly HunkExpandRequest[] => {
        if (focusedLine === null) {
            return [];
        }
        const model = shownModelOf(store.getSnapshot(), focusedLine.fileId);
        return model === null ? [] : hunkContextRequests(model, focusedLine.side, focusedLine.line);
    }, [focusedLine, store]);
    useShortcut({
        id: 'diff.expandContext',
        keys: ['e'],
        label: 'shortcut.diff.expandContext',
        scope: 'full-diff',
        section: 'reading',
        when: () => focusedHunkRequests().length > 0,
        action: () => {
            if (focusedLine === null) {
                return;
            }
            const fileId = focusedLine.fileId;
            for (const request of focusedHunkRequests()) {
                void expandContext({
                    store,
                    fileId,
                    request: { kind: 'gap', ...request },
                    contentAvailable,
                    loadContent,
                    t,
                });
            }
        },
    });

    const threadCounts = countThreadSources(threadSnapshot.threads);
    const threadVisible = useCallback(
        (thread: Thread) => thread.id === initialThreadId || threadIsVisible(thread, threadsShow, threadAuthor),
        [initialThreadId, threadAuthor, threadsShow],
    );
    const outsideThreads = threadSnapshot.outside.filter(
        (thread) => threadSnapshot.keptVisible.has(thread.id) || threadVisible(thread),
    );

    const selectedFile =
        snapshot.selection === null
            ? null
            : (diff.files.find((file) => file.fileId === snapshot.selection?.fileId) ?? null);
    const selectedModel = selectedFile === null ? null : shownModelOf(snapshot, selectedFile.fileId);
    const layoutStyle =
        toolbarHeight === null && viewportHeight === null
            ? undefined
            : ({
                  ...(toolbarHeight === null
                      ? {}
                      : { '--full-diff-toolbar-height': `${String(toolbarHeight)}px` }),
                  ...(viewportHeight === null
                      ? {}
                      : { '--full-diff-viewport-height': `${String(viewportHeight)}px` }),
              } as CSSProperties);

    return (
        <main
            className="full-diff selection-popover-host"
            ref={setScrollElement}
            data-shown-files={treeFiles.length}
            /* The code panel limit (`--diff-max`) uses the actual mode, not the setting. */
            data-diff-mode={snapshot.effectiveMode}
            style={layoutStyle}
        >
            <PrHeader
                ref={setScrollMarginElement}
                pr={pr}
                counts={prHeaderCounts(diff)}
                pci={pci?.available === true ? pci : null}
                pciActive={filter.id === PCI_FILTER_ID}
                onTogglePci={() => {
                    changeFilter(filter.id === PCI_FILTER_ID ? ALL_FILTER_ID : PCI_FILTER_ID);
                }}
                {...(props.headerAside === undefined ? {} : { aside: props.headerAside })}
            />

            <FullDiffToolbar
                store={store}
                filters={filters}
                filter={filter}
                onFilter={changeFilter}
                threadsShow={threadsShow}
                threadCounts={threadCounts}
                onThreadsShow={session.setThreadsShow}
                authorLens={
                    threadAuthor === null
                        ? null
                        : {
                              name: authorDisplayName(threadSnapshot.threads, threadAuthor),
                              onClear: () => {
                                  session.setThreadAuthor(null);
                              },
                          }
                }
                smallPr={props.smallPr ?? false}
                onHeight={setToolbarHeight}
            />

            <div className="full-diff__body">
                <FilePanel
                    files={treeFiles}
                    filters={filters}
                    activeFilter={filter}
                    onFilter={changeFilter}
                    pciFileIds={pciFileIds}
                    mineFileIds={mineFileIds}
                    readState={snapshot.readState}
                    route={routeMargin}
                    onJumpToStop={onJumpToStop}
                    activeFileId={topFileId}
                    onOpenFile={openFile}
                    onToggleViewed={toggleViewed}
                    writeError={
                        writeError === null
                            ? null
                            : {
                                  text: t('diff.file.notSaved'),
                                  onRetry: () => {
                                      writeFromTree(writeError.fileId, writeError.viewed);
                                  },
                              }
                    }
                    outline={outline}
                    onOpenHunk={openHunk}
                    inputRef={searchRef}
                />

                <div className="full-diff__main">
                    {/* An empty result describes the filter, not the list: the explanation sits next to
                        the card kept on screen instead of replacing it (docs/design/SPEC-elements.md §2.7). */}
                    {treeFiles.length === 0 ? (
                        <div className="full-diff__zero">
                            <p className="full-diff__zero-text">{zeroResultText(filter, t)}</p>
                            <button
                                type="button"
                                className="ctl ctl--secondary full-diff__zero-action"
                                onClick={() => {
                                    changeFilter(ALL_FILTER_ID);
                                }}
                            >
                                {t('lens.showAll')}
                            </button>
                        </div>
                    ) : null}

                    {/* The list never unmounts: that would lose the records of requested
                        parsing and of scrolling to a linked file already being complete. */}
                    <DiffFileList
                        ref={listRef}
                        scrollElement={scrollElement}
                        scrollMarginElement={scrollMarginElement}
                        scrollPaddingStart={toolbarHeight ?? 0}
                        files={shown}
                        store={store}
                        contentAvailable={contentAvailable}
                        noContentReason={slice === null ? undefined : t(SLICE_NO_CONTENT_REASON)}
                        parse={parse}
                        loadContent={loadContent}
                        onViewed={markViewed}
                        session={session}
                        notes={notes}
                        noteActions={noteActions}
                        threadStore={threadStore}
                        threadActions={threadActions}
                        threadVisible={threadVisible}
                        onCommentLine={commentLine}
                        onCommentFile={commentFile}
                        onLineFocus={focusLine}
                        onLineBlur={blurLine}
                        onFocusThread={setFocusedThreadId}
                        threadNow={threadNow}
                        outsideThreads={
                            <OutsideThreads
                                threads={outsideThreads}
                                store={threadStore}
                                actions={threadActions}
                                now={threadNow}
                                initialThreadId={initialThreadId}
                                defaultOpen={outsideThreadsOpen}
                                onFocusThread={setFocusedThreadId}
                            />
                        }
                        initialFileId={linkedFileId ?? initialFileId}
                        keptFileId={keptFileId}
                        advancingFileId={advanceFrom}
                        onTopFileChange={setTopFileId}
                        onScroll={onScroll}
                        routeMargin={routeMargin}
                        marginActions={marginActions}
                        onJumpToStop={onJumpToStop}
                    />
                </div>
            </div>
            {snapshot.selection === null || selectedFile === null || selectedModel === null ? null : (
                <SelectionPopover
                    key={`${snapshot.selection.fileId}:${snapshot.selection.side ?? ''}:${snapshot.selection.anchor}:${snapshot.selection.focus}`}
                    host={scrollElement}
                    diffId={diff.diffId}
                    file={selectedFile}
                    model={selectedModel}
                    selection={snapshot.selection}
                    dragging={snapshot.selectionDragging}
                    agentConnected={agentConnected}
                    inFlight={isSelectionPending(
                        chatAnchorFromSelection(selectedFile, selectedModel, snapshot.selection, diff.diffId),
                    )}
                    onAsk={onAskSelection}
                    askDisabledReason={slice === null ? null : t(SLICE_NO_ASK_REASON)}
                    onSelectionAnchorChange={selectionAnchorChange}
                    onComment={(side, line) => {
                        commentLine(selectedFile.fileId, side, line);
                    }}
                    onClear={store.clearSelection}
                />
            )}
        </main>
    );
}

/** Sticky Full diff toolbar with its own height measurement (docs/design/README.md §1 and §10). */
export function FullDiffToolbar({
    store,
    filters,
    filter,
    onFilter,
    threadsShow,
    threadCounts,
    onThreadsShow,
    authorLens = null,
    smallPr,
    onHeight,
}: {
    store: DiffViewStore;
    filters: readonly FileFilter[];
    filter: FileFilter;
    onFilter: (id: string) => void;
    threadsShow: ThreadsShow;
    threadCounts: ThreadSourceCounts;
    onThreadsShow: (show: ThreadsShow) => void;
    authorLens?: AuthorLens | null;
    smallPr: boolean;
    onHeight?: ((height: number) => void) | undefined;
}) {
    const t = useT();
    const ref = useRef<HTMLDivElement | null>(null);

    // Measure before painting, or the first frame will shift to the fallback height from full-diff.css.
    // Take the initial measurement manually because ResizeObserver stays silent in background tabs.
    useLayoutEffect(() => {
        const element = ref.current;
        if (element === null || onHeight === undefined) {
            return;
        }
        const report = (): void => {
            onHeight(element.getBoundingClientRect().height);
        };
        report();
        const observer = new ResizeObserver(report);
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, [onHeight]);

    return (
        <div className="full-diff__toolbar" ref={ref}>
            <div className="full-diff__heading">
                <h1 className="full-diff__title">{t('view.diff')}</h1>
                <span className="full-diff__subtitle">{t('fullDiff.subtitle')}</span>
            </div>
            {smallPr ? <span className="full-diff__small-pr">{t('route.smallPr.chip')}</span> : null}
            <span className="full-diff__spacer" />
            <ToolbarRightCluster
                store={store}
                filters={filters}
                filter={filter}
                onFilter={onFilter}
                threadsShow={threadsShow}
                threadCounts={threadCounts}
                onThreadsShow={onThreadsShow}
                authorLens={authorLens}
            />
        </div>
    );
}

const EMPTY_THREADS: readonly Thread[] = [];
const EMPTY_NOTES: readonly AgentNote[] = [];
const EMPTY_OPEN_NOTE = (): void => undefined;
const EMPTY_DELETE_NOTE = (): Promise<void> => Promise.reject(new Error('deleting notes is unavailable here'));
const EMPTY_FILE_IDS: ReadonlySet<string> = new Set();
const EMPTY_EXPANSION: FileExpansion = new Map();

/** Delay before parsing the remaining files in the background, leaving the first frame to visible cards. */
const BACKGROUND_PARSE_DELAY = 300;
/** Limit the wait for a DOM target after context expansion: the virtualizer may never create it. */
const LINE_NAVIGATION_SEARCH_MS = 3000;

const EMPTY_THREAD_TRANSPORT: ComposerTransport = {
    save: () => Promise.reject(new Error('writing drafts is unavailable in this state')),
    update: () => Promise.reject(new Error('writing drafts is unavailable in this state')),
    delete: () => Promise.reject(new Error('writing drafts is unavailable in this state')),
};
const EMPTY_RESOLVE = (): Promise<void> => Promise.reject(new Error('resolve is unavailable in this state'));
const EMPTY_SET_VIEWED = (): Promise<number> =>
    Promise.reject(new Error('marking viewed is unavailable in this state'));
const EMPTY_ASK_SELECTION = (): void => undefined;
const NO_SELECTION_PENDING = (): boolean => false;
const fileIdOf = (file: { readonly fileId: string }): string => file.fileId;
const NO_SELECTION_ANCHOR_CHANGE = (): void => undefined;
/** Full diff does not mark stops or their cards: it has no controls for that. */
const NO_STOP_WRITES: StopWriterHooks = {
    read: () => null,
    apply: () => undefined,
    restore: () => undefined,
    send: () => Promise.reject(new Error('marking a stop viewed is unavailable on the full diff')),
};
const NO_STOP_FILE_WRITES: StopFileWriterHooks = {
    apply: () => undefined,
    send: () => Promise.reject(new Error('marking a stop file viewed is unavailable on the full diff')),
};

/**
 * The file to scroll to after marking: the nearest expanded file below in the current order and
 * filter, or simply the next one if all below are collapsed. `null` means the marked file is last,
 * so there is no scrolling.
 */
export function nextFileToAdvance<T extends { readonly fileId: string }>(
    files: readonly T[],
    fileId: string,
    collapsed: (file: T) => boolean,
): string | null {
    const index = files.findIndex((file) => file.fileId === fileId);
    if (index < 0) {
        return null;
    }
    const rest = files.slice(index + 1);
    return (rest.find((file) => !collapsed(file)) ?? rest[0])?.fileId ?? null;
}

function shownModelOf(snapshot: DiffViewSnapshot, fileId: string): DiffFileModel | null {
    return shownFileModel(
        snapshot.models.get(fileId) ?? null,
        snapshot.content.get(fileId) ?? null,
        snapshot.expansion.get(fileId) ?? EMPTY_EXPANSION,
    );
}

export function commentPosition(
    selection: { fileId: string; anchor: string; focus: string } | null,
    model: DiffFileModel | null,
    fileId: string,
    side: 'old' | 'new',
    line: number,
): { side: 'old' | 'new'; line: number; size: number } {
    if (selection?.fileId !== fileId || model === null) {
        return { side, line, size: 1 };
    }
    const range = selectedLineRange(model, selection, side);
    if (range === null || line < range.line || line >= range.line + range.size) {
        return { side, line, size: 1 };
    }
    return { side, ...range };
}

/**
 * Outline items: the hunk entity from the diff model or, if the parser is unsure, the line range
 * on the new side from the `@@` header. Never display "unknown".
 *
 * Not parsed yet and nothing to outline are different answers: the first is temporary, the second final,
 * and the panel must use different words for them.
 */
function outlineOf(model: DiffFileModel | null): FileOutlineModel {
    if (model === null) {
        return { state: 'parsing' };
    }
    if (model.content.kind === 'binary') {
        return { state: 'empty', reason: 'fullDiff.outline.binary' };
    }
    if (model.content.kind === 'none') {
        return { state: 'empty', reason: model.malformed ? MALFORMED_REASON : 'fullDiff.outline.noText' };
    }

    const entries: OutlineEntry[] = [];
    let index = 0;
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        const label =
            block.entity === null
                ? `${String(block.newStart)}–${String(block.newStart + Math.max(block.newCount, 1) - 1)}`
                : block.entity.label;
        entries.push({ index, label });
        index += 1;
    }
    if (entries.length === 0) {
        return { state: 'empty', reason: model.malformed ? MALFORMED_REASON : 'fullDiff.outline.noHunks' };
    }
    return { state: 'ready', entries };
}

const MALFORMED_REASON: MessageKey = 'fullDiff.outline.malformed';
