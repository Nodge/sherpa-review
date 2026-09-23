import type {
    AgentNote,
    FileDiff,
    PrDiff,
    PrMeta,
    RouteSnapshot,
    UiChatAskAnchor,
    UiGenerationCap,
    UiReviewLensesResponse,
    UiReviewProgressResponse,
} from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    fetchFileContent,
    setReviewThreadResolved,
} from '../../api.js';
import type { DiffClient } from '../../diff/client.js';
import { createDiffClient } from '../../diff/client.js';
import { toParseRequest } from '../../diff/model.js';
import type { DiffViewStore } from '../../diff-view/store.js';
import { readFragmentParam } from '../../fragment.js';
import { useT } from '../../i18n/index.js';
import { readSelectionLink } from '../../selection-link.js';
import type { ProgressWriter } from '../../progress/progress-writer.js';
import type { StopProgressStore } from '../../progress/stop-progress-store.js';
import type { RouteSummary } from '../../route/route-summary.js';
import type { SessionStore } from '../../session/session-store.js';
import { createComposerTransport, createPublishedCommentTransport } from '../../threads/transport.js';
import type { ThreadStore } from '../../threads/store.js';
import {
    EMPTY_DELETE_NOTE,
    EMPTY_NOTES,
    EMPTY_OPEN_NOTE,
    RouteWorkspace,
} from './route-workspace.tsx';

/**
 * Route view, triage preset (docs/design/README.md §1–2): PR header with a snapshot indicator, sticky toolbar
 * and stop grid with a sticky narrative column on the left and the actual diff on the right, clipped to
 * the stop's anchors.
 *
 * Same split as the full diff: `RouteView` holds the live connections, the parsing worker, thread
 * transport, palette and URL fragment navigation. All rendering lives in `RouteWorkspace`
 * (`route-workspace.tsx`) with plain props, so it also renders in the state gallery. App passes
 * the same stores (diff, threads, progress) as for the full diff. Viewed marks,
 * drafts and diff mode must match between views (docs/product.md §3, principle 5).
 */

export interface RouteViewProps {
    readonly token: string;
    readonly session: SessionStore;
    readonly pr: PrMeta | null;
    readonly diff: PrDiff | null;
    readonly diffError: string | null;
    readonly lenses: UiReviewLensesResponse | null;
    readonly lensesError: string | null;
    readonly progress: UiReviewProgressResponse | null;
    readonly progressError: string | null;
    readonly progressWriter: ProgressWriter | null;
    readonly stopProgress: StopProgressStore | null;
    readonly store: DiffViewStore | null;
    readonly threadStore: ThreadStore | null;
    readonly snapshot: RouteSnapshot;
    readonly agentConnected: boolean;
    readonly onAskSelection: (anchor: UiChatAskAnchor) => void;
    readonly isSelectionPending: (anchor: UiChatAskAnchor | null) => boolean;
    readonly onSelectionAnchorChange: (anchor: UiChatAskAnchor | null) => void;
    /**
     * Populate the chat composer with a question (docs/design/README.md §2). Other asks the agent to place
     * uncovered ranges. The question stays unsent so the reviewer can read it and send it.
     */
    readonly onComposeQuestion?: (text: string) => void;
    readonly notes?: readonly AgentNote[];
    readonly onOpenNoteInChat?: (note: AgentNote) => void;
    readonly onDeleteNote?: (noteId: number) => Promise<void>;
    readonly selectionNavigationRequest?: number;
    /** Agent disconnected during generation. Filled stops get a note (docs/design/SPEC-elements.md §4.4). */
    readonly agentStopped?: boolean;
    /** Palette navigation increments `id`, and the view finishes scrolling to the stop. */
    readonly navigation?: { readonly id: number; readonly stopId: string } | null;
    /** Uncovered ranges exceed the threshold. App shows a regeneration banner (docs/design/SPEC-elements.md §4.3). */
    readonly onUnderExplained?: (value: boolean) => void;
    readonly onFillStop?: (planIndex: number) => void;
    /** Expose route counts. Only the view computes them, and the action panel and review summary need them. */
    readonly onRouteSummary?: (summary: RouteSummary) => void;
    /** Open a thread by id from links in the "why this stop changed" block (docs/design/README.md §1 item 4). */
    readonly onOpenThread?: (threadId: string) => void;
    /** Right side of the header: snapshot picker from App, or a static snapshot indicator without it. */
    readonly headerAside?: ReactNode;
    /** Generation cap from server state (docs/design/SPEC-elements.md §4.1), shown below the coverage bar. */
    readonly generationCap?: UiGenerationCap | null;
}

export function RouteView({
    token,
    session,
    pr,
    diff,
    diffError,
    lenses,
    lensesError,
    progress,
    progressError,
    progressWriter,
    stopProgress,
    store,
    threadStore,
    snapshot,
    agentConnected,
    onAskSelection,
    isSelectionPending,
    onSelectionAnchorChange,
    onComposeQuestion,
    notes = EMPTY_NOTES,
    onOpenNoteInChat = EMPTY_OPEN_NOTE,
    onDeleteNote = EMPTY_DELETE_NOTE,
    selectionNavigationRequest = 0,
    agentStopped = false,
    navigation = null,
    onUnderExplained,
    onFillStop,
    onRouteSummary,
    onOpenThread,
    headerAside,
    generationCap = null,
}: RouteViewProps) {
    const t = useT();
    const clientRef = useRef<DiffClient | null>(null);
    // One worker per view, as in the full diff. Models are cached in the shared store.
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
    const publishedTransport = useMemo(() => createPublishedCommentTransport(token), [token]);
    const resolveThread = useCallback(
        (threadId: string, resolved: boolean) => setReviewThreadResolved(token, threadId, resolved),
        [token],
    );
    // Two sources of stop navigation: the palette and the `stop` fragment parameter (a link
    // copied from the stop header). One counter lets the view distinguish jumps by increasing id.
    const [target, setTarget] = useState<{ id: number; stopId: string } | null>(null);
    const [selectionTarget, setSelectionTarget] = useState(() => readSelectionLink(window.location.hash));
    const targetId = useRef(0);
    const jumpTo = useCallback((stopId: string) => {
        targetId.current += 1;
        setTarget({ id: targetId.current, stopId });
    }, []);
    const fragmentStop = useRef<string | null>(null);
    useEffect(() => {
        const read = (): void => {
            setSelectionTarget(readSelectionLink(window.location.hash));
            const stopId = readFragmentParam(window.location.hash, 'stop');
            if (stopId === null || stopId === fragmentStop.current) {
                return;
            }
            fragmentStop.current = stopId;
            jumpTo(stopId);
        };
        read();
        window.addEventListener('hashchange', read);
        return () => {
            window.removeEventListener('hashchange', read);
        };
    }, [jumpTo]);
    const requestedSelectionTarget = useMemo(
        () => (selectionNavigationRequest === 0 ? selectionTarget : readSelectionLink(window.location.hash)),
        [selectionNavigationRequest, selectionTarget],
    );
    const paletteJump = useRef<number | null>(null);
    useEffect(() => {
        if (navigation === null || paletteJump.current === navigation.id) {
            return;
        }
        paletteJump.current = navigation.id;
        jumpTo(navigation.stopId);
    }, [jumpTo, navigation]);
    if (
        diffError !== null ||
        lensesError !== null ||
        (progress === null && progressError !== null) ||
        pr === null ||
        diff === null ||
        lenses === null ||
        progressWriter === null ||
        stopProgress === null ||
        store === null ||
        threadStore === null
    ) {
        return (
            <main className="route route--status" id="view-route">
                <p className="route__status">{diffError ?? lensesError ?? progressError ?? t('route.loading')}</p>
            </main>
        );
    }

    return (
        <RouteWorkspace
            pr={pr}
            diff={diff}
            lenses={lenses}
            snapshot={snapshot}
            agentStopped={agentStopped}
            session={session}
            store={store}
            threadStore={threadStore}
            progressWriter={progressWriter}
            stopProgress={stopProgress}
            progressLoaded={progress !== null}
            parse={parse}
            loadContent={loadContent}
            threadTransport={threadTransport}
            publishedTransport={publishedTransport}
            onResolveThread={resolveThread}
            navigation={target}
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
            {...(onUnderExplained === undefined ? {} : { onUnderExplained })}
            {...(onFillStop === undefined ? {} : { onFillStop })}
            {...(onRouteSummary === undefined ? {} : { onRouteSummary })}
            {...(onOpenThread === undefined ? {} : { onOpenThread })}
            {...(headerAside === undefined ? {} : { headerAside })}
            generationCap={generationCap}
        />
    );
}
