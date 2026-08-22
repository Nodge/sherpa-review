import type { FileContent, FileDiff } from '@sherpa/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Ref } from 'react';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { DiffFileModel } from '../diff/model.js';
import { updateFragment } from '../fragment.js';
import type { FileReadState } from '../progress/read-state.js';
import { readStateOf as computeReadState } from '../progress/read-state.js';
import type { ExpandAmount } from './expand.js';
import type { Feedback, FileCardActions } from './file-card.tsx';
import { COLLAPSE_THRESHOLD, FileCard } from './file-card.tsx';
import type { DiffViewStore } from './store.js';

/**
 * Virtualized list of diff cards (SPEC §8 item 8: 60+ files at 60fps). The DOM contains
 * only visible cards plus overscan, so worker parsing is lazy too: a file
 * is parsed exactly when it scrolls into view.
 *
 * Card heights are measured (`measureElement`). Line counts can only estimate them,
 * and folds, notices and expanded context invalidate that estimate.
 */

/** Code row and card header heights from README §1 estimate height before measurement. */
const CODE_LINE_HEIGHT = 20;
const CARD_CHROME_HEIGHT = 74;

/** Cards to keep beyond the viewport. Fewer expose loading, more cost more. */
const OVERSCAN = 3;

/** Frames to adjust scrolling to a linked file, giving the cards time to measure. */
const SCROLL_TO_FILE_FRAMES = 12;

/** Imperative list control. The file tree requests scrolling to its row. */
export interface DiffListHandle {
    readonly scrollToFile: (fileId: string) => void;
}

export interface DiffFileListProps {
    readonly files: readonly FileDiff[];
    readonly store: DiffViewStore;
    /** The host can supply file contents (`capabilities.fileContent`). */
    readonly contentAvailable: boolean;
    /** Patch parsing uses a worker for live data and a synchronous parser in the gallery. */
    readonly parse: (file: FileDiff) => Promise<DiffFileModel>;
    readonly loadContent: (fileId: string) => Promise<FileContent | null>;
    readonly onOpenInEditor: (path: string) => Promise<Feedback>;
    /** Viewed mark. The view owns the optimistic write, the list only calls it. */
    readonly onViewed: (fileId: string, viewed: boolean) => Promise<Feedback>;
    /** File from the URL fragment (`file=`), scrolled to on open. */
    readonly initialFileId?: string | null;
    /**
     * File kept on screen despite the filter (SPEC §2.7): the card gets an
     * "outside current filter" notice. The view decides which file to keep.
     */
    readonly keptFileId?: string | null;
    /** Top card in the viewport, used by scroll-spy for the active tree row. */
    readonly onTopFileChange?: (fileId: string | null) => void;
    /**
     * Reviewer scrolling lets the view clear the "kept on screen" mark. The list's own adjustments
     * (file link, tree navigation, repositioning after a filter change) do not trigger this.
     */
    readonly onScroll?: () => void;
    readonly ref?: Ref<DiffListHandle>;
}

export function DiffFileList({
    files,
    store,
    contentAvailable,
    parse,
    loadContent,
    onOpenInEditor,
    onViewed,
    initialFileId = null,
    keptFileId = null,
    onTopFileChange,
    onScroll,
    ref,
}: DiffFileListProps) {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const requested = useRef(new Set<string>());
    // Files whose parsing failed. Only an explicit reviewer retry will parse them again.
    const [parseErrors, setParseErrors] = useState<ReadonlyMap<string, string>>(new Map());

    const virtualizer = useVirtualizer({
        count: files.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: (index) => estimateHeight(files[index]),
        overscan: OVERSCAN,
        getItemKey: (index) => files[index]?.fileId ?? index,
    });

    const items = virtualizer.getVirtualItems();

    // Parse visible files. The worker replies asynchronously, and each file is requested only once.
    useEffect(() => {
        for (const item of items) {
            const file = files[item.index];
            if (file === undefined || requested.current.has(file.fileId)) {
                continue;
            }
            requested.current.add(file.fileId);
            void parse(file).then(
                (model) => {
                    store.setModel(file.fileId, model);
                },
                (error: unknown) => {
                    // Keep the file in `requested`. Automatic retries would loop if the worker kept failing.
                    // The card reports the failure and offers a retry button.
                    setParseErrors((previous) =>
                        new Map(previous).set(file.fileId, error instanceof Error ? error.message : String(error)),
                    );
                },
            );
        }
        // `parseErrors` is a dependency for retries. It does not change the set of visible files,
        // but clearing a failure must rerun this effect, or the retry would have to wait for
        // an unrelated scroll.
    }, [items, files, parse, store, parseErrors]);

    const retryParse = useCallback((fileId: string) => {
        requested.current.delete(fileId);
        setParseErrors((previous) => {
            const next = new Map(previous);
            next.delete(fileId);
            return next;
        });
    }, []);

    // Width available to the diff: side by side is unavailable below 1100px (SPEC §2.6). Measure the
    // list itself, not the window. The tree panel on its left takes 290px that the diff cannot use.
    // Use the padding-box (`clientWidth`), since page padding is part of the space given to the diff.
    // otherwise the reference 1440px viewport (README "Fidelity") would never meet the threshold.
    // Read the initial value immediately. ResizeObserver does not fire in a background tab.
    useEffect(() => {
        const element = scrollRef.current;
        if (element === null) {
            return;
        }
        const report = (): void => {
            store.setAvailableWidth(element.clientWidth);
        };
        report();
        const observer = new ResizeObserver(report);
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, [store]);

    // Esc and clicks outside the rows clear the selection (SPEC §2.14).
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                store.clearSelection();
            }
        };
        const onPointerDown = (event: MouseEvent): void => {
            const target = event.target as HTMLElement | null;
            if (target?.closest('.diff-rows') === null) {
                store.clearSelection();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('mousedown', onPointerDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('mousedown', onPointerDown);
        };
    }, [store]);

    // While the list adjusts scrolling itself (a `#file=` link, tree navigation, repositioning after
    // a filter change), no scroll event is reported upward. These are not reviewer gestures and
    // must not clear the "kept on screen" notice (SPEC §2.7).
    const settling = useRef(0);
    const converge = useCallback(
        (index: number) => {
            settling.current += 1;
            return convergeScroll(
                () => {
                    virtualizer.scrollToIndex(index, { align: 'start' });
                },
                () => scrollRef.current?.scrollTop ?? 0,
                () => {
                    // One frame later. The browser dispatches scroll events after the final step.
                    requestAnimationFrame(() => {
                        settling.current -= 1;
                    });
                },
            );
        },
        [virtualizer],
    );

    const handleScroll = useCallback(() => {
        if (settling.current === 0) {
            onScroll?.();
        }
    }, [onScroll]);

    // A file link (`#file=`) opens the diff scrolled to that file.
    const scrolled = useRef(false);
    useEffect(() => {
        if (scrolled.current || initialFileId === null) {
            return;
        }
        const index = files.findIndex((file) => file.fileId === initialFileId);
        scrolled.current = true;
        if (index < 0) {
            return;
        }

        const run = converge(index);
        return () => {
            // Adjustment was interrupted before completion (StrictMode unmounts effects twice), so
            // scrolling did not finish and the next pass must repeat it.
            if (!run.cancel()) {
                scrolled.current = false;
            }
        };
    }, [files, initialFileId, converge]);

    // Scroll to the file requested by the tree. Cancel the previous adjustment, because two overlapping
    // loops would pull the list in different directions.
    const pending = useRef<ConvergingScroll | null>(null);
    useImperativeHandle(
        ref,
        () => ({
            scrollToFile: (fileId: string) => {
                const index = files.findIndex((file) => file.fileId === fileId);
                if (index < 0) {
                    return;
                }
                pending.current?.cancel();
                pending.current = converge(index);
            },
        }),
        [files, converge],
    );

    // Tree scroll-spy uses the top card in the viewport. The virtualizer rerenders the list
    // on every scroll frame, so no separate listener is needed.
    const topFileId = topFile(files, items, virtualizer.scrollOffset ?? 0);
    const reportedTop = useRef<string | null>(null);
    useEffect(() => {
        if (onTopFileChange !== undefined && topFileId !== reportedTop.current) {
            reportedTop.current = topFileId;
            onTopFileChange(topFileId);
        }
    }, [topFileId, onTopFileChange]);

    const expand = useCallback(
        async (fileId: string, amount?: ExpandAmount): Promise<Feedback> => {
            if (!contentAvailable) {
                return null;
            }
            if (store.getSnapshot().content.has(fileId)) {
                store.expand(fileId, amount);
                return null;
            }

            let content: FileContent | null;
            try {
                content = await loadContent(fileId);
            } catch (error: unknown) {
                // A failed request does not mean "no content". Caching it as null would
                // disable the button permanently for the wrong reason. Leave the cache untouched and retry.
                const reason = (error instanceof Error ? error.message : String(error)).replace(/\s*\.\s*$/, '');
                return `Could not fetch the file contents: ${reason}. Try again.`;
            }

            store.setContent(fileId, content);
            if (content !== null) {
                store.expand(fileId, amount);
            }
            return null;
        },
        [contentAvailable, loadContent, store],
    );

    const actions = useMemo<FileCardActions>(
        () => ({
            onViewed,
            onExpand: expand,
            onRetryParse: retryParse,
            onOpenFile: store.openFile,
            onSelectStart: (fileId, key, extend) => {
                if (extend) {
                    store.extendSelection(fileId, key);
                } else {
                    store.startSelection(fileId, key);
                }
            },
            onSelectExtend: store.extendSelection,
            onOpenInEditor,
            onCopyLink: copyFileLink,
        }),
        [expand, onOpenInEditor, onViewed, retryParse, store],
    );

    return (
        <div className="diff-list" ref={scrollRef} onScroll={handleScroll}>
            <div className="diff-list__inner" style={{ height: `${String(virtualizer.getTotalSize())}px` }}>
                {items.map((item) => {
                    const file = files[item.index];
                    if (file === undefined) {
                        return null;
                    }
                    return (
                        <div
                            key={file.fileId}
                            className="diff-list__item"
                            data-index={item.index}
                            ref={virtualizer.measureElement}
                            // Position with `top` rather than `transform`: the card's sticky header
                            // uses its layout position, so a transformed card's header
                            // sticks at the card's bottom instead of the screen's top edge.
                            style={{ top: `${String(item.start)}px` }}
                        >
                            <FileCard
                                file={file}
                                model={snapshot.models.get(file.fileId) ?? null}
                                parseError={parseErrors.get(file.fileId) ?? null}
                                mode={snapshot.effectiveMode}
                                content={snapshot.content.get(file.fileId)}
                                contentAvailable={contentAvailable}
                                expansion={snapshot.expansion.get(file.fileId) ?? 0}
                                read={readStateOf(snapshot, file)}
                                opened={snapshot.opened.has(file.fileId)}
                                keptInView={file.fileId === keptFileId}
                                selection={
                                    snapshot.selection?.fileId === file.fileId ? snapshot.selection : null
                                }
                                actions={actions}
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

interface ConvergingScroll {
    /** `true` once adjustment has finished on its own. */
    readonly cancel: () => boolean;
}

/**
 * Adjust virtualizer scrolling. Heights are estimates until cards are first measured, so
 * the target moves and a single call is not enough. Repeat until the position stops changing.
 * `onDone` runs exactly once, on both natural completion and cancellation.
 */
function convergeScroll(step: () => void, currentTop: () => number, onDone: () => void): ConvergingScroll {
    let attempts = 0;
    let previousTop = -1;
    let done = false;
    const finish = (): void => {
        if (!done) {
            done = true;
            onDone();
        }
    };

    let frame = requestAnimationFrame(function tick() {
        step();
        attempts += 1;
        const top = currentTop();
        const converged = top === previousTop;
        previousTop = top;
        if (!converged && attempts < SCROLL_TO_FILE_FRAMES) {
            frame = requestAnimationFrame(tick);
            return;
        }
        attempts = SCROLL_TO_FILE_FRAMES;
        finish();
    });

    return {
        cancel: () => {
            cancelAnimationFrame(frame);
            const completed = attempts >= SCROLL_TO_FILE_FRAMES;
            finish();
            return completed;
        },
    };
}

/**
 * File read state from the snapshot. If the file is absent from the map (the store was built
 * for a different set), use the file's own defaults instead of showing an empty box.
 */
function readStateOf(snapshot: { readState: ReadonlyMap<string, FileReadState> }, file: FileDiff): FileReadState {
    return snapshot.readState.get(file.fileId) ?? computeReadState({ file, record: null });
}

/** First card whose bottom is still below the viewport's top edge. null means nothing to show. */
function topFile(
    files: readonly FileDiff[],
    items: readonly { index: number; end: number }[],
    offset: number,
): string | null {
    for (const item of items) {
        if (item.end > offset) {
            return files[item.index]?.fileId ?? null;
        }
    }
    return null;
}

function estimateHeight(file: FileDiff | undefined): number {
    if (file === undefined) {
        return CARD_CHROME_HEIGHT;
    }
    // A file above the threshold starts collapsed (SPEC §2.13), with one button row instead of thousands
    // of code lines. Capping the line count at the threshold would overestimate height hundreds of times and break the scrollbar.
    const changed = file.additions + file.deletions;
    const lines = changed > COLLAPSE_THRESHOLD ? 1 : changed;
    return CARD_CHROME_HEIGHT + lines * CODE_LINE_HEIGHT;
}

/** A file link is the current address plus the `file` fragment parameter. */
async function copyFileLink(fileId: string): Promise<Feedback> {
    const url = new URL(window.location.href);
    url.hash = updateFragment(window.location.hash, { file: fileId });

    try {
        await navigator.clipboard.writeText(url.toString());
    } catch {
        return 'The browser could not copy the link. Copy the page address manually.';
    }
    return 'File link copied.';
}
