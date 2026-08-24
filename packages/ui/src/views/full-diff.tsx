import type {
    FileContent,
    FileDiff,
    PrDiff,
    PrMeta,
    Thread,
    UiReviewLensesResponse,
    UiReviewProgressResponse,
} from '@sherpa/protocol';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
    fetchFileContent,
    fetchReviewLenses,
    fetchReviewPr,
    deleteReviewDraft,
    fetchReviewProgress,
    fetchReviewThreads,
    openInEditor,
    saveReviewDraft,
    setFileViewed,
    setReviewThreadResolved,
    updateReviewDraft,
} from '../api.js';
import { AuditScopeBanner } from '../components/audit-banner.tsx';
import { FilterSelect } from '../components/filter-select.tsx';
import { PrHeader } from '../components/pr-header.tsx';
import type { DiffClient } from '../diff/client.js';
import { createDiffClient } from '../diff/client.js';
import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import type { Feedback } from '../diff-view/file-card.tsx';
import type { DiffListHandle } from '../diff-view/file-list.tsx';
import { DiffFileList } from '../diff-view/file-list.tsx';
import type { DiffViewStore } from '../diff-view/store.js';
import { createDiffViewStore } from '../diff-view/store.js';
import '../diff-view/diff-view.css';
import type { FileFilter } from '../filters/lens-filters.js';
import {
    ALL_FILTER_ID,
    buildFileFilters,
    filterFiles,
    filterStats,
    findFilter,
    PCI_FILTER_ID,
    selectFilter,
    zeroResultText,
} from '../filters/lens-filters.js';
import { readFragmentParam } from '../fragment.js';
import type { PaletteNavigation } from '../palette/diff-source.tsx';
import { createProgressWriter } from '../progress/progress-writer.js';
import type { SessionStore, ThreadsShow } from '../session/session-store.js';
import { useShortcut } from '../shortcuts/context.tsx';
import type { ComposerTransport } from '../threads/composer.js';
import type { ThreadSourceCounts } from '../threads/model.js';
import { countThreadSources, threadIsVisible } from '../threads/model.js';
import { persistentThreadStore } from '../threads/persistent-store.js';
import { threadResolvedWriterFor } from '../threads/resolved-writer.js';
import { openNewComposer, openReply, OutsideThreads } from '../threads/thread-list.tsx';
import type { ThreadActions } from '../threads/thread-list.tsx';
import type { ThreadStore } from '../threads/store.js';
import { formatCount, plural } from '../text.js';
import type { CollapsedStorage } from '../tree/collapsed-storage.js';
import { globalCollapsedStorage } from '../tree/collapsed-storage.js';
import type { FileOutlineModel, OutlineEntry } from '../tree/file-panel.tsx';
import { FilePanel } from '../tree/file-panel.tsx';
import './full-diff.css';

/**
 * Full diff view (README §10): filters and file tree on the left, PR header on the right,
 * with the toolbar and diff cards. The tree and cards share one filter model, kept in the session
 * store and survives reloads through the URL fragment.
 */

interface Loaded {
    readonly pr: PrMeta;
    readonly lenses: UiReviewLensesResponse;
    readonly progress: UiReviewProgressResponse;
    readonly threads: readonly Thread[];
}

export interface FullDiffViewProps {
    readonly token: string;
    readonly prKey: string;
    readonly session: SessionStore;
    /** Raw patches load at the App level so the palette works over any view. */
    readonly diff: PrDiff | null;
    readonly diffError: string | null;
    readonly store: DiffViewStore | null;
    /** Progress revision from SSE. Reread the endpoint if it grew since last seen (tab convergence). */
    readonly progressRevision: number | null;
    readonly threadsRevision: number | null;
    readonly paletteNavigation?: PaletteNavigation | null;
    readonly onPaletteActiveFileChange?: (fileId: string | null) => void;
}

export function FullDiffView({
    token,
    prKey,
    session,
    diff,
    diffError,
    store,
    progressRevision,
    threadsRevision,
    paletteNavigation = null,
    onPaletteActiveFileChange,
}: FullDiffViewProps) {
    const [state, setState] = useState<{ loaded: Loaded | null; error: string | null }>({
        loaded: null,
        error: null,
    });

    useEffect(() => {
        let alive = true;
        void Promise.all([
            fetchReviewPr(token),
            fetchReviewLenses(token),
            fetchReviewProgress(token),
            fetchReviewThreads(token),
        ]).then(
            ([pr, lenses, progress, threads]) => {
                if (alive) {
                    setState({ loaded: { pr, lenses, progress, threads }, error: null });
                }
            },
            (error: unknown) => {
                if (alive) {
                    setState({ loaded: null, error: error instanceof Error ? error.message : String(error) });
                }
            },
        );
        return () => {
            alive = false;
        };
    }, [token]);

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
    const writeViewed = useCallback(
        async (fileId: string, viewed: boolean): Promise<number> =>
            (await setFileViewed(token, fileId, viewed)).progressRevision,
        [token],
    );
    const reloadProgress = useCallback(() => fetchReviewProgress(token), [token]);
    const reloadThreads = useCallback(() => fetchReviewThreads(token), [token]);
    const threadTransport = useMemo<ComposerTransport>(
        () => ({
            save: (draft) => saveReviewDraft(token, draft),
            update: (commentId, body) => updateReviewDraft(token, commentId, body),
            delete: (commentId) => deleteReviewDraft(token, commentId),
        }),
        [token],
    );
    const resolveThread = useCallback(
        (threadId: string, resolved: boolean) => setReviewThreadResolved(token, threadId, resolved),
        [token],
    );
    const openFileInEditor = useCallback(
        async (path: string): Promise<Feedback> => {
            const result = await openInEditor(token, path);
            return result.outcome === 'opened' ? null : result.message;
        },
        [token],
    );
    const [fragmentTarget, setFragmentTarget] = useState(() => ({
        fileId: readFragmentParam(window.location.hash, 'file'),
        threadId: readFragmentParam(window.location.hash, 'thread'),
    }));
    useEffect(() => {
        const read = (): void => {
            setFragmentTarget({
                fileId: readFragmentParam(window.location.hash, 'file'),
                threadId: readFragmentParam(window.location.hash, 'thread'),
            });
        };
        window.addEventListener('hashchange', read);
        return () => {
            window.removeEventListener('hashchange', read);
        };
    }, []);

    if (state.error !== null || diffError !== null || state.loaded === null || diff === null || store === null) {
        // `__main` defines the column. Without it the toolbar and status would line up horizontally, since `.full-diff`
        // lays out the panel and right side horizontally.
        return (
            <main className="full-diff">
                <div className="full-diff__main">
                    <div className="full-diff__toolbar">
                        <h1 className="full-diff__title">Full diff</h1>
                    </div>
                    <p className="full-diff__status">{state.error ?? diffError ?? 'Loading diff…'}</p>
                </div>
            </main>
        );
    }

    return (
        <DiffWorkspace
            pr={state.loaded.pr}
            diff={diff}
            lenses={state.loaded.lenses}
            progress={state.loaded.progress}
            threads={state.loaded.threads}
            prKey={prKey}
            session={session}
            store={store}
            paletteNavigation={paletteNavigation}
            {...(onPaletteActiveFileChange === undefined ? {} : { onPaletteActiveFileChange })}
            parse={parse}
            loadContent={loadContent}
            onOpenInEditor={openFileInEditor}
            onSetViewed={writeViewed}
            reloadProgress={reloadProgress}
            progressRevision={progressRevision}
            reloadThreads={reloadThreads}
            threadsRevision={threadsRevision}
            threadTransport={threadTransport}
            onResolveThread={resolveThread}
            initialFileId={fragmentTarget.fileId}
            initialThreadId={fragmentTarget.threadId}
        />
    );
}

export interface DiffWorkspaceProps {
    readonly pr: PrMeta;
    readonly diff: PrDiff;
    readonly lenses: UiReviewLensesResponse;
    /** Initial reading progress. Without it, the store uses defaults (the gallery supplies a store). */
    readonly progress?: UiReviewProgressResponse;
    readonly threads?: readonly Thread[];
    readonly prKey: string;
    readonly session: SessionStore;
    /** Patch parsing uses a worker for live data and a synchronous parser in the gallery. */
    readonly parse: (file: FileDiff) => Promise<DiffFileModel>;
    readonly loadContent: (fileId: string) => Promise<FileContent | null>;
    readonly onOpenInEditor: (path: string) => Promise<Feedback>;
    /** Write a viewed mark. Returns the progress revision after the write. */
    readonly onSetViewed: (fileId: string, viewed: boolean) => Promise<number>;
    /** Refetch progress on an SSE event. Without it tabs do not converge (gallery, tests). */
    readonly reloadProgress?: () => Promise<UiReviewProgressResponse>;
    readonly progressRevision?: number | null;
    readonly reloadThreads?: () => Promise<readonly Thread[]>;
    readonly threadsRevision?: number | null;
    readonly threadTransport?: ComposerTransport;
    readonly onResolveThread?: (threadId: string, resolved: boolean) => Promise<void>;
    readonly initialFileId?: string | null;
    readonly initialThreadId?: string | null;
    /** Fixed clock for the gallery. The application captures the time when the view mounts. */
    readonly threadNow?: number;
    /** Diff view store. Without it, a new one is created. The gallery supplies a prefilled store. */
    readonly store?: DiffViewStore;
    readonly threadStore?: ThreadStore;
    readonly paletteNavigation?: PaletteNavigation | null;
    readonly onPaletteActiveFileChange?: (fileId: string | null) => void;
    /** Directory collapse storage. `null` disables persistence (gallery, tests). */
    readonly collapsedStorage?: CollapsedStorage | null;
}

export function DiffWorkspace(props: DiffWorkspaceProps) {
    const {
        pr,
        diff,
        lenses,
        prKey,
        session,
        parse,
        loadContent,
        onOpenInEditor,
        onSetViewed,
        reloadProgress,
        progressRevision = null,
        reloadThreads,
        threadsRevision = null,
        initialFileId = null,
        initialThreadId = null,
        paletteNavigation = null,
        onPaletteActiveFileChange,
    } = props;
    const [threadNow] = useState(() => props.threadNow ?? Date.now());

    const initialProgress = props.progress;
    const createdStore = useMemo(
        () =>
            createDiffViewStore({
                files: diff.files,
                ...(initialProgress === undefined ? {} : { progress: initialProgress.files }),
            }),
        [diff, initialProgress],
    );
    const store = props.store ?? createdStore;
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    useEffect(() => {
        if (props.store !== undefined && initialProgress !== undefined) {
            store.setProgress(initialProgress.files);
        }
    }, [initialProgress, props.store, store]);
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
    const resolvedWriter = useMemo(
        () =>
            threadResolvedWriterFor(threadStore, {
                read: (threadId) => threadStore.getSnapshot().threads.find((thread) => thread.id === threadId)?.resolved ?? false,
                readConfirmed: threadStore.getServerResolved,
                apply: (threadId, resolved) => {
                    threadStore.setResolved(threadId, resolved);
                },
                rollback: threadStore.restoreResolved,
                shouldRollback: (threadId) => threadStore.hasResolvedOverride(threadId),
                send: resolveThread,
            }),
        [resolveThread, threadStore],
    );
    const threadActions = useMemo<ThreadActions>(
        () => ({ transport: threadTransport, resolve: resolvedWriter.write }),
        [resolvedWriter, threadTransport],
    );
    const collapsedStorage = props.collapsedStorage === undefined ? globalCollapsedStorage() : props.collapsedStorage;

    const { filter: filterId, threadsShow } = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const filters = useMemo(
        () => buildFileFilters({ files: diff.files, ownership: lenses.ownership, extra: lenses.extra }),
        [diff.files, lenses],
    );
    const filter = selectFilter(filters, filterId);

    // An unknown or disabled filter in the URL is corrected in the URL itself. Otherwise, the link
    // would keep promising a view that does not exist.
    useEffect(() => {
        if (filter.id !== filterId) {
            session.setFilter(filter.id);
        }
    }, [filter.id, filterId, session]);

    // Reading progress (T8): optimistic writes, rollback on failure and tab convergence through SSE.
    // `ProgressWriter` handles write order, rollback and revisions. The view only renders.
    const [writesSettled, setWritesSettled] = useState(0);
    const [writeError, setWriteError] = useState<{ fileId: string; viewed: boolean } | null>(null);
    const writer = useMemo(
        () =>
            createProgressWriter({
                initialRevision: initialProgress?.progressRevision ?? 0,
                read: (fileId) => store.getSnapshot().progress.get(fileId) ?? null,
                apply: (fileId, viewed) => {
                    store.markViewed(fileId, viewed);
                },
                restore: (fileId, record) => {
                    store.restoreProgress(fileId, record);
                },
                send: onSetViewed,
                // In-flight writes defer the reread. The decision is reconsidered after the response.
                onSettled: () => {
                    setWritesSettled((settled) => settled + 1);
                },
            }),
        [initialProgress, onSetViewed, store],
    );

    const markViewed = useCallback(
        async function mark(fileId: string, viewed: boolean): Promise<Feedback> {
            setWriteError(null);
            if (await writer.write(fileId, viewed)) {
                return null;
            }
            // The optimistic write failed. The control has already returned to its previous state (SPEC §1.2),
            // so all that remains is offering a retry.
            return { text: 'not saved', retry: () => mark(fileId, viewed) };
        },
        [writer],
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
        if (reloadProgress === undefined || progressRevision === null || !writer.shouldReload(progressRevision)) {
            return;
        }
        let alive = true;
        const mark = writer.beginReload();
        void reloadProgress().then(
            (response) => {
                const files = alive ? writer.finishReload(response, mark) : null;
                if (files !== null) {
                    store.setProgress(files);
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

    const listRef = useRef<DiffListHandle | null>(null);
    const linkedThread = useMemo(
        () => threadSnapshot.threads.find((thread) => thread.id === initialThreadId) ?? null,
        [initialThreadId, threadSnapshot.threads],
    );
    const linkedFileId = linkedThread?.anchor?.fileId ?? null;
    const [topFileId, setTopFileId] = useState<string | null>(null);
    const [keptFileId, setKeptFileId] = useState<string | null>(null);
    const [bannerDismissed, setBannerDismissed] = useState(false);

    // "Kept in view" (SPEC §2.7): the file the reviewer is reading stays under the cursor
    // when the filter changes. It remains in the list with a label.
    const topRef = useRef<string | null>(null);
    useEffect(() => {
        topRef.current = topFileId;
    }, [topFileId]);

    // The label clears on the next reviewer scroll (SPEC §2.7). The list
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
            // Nothing under the cursor disappears (SPEC §2.7), and scrolling stays anchored to the top
            // card (SPEC §2.6). After a filter change the list returns to it automatically.
            pendingScroll.current = kept ?? top;
            setBannerDismissed(false);
            session.setFilter(next.id);
        },
        [filter.id, filters, session],
    );

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
                setBannerDismissed(false);
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
        async (fileId: string, side: 'old' | 'new', line: number): Promise<void> => {
            lineNavigationId.current += 1;
            const navigationId = lineNavigationId.current;
            lineNavigationCleanup.current?.();
            lineNavigationCleanup.current = null;

            // Large and whitespace-only files must render their lines before looking for the DOM target.
            store.openFile(fileId);
            store.showWhitespace(fileId);
            const converged = await (listRef.current?.scrollToFile(fileId) ?? Promise.resolve(false));
            if (!converged || navigationId !== lineNavigationId.current) {
                return;
            }

            let observer: MutationObserver | null = null;
            const stop = (): void => {
                observer?.disconnect();
                observer = null;
                if (lineNavigationCleanup.current === stop) {
                    lineNavigationCleanup.current = null;
                }
            };
            const reveal = (): boolean => {
                const card = document.querySelector<HTMLElement>(`[data-file="${CSS.escape(fileId)}"]`);
                if (card === null) {
                    return false;
                }
                const number = String(line);
                const exact = side === 'new' ? `[data-key="a${number}"]` : `[data-key="d${number}"]`;
                const context =
                    side === 'new' ? `[data-key^="c"][data-key$=":${number}"]` : `[data-key^="c${number}:"]`;
                const target = card.querySelector<HTMLElement>(exact) ?? card.querySelector<HTMLElement>(context);
                if (target === null) {
                    return false;
                }
                const row = target.closest<HTMLElement>('.diff-row') ?? target;
                row.scrollIntoView({ block: 'center' });
                row.classList.remove('diff-row--palette-target');
                void row.offsetWidth;
                row.classList.add('diff-row--palette-target');
                row.addEventListener(
                    'animationend',
                    () => {
                        row.classList.remove('diff-row--palette-target');
                    },
                    { once: true },
                );
                stop();
                return true;
            };

            lineNavigationCleanup.current = stop;
            if (reveal()) {
                return;
            }
            observer = new MutationObserver(() => {
                reveal();
            });
            observer.observe(document.body, { childList: true, subtree: true });
        },
        [store],
    );

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
            setBannerDismissed(false);
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

    // Single-file PR outline: hunks from the already parsed model (SPEC §2.20).
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
            // Approximation until symbol navigation (M5): a single-file PR card is always
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
            const position = commentPosition(snapshot.selection, fileId, side, line);
            const key = `new:${fileId}:${position.side}:${String(position.line)}`;
            openNewComposer(threadStore, key, { fileId, path: file.path, position });
        },
        [diff.files, snapshot.selection, threadStore],
    );

    useShortcut({
        id: 'thread.commentLine',
        keys: ['c'],
        label: 'Comment on the line under the cursor',
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
        label: 'Reply to the thread under the cursor',
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
        label: 'Filter files in the tree',
        action: () => {
            searchRef.current?.focus();
        },
    });

    // The banner explains what is hidden. When the filter matches no files, the empty-result
    // panel already explains that, so there is no need for two in a row.
    const pciStats = pci === null ? null : filterStats(diff.files, pci);
    const auditVisible = filter.id === PCI_FILTER_ID && !bannerDismissed && (pciStats?.files ?? 0) > 0;
    const threadCounts = countThreadSources(threadSnapshot.threads);
    const threadVisible = useCallback(
        (thread: Thread) => thread.id === initialThreadId || threadIsVisible(thread, threadsShow),
        [initialThreadId, threadsShow],
    );
    const outsideThreads = threadSnapshot.outside.filter(
        (thread) => threadSnapshot.keptVisible.has(thread.id) || threadVisible(thread),
    );

    return (
        <main className="full-diff">
            <FilePanel
                files={treeFiles}
                filters={filters}
                activeFilter={filter}
                onFilter={changeFilter}
                pciFileIds={pciFileIds}
                mineFileIds={mineFileIds}
                readState={snapshot.readState}
                activeFileId={topFileId}
                onOpenFile={openFile}
                onToggleViewed={toggleViewed}
                writeError={
                    writeError === null
                        ? null
                        : {
                              text: 'not saved',
                              onRetry: () => {
                                  writeFromTree(writeError.fileId, writeError.viewed);
                              },
                          }
                }
                outline={outline}
                onOpenHunk={openHunk}
                prKey={prKey}
                storage={collapsedStorage}
                inputRef={searchRef}
            />

            <div className="full-diff__main">
                <PrHeader
                    pr={pr}
                    additions={sum(diff.files, 'additions')}
                    deletions={sum(diff.files, 'deletions')}
                    files={diff.files.length}
                    pci={pci?.available === true ? pci : null}
                    pciActive={filter.id === PCI_FILTER_ID}
                    onTogglePci={() => {
                        changeFilter(filter.id === PCI_FILTER_ID ? ALL_FILTER_ID : PCI_FILTER_ID);
                    }}
                />

                {auditVisible && pci !== null && pciStats !== null ? (
                    <AuditScopeBanner
                        filter={pci}
                        stats={pciStats}
                        paths={treeFiles.map((file) => file.path)}
                        onShowAll={() => {
                            changeFilter(ALL_FILTER_ID);
                        }}
                        onDismiss={() => {
                            setBannerDismissed(true);
                        }}
                    />
                ) : null}

                <Toolbar
                    store={store}
                    filters={filters}
                    filter={filter}
                    onFilter={changeFilter}
                    shown={treeFiles.length}
                    threadsShow={threadsShow}
                    threadCounts={threadCounts}
                    onThreadsShow={session.setThreadsShow}
                />

                {/* An empty result describes the filter, not the list. Its explanation sits next to
                    the card kept on screen, instead of replacing it (SPEC §2.7). */}
                {treeFiles.length === 0 ? (
                    <div className="full-diff__zero">
                        <p className="full-diff__zero-text">{zeroResultText(filter)}</p>
                        <button
                            type="button"
                            className="full-diff__zero-action"
                            onClick={() => {
                                changeFilter(ALL_FILTER_ID);
                            }}
                        >
                            Show all files
                        </button>
                    </div>
                ) : null}

                {/* The list never unmounts, since that would discard the marks for requested
                    parses and for scrolling to a linked file that has already happened. */}
                <DiffFileList
                    ref={listRef}
                    files={shown}
                    store={store}
                    contentAvailable={pr.capabilities.fileContent}
                    parse={parse}
                    loadContent={loadContent}
                    onOpenInEditor={onOpenInEditor}
                    onViewed={markViewed}
                    threadStore={threadStore}
                    threadActions={threadActions}
                    threadVisible={threadVisible}
                    onCommentLine={commentLine}
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
                            onFocusThread={setFocusedThreadId}
                        />
                    }
                    initialFileId={linkedFileId ?? initialFileId}
                    keptFileId={keptFileId}
                    onTopFileChange={setTopFileId}
                    onScroll={onScroll}
                />
            </div>
        </main>
    );
}

/** The diff mode toggle is "deliberately quiet" (README §1), global across all views (SPEC §2.6). */
function Toolbar({
    store,
    filters,
    filter,
    onFilter,
    shown,
    threadsShow,
    threadCounts,
    onThreadsShow,
}: {
    store: DiffViewStore;
    filters: readonly FileFilter[];
    filter: FileFilter;
    onFilter: (id: string) => void;
    shown: number;
    threadsShow: ThreadsShow;
    threadCounts: ThreadSourceCounts;
    onThreadsShow: (show: ThreadsShow) => void;
}) {
    const { diffMode, splitAvailable, effectiveMode } = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const [hiddenBackup, setHiddenBackup] = useState<ThreadsShow | null>(null);

    return (
        <div className="full-diff__toolbar">
            <h1 className="full-diff__title">Full diff</h1>
            <span className="full-diff__subtitle">
                A classic reader. The route stays in the margin and no longer sets the order.
            </span>
            <span className="full-diff__spacer" />
            {/* Below 1100px there is no choice (SPEC §2.6). The label always names the mode
                currently rendering the diff, rather than the user's deferred choice. */}
            <button
                type="button"
                className="full-diff__mode"
                disabled={!splitAvailable}
                title={splitAvailable ? undefined : 'not enough width for side by side'}
                onClick={() => {
                    store.setDiffMode(diffMode === 'unified' ? 'split' : 'unified');
                }}
            >
                ⇄ {effectiveMode === 'unified' ? 'unified' : 'side by side'}
            </button>
            <span className="full-diff__comments-label">Comments:</span>
            {!threadsShow.people && !threadsShow.bots && !threadsShow.resolved ? (
                <span className="thread-chips-hidden">
                    Comments hidden ·{' '}
                    <button
                        type="button"
                        onClick={() => {
                            onThreadsShow(hiddenBackup ?? { people: true, bots: false, resolved: false });
                            setHiddenBackup(null);
                        }}
                    >
                        undo
                    </button>
                </span>
            ) : (
                <CommentSourceChips
                    show={threadsShow}
                    counts={threadCounts}
                    onChange={(next) => {
                        if (!next.people && !next.bots && !next.resolved) {
                            setHiddenBackup(threadsShow);
                        }
                        onThreadsShow(next);
                    }}
                />
            )}
            <FilterSelect filters={filters} active={filter} onSelect={onFilter} />
            <span className="full-diff__count">
                {formatCount(shown)} {plural(shown, 'file', 'files', 'files')}
            </span>
        </div>
    );
}

function CommentSourceChips({
    show,
    counts,
    onChange,
}: {
    show: ThreadsShow;
    counts: ThreadSourceCounts;
    onChange: (show: ThreadsShow) => void;
}) {
    const chips = [
        { id: 'people' as const, label: 'People' },
        { id: 'bots' as const, label: 'Bots' },
        { id: 'resolved' as const, label: 'Resolved' },
    ];
    return (
        <span className="thread-chips" aria-label="Comment sources">
            {chips.map((chip) => {
                const count = counts[chip.id];
                return (
                    <button
                        key={chip.id}
                        type="button"
                        className={`thread-chip${show[chip.id] ? ' is-on' : ''}`}
                        aria-pressed={show[chip.id]}
                        disabled={count === 0}
                        title={count === 0 ? `This PR has no threads in the "${chip.label}" category` : undefined}
                        onClick={() => {
                            onChange({ ...show, [chip.id]: !show[chip.id] });
                        }}
                    >
                        {chip.label} {count}
                    </button>
                );
            })}
        </span>
    );
}

const EMPTY_THREADS: readonly Thread[] = [];

const EMPTY_THREAD_TRANSPORT: ComposerTransport = {
    save: () => Promise.reject(new Error('draft writing is unavailable in this state')),
    update: () => Promise.reject(new Error('draft writing is unavailable in this state')),
    delete: () => Promise.reject(new Error('draft writing is unavailable in this state')),
};
const EMPTY_RESOLVE = (): Promise<void> => Promise.reject(new Error('resolve is unavailable in this state'));

export function commentPosition(
    selection: { fileId: string; anchor: string; focus: string } | null,
    fileId: string,
    side: 'old' | 'new',
    line: number,
): { side: 'old' | 'new'; line: number; size: number } {
    if (selection?.fileId !== fileId) {
        return { side, line, size: 1 };
    }
    const first = lineOfKey(selection.anchor, side);
    const last = lineOfKey(selection.focus, side);
    if (first === null || last === null) {
        return { side, line, size: 1 };
    }
    const start = Math.min(first, last);
    const end = Math.max(first, last);
    if (line < start || line > end) {
        return { side, line, size: 1 };
    }
    return { side, line: start, size: end - start + 1 };
}

function lineOfKey(key: string, side: 'old' | 'new'): number | null {
    const add = /^a(\d+)$/.exec(key);
    if (add !== null) {
        return side === 'new' ? Number(add[1]) : null;
    }
    const del = /^d(\d+)$/.exec(key);
    if (del !== null) {
        return side === 'old' ? Number(del[1]) : null;
    }
    const context = /^c(\d+):(\d+)$/.exec(key);
    if (context === null) {
        return null;
    }
    return Number(context[side === 'old' ? 1 : 2]);
}

function sum(files: readonly FileDiff[], key: 'additions' | 'deletions'): number {
    return files.reduce((total, file) => total + file[key], 0);
}

/**
 * Outline entries use the hunk entity from the T5 model. If the parser is unsure, they use the line range
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
        return { state: 'empty', reason: 'Binary file, nothing to outline.' };
    }
    if (model.content.kind === 'none') {
        return { state: 'empty', reason: model.malformed ? MALFORMED_REASON : 'No text changes in this file.' };
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
        return { state: 'empty', reason: model.malformed ? MALFORMED_REASON : 'No hunks in this file.' };
    }
    return { state: 'ready', entries };
}

const MALFORMED_REASON = 'The patch for this file could not be parsed, so there is no outline.';
