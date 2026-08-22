import type {
    FileContent,
    FileDiff,
    PrDiff,
    PrMeta,
    UiReviewLensesResponse,
    UiReviewProgressResponse,
} from '@sherpa/protocol';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
    fetchFileContent,
    fetchReviewDiff,
    fetchReviewLenses,
    fetchReviewPr,
    fetchReviewProgress,
    openInEditor,
    setFileViewed,
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
import { createProgressWriter } from '../progress/progress-writer.js';
import type { SessionStore } from '../session/session-store.js';
import { useShortcut } from '../shortcuts/context.tsx';
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
    readonly diff: PrDiff;
    readonly lenses: UiReviewLensesResponse;
    readonly progress: UiReviewProgressResponse;
}

export interface FullDiffViewProps {
    readonly token: string;
    readonly prKey: string;
    readonly session: SessionStore;
    /** Progress revision from SSE. Reread the endpoint if it grew since last seen (tab convergence). */
    readonly progressRevision: number | null;
}

export function FullDiffView({ token, prKey, session, progressRevision }: FullDiffViewProps) {
    const [state, setState] = useState<{ loaded: Loaded | null; error: string | null }>({
        loaded: null,
        error: null,
    });

    useEffect(() => {
        let alive = true;
        void Promise.all([
            fetchReviewPr(token),
            fetchReviewDiff(token),
            fetchReviewLenses(token),
            fetchReviewProgress(token),
        ]).then(
            ([pr, diff, lenses, progress]) => {
                if (alive) {
                    setState({ loaded: { pr, diff, lenses, progress }, error: null });
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

    const diffId = state.loaded?.diff.diffId ?? null;
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
    const openFileInEditor = useCallback(
        async (path: string): Promise<Feedback> => {
            const result = await openInEditor(token, path);
            return result.outcome === 'opened' ? null : result.message;
        },
        [token],
    );

    if (state.error !== null || state.loaded === null) {
        // `__main` defines the column. Without it the toolbar and status would line up horizontally, since `.full-diff`
        // lays out the panel and right side horizontally.
        return (
            <main className="full-diff">
                <div className="full-diff__main">
                    <div className="full-diff__toolbar">
                        <h1 className="full-diff__title">Full diff</h1>
                    </div>
                    <p className="full-diff__status">{state.error ?? 'Diff is loading…'}</p>
                </div>
            </main>
        );
    }

    return (
        <DiffWorkspace
            pr={state.loaded.pr}
            diff={state.loaded.diff}
            lenses={state.loaded.lenses}
            progress={state.loaded.progress}
            prKey={prKey}
            session={session}
            parse={parse}
            loadContent={loadContent}
            onOpenInEditor={openFileInEditor}
            onSetViewed={writeViewed}
            reloadProgress={reloadProgress}
            progressRevision={progressRevision}
            initialFileId={readFragmentParam(window.location.hash, 'file')}
        />
    );
}

export interface DiffWorkspaceProps {
    readonly pr: PrMeta;
    readonly diff: PrDiff;
    readonly lenses: UiReviewLensesResponse;
    /** Initial reading progress. Without it, the store uses defaults (the gallery supplies a store). */
    readonly progress?: UiReviewProgressResponse;
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
    readonly initialFileId?: string | null;
    /** Diff view store. Without it, a new one is created. The gallery supplies a prefilled store. */
    readonly store?: DiffViewStore;
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
        initialFileId = null,
    } = props;

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
    const collapsedStorage = props.collapsedStorage === undefined ? globalCollapsedStorage() : props.collapsedStorage;

    const { filter: filterId } = useSyncExternalStore(session.subscribe, session.getSnapshot);
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

    const listRef = useRef<DiffListHandle | null>(null);
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
        return diff.files.filter((file) => ids.has(file.fileId) || file.fileId === keptFileId);
    }, [diff.files, filter, keptFileId]);
    const treeFiles = useMemo(() => filterFiles(diff.files, filter), [diff.files, filter]);

    // Use an effect instead of a handler call: by this point the list has rerendered with the new set
    // of files, and its imperative API knows the right index.
    useEffect(() => {
        const target = pendingScroll.current;
        if (target === null) {
            return;
        }
        pendingScroll.current = null;
        listRef.current?.scrollToFile(target);
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

    const openFile = useCallback((fileId: string) => {
        listRef.current?.scrollToFile(fileId);
    }, []);

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

    const searchRef = useRef<HTMLInputElement | null>(null);
    useShortcut({
        id: 'diff.filterFiles',
        keys: ['/'],
        label: 'Filter files in the tree',
        action: () => {
            searchRef.current?.focus();
        },
    });

    // The banner explains what is hidden. When the filter matches no files, the empty-result
    // panel already explains that, so there is no need for two in a row.
    const pciStats = pci === null ? null : filterStats(diff.files, pci);
    const auditVisible = filter.id === PCI_FILTER_ID && !bannerDismissed && (pciStats?.files ?? 0) > 0;

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
                    initialFileId={initialFileId}
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
}: {
    store: DiffViewStore;
    filters: readonly FileFilter[];
    filter: FileFilter;
    onFilter: (id: string) => void;
    shown: number;
}) {
    const { diffMode, splitAvailable, effectiveMode } = useSyncExternalStore(store.subscribe, store.getSnapshot);

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
            <FilterSelect filters={filters} active={filter} onSelect={onFilter} />
            <span className="full-diff__count">
                {formatCount(shown)} {plural(shown, 'file', 'files', 'files')}
            </span>
        </div>
    );
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
