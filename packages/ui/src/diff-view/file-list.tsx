import type { FileContent, FileDiff } from '@sherpa/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { DiffFileModel } from '../diff/model.js';
import { updateFragment } from '../fragment.js';
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

export interface DiffFileListProps {
    readonly files: readonly FileDiff[];
    readonly store: DiffViewStore;
    /** The host can supply file contents (`capabilities.fileContent`). */
    readonly contentAvailable: boolean;
    /** Patch parsing uses a worker for live data and a synchronous parser in the gallery. */
    readonly parse: (file: FileDiff) => Promise<DiffFileModel>;
    readonly loadContent: (fileId: string) => Promise<FileContent | null>;
    readonly onOpenInEditor: (path: string) => Promise<Feedback>;
    /** File from the URL fragment (`file=`), scrolled to on open. */
    readonly initialFileId?: string | null;
}

export function DiffFileList({
    files,
    store,
    contentAvailable,
    parse,
    loadContent,
    onOpenInEditor,
    initialFileId = null,
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

    // Width available to the diff: below 1100px, side by side is unavailable (SPEC §2.6).
    useEffect(() => {
        const element = scrollRef.current;
        if (element === null) {
            return;
        }
        store.setAvailableWidth(element.clientWidth);
        const observer = new ResizeObserver((entries) => {
            const width = entries[0]?.contentRect.width;
            if (width !== undefined) {
                store.setAvailableWidth(width);
            }
        });
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

    // A file link (`#file=`) opens the diff scrolled to that file. Scrolling repeats
    // for several frames: before cards are measured, heights are estimates and the target moves.
    const scrolled = useRef(false);
    useEffect(() => {
        if (scrolled.current || initialFileId === null) {
            return;
        }
        const index = files.findIndex((file) => file.fileId === initialFileId);
        if (index < 0) {
            scrolled.current = true;
            return;
        }

        scrolled.current = true;
        let attempts = 0;
        let previousTop = -1;
        let frame = requestAnimationFrame(function tick() {
            virtualizer.scrollToIndex(index, { align: 'start' });
            attempts += 1;
            // The position stopped shifting. Cards above the target have been measured, so no adjustment is needed.
            const top = scrollRef.current?.scrollTop ?? 0;
            const converged = top === previousTop;
            previousTop = top;
            if (!converged && attempts < SCROLL_TO_FILE_FRAMES) {
                frame = requestAnimationFrame(tick);
                return;
            }
            attempts = SCROLL_TO_FILE_FRAMES;
        });
        return () => {
            cancelAnimationFrame(frame);
            // Adjustment was interrupted before completion (StrictMode unmounts effects twice), so
            // scrolling did not finish and the next pass must repeat it.
            if (attempts < SCROLL_TO_FILE_FRAMES) {
                scrolled.current = false;
            }
        };
    }, [files, initialFileId, virtualizer]);

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
            onViewed: store.setViewed,
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
        [expand, onOpenInEditor, retryParse, store],
    );

    return (
        <div className="diff-list" ref={scrollRef}>
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
                                viewed={snapshot.viewed.get(file.fileId) ?? false}
                                opened={snapshot.opened.has(file.fileId)}
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
