import type { FileDiff } from '@sherpa/protocol';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { KeyboardEvent, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { FileFilter } from '../filters/lens-filters.js';
import type { FileReadState } from '../progress/read-state.js';
import { useShortcut } from '../shortcuts/context.tsx';
import { formatCount } from '../text.js';
import type { CollapsedStorage } from './collapsed-storage.js';
import { readCollapsed, writeCollapsed } from './collapsed-storage.js';
import type { FileTree, TreeDirRow, TreeFileRow, TreeRow } from './file-tree.js';
import { buildFileTree, filterByQuery, readBox, readSummary, rowKey, splitLabel, toggleDirectory } from './file-tree.js';
import './file-tree.css';
import { treeKeyCommand } from './tree-keys.js';

/**
 * Full diff left panel (README §10, SPEC §2.20): search field, lens filter chips
 * and file tree. The panel loads nothing and owns only its local
 * state: collapsed directories, search text and keyboard cursor position.
 *
 * A single-file PR gets a file outline, a list of hunks, instead of a single-row tree.
 */

/** Tree row height (SPEC §2.20). The virtualizer needs an exact size, not an estimate. */
const ROW_HEIGHT = 26;

/** Row indentation: base plus nesting level (README §10). */
const INDENT_BASE = 8;
const INDENT_STEP = 13;

const OVERSCAN = 8;

/** A single hunk in the outline of a single-file PR. */
export interface OutlineEntry {
    readonly index: number;
    readonly label: string;
}

/**
 * Single-file PR outline: parsing in progress, parsing finished with nothing to list (a binary file,
 * an unparsed patch or a file without hunks), or ready entries.
 */
export type FileOutlineModel =
    | { readonly state: 'parsing' }
    | { readonly state: 'empty'; readonly reason: string }
    | { readonly state: 'ready'; readonly entries: readonly OutlineEntry[] };

export interface FilePanelProps {
    /** Files after the lens filter. The panel applies search text itself. */
    readonly files: readonly FileDiff[];
    readonly filters: readonly FileFilter[];
    readonly activeFilter: FileFilter;
    readonly onFilter: (id: string) => void;
    readonly pciFileIds: ReadonlySet<string>;
    /** null means no ownership lens. Roots outside your ownership zone are not dimmed. */
    readonly mineFileIds: ReadonlySet<string> | null;
    readonly readState: ReadonlyMap<string, FileReadState>;
    /** The active file is the top card in the viewport (right-panel scroll-spy). */
    readonly activeFileId: string | null;
    readonly onOpenFile: (fileId: string) => void;
    /** The `v` key on a file row (SPEC §2.10). The tree has no checkbox of its own. */
    readonly onToggleViewed: (fileId: string) => void;
    /** Failed mark write from the tree: an inline hint with retry (SPEC §1.2, §2.10). */
    readonly writeError: { readonly text: string; readonly onRetry: () => void } | null;
    /** Outline instead of a tree. null means the PR has more than one file. */
    readonly outline: FileOutlineModel | null;
    readonly onOpenHunk: (index: number) => void;
    /** PR key: collapsed directory state persists separately for each PR. */
    readonly prKey: string;
    /** Collapsed state storage. With null, state does not survive a reload (gallery, tests). */
    readonly storage: CollapsedStorage | null;
    readonly inputRef?: RefObject<HTMLInputElement | null>;
}

export function FilePanel(props: FilePanelProps) {
    const { files, filters, activeFilter, onFilter, outline, inputRef, writeError } = props;
    const [query, setQuery] = useState('');

    return (
        <aside className="file-panel" aria-label="Diff files">
            <div className="file-panel__search">
                <span className="file-panel__search-icon" aria-hidden="true">
                    ⌕
                </span>
                <input
                    ref={inputRef}
                    className="file-panel__input"
                    type="search"
                    value={query}
                    placeholder="Filter files"
                    aria-label="Filter files by name"
                    onChange={(event) => {
                        setQuery(event.target.value);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                            setQuery('');
                        }
                    }}
                />
            </div>

            <div className="file-panel__chips">
                {filters.map((filter) => (
                    <button
                        key={filter.id}
                        type="button"
                        className={`file-panel__chip${filter.id === activeFilter.id ? ' is-on' : ''}`}
                        disabled={!filter.available}
                        aria-pressed={filter.id === activeFilter.id}
                        title={filter.available ? filter.label : (filter.note ?? 'filter unavailable')}
                        onClick={() => {
                            onFilter(filter.id);
                        }}
                    >
                        {filter.shortLabel} <span className="file-panel__chip-count">{filter.count}</span>
                    </button>
                ))}
            </div>

            {writeError === null ? null : (
                <p className="file-panel__notice" role="status">
                    {writeError.text}
                    <button type="button" className="file-panel__link" onClick={writeError.onRetry}>
                        retry
                    </button>
                </p>
            )}

            {outline === null ? (
                <FileTreeView
                    {...props}
                    query={query}
                    onClearQuery={() => {
                        setQuery('');
                    }}
                />
            ) : (
                <FileOutline outline={outline} onOpenHunk={props.onOpenHunk} name={files[0]?.path ?? ''} />
            )}
        </aside>
    );
}

interface FileTreeViewProps extends FilePanelProps {
    readonly query: string;
    readonly onClearQuery: () => void;
}

function FileTreeView({
    files,
    query,
    onClearQuery,
    pciFileIds,
    mineFileIds,
    readState,
    activeFileId,
    onOpenFile,
    onToggleViewed,
    prKey,
    storage,
}: FileTreeViewProps) {
    const [collapsed, setCollapsed] = useState<ReadonlyMap<string, boolean>>(() => readCollapsed(storage, prKey));
    // The panel is not expected to switch PRs during its lifetime, but state must follow the key:
    // otherwise another PR would inherit the previous collapsed directories.
    useEffect(() => {
        setCollapsed(readCollapsed(storage, prKey));
    }, [storage, prKey]);

    const tree: FileTree = useMemo(
        () =>
            buildFileTree({
                files: filterByQuery(files, query),
                pciFileIds,
                mineFileIds,
                readState,
                collapsed,
            }),
        [files, query, pciFileIds, mineFileIds, readState, collapsed],
    );

    const persist = useCallback(
        (next: ReadonlyMap<string, boolean>) => {
            setCollapsed(next);
            writeCollapsed(storage, prKey, next);
        },
        [prKey, storage],
    );

    const [cursor, setCursor] = useState(-1);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const virtualizer = useVirtualizer({
        count: tree.rows.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: OVERSCAN,
        getItemKey: (index) => {
            const row = tree.rows[index];
            return row === undefined ? index : rowKey(row);
        },
        // Always render the row under the keyboard cursor, even outside the virtualization window.
        // `aria-activedescendant` references its id. Without the element in the DOM, screen readers
        // stop announcing the cursor.
        rangeExtractor: (range) => {
            const indexes = defaultRangeExtractor(range);
            if (cursor < 0 || cursor >= tree.rows.length || indexes.includes(cursor)) {
                return indexes;
            }
            return [...indexes, cursor].sort((a, b) => a - b);
        },
    });

    // The active row comes from the right-panel scroll-spy and needs to be brought into view.
    const activeIndex = tree.rows.findIndex((row) => row.kind === 'file' && row.fileId === activeFileId);
    useEffect(() => {
        if (activeIndex >= 0) {
            virtualizer.scrollToIndex(activeIndex, { align: 'auto' });
        }
    }, [activeIndex, virtualizer]);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        const command = treeKeyCommand(event.key, tree.rows, cursor);
        if (command === null) {
            return;
        }
        event.preventDefault();
        if (command.kind === 'focus') {
            setCursor(command.index);
            virtualizer.scrollToIndex(command.index, { align: 'auto' });
        } else if (command.kind === 'setCollapsed') {
            persist(new Map(collapsed).set(command.path, command.collapsed));
        } else {
            onOpenFile(command.fileId);
        }
    };

    const cursorRow = cursor < 0 ? undefined : tree.rows[cursor];
    // `v` is a registry command (requirements §3.3), not a separate key handler, so it appears in the palette
    // and shortcuts sheet. It acts on the row under the cursor, only while the tree has focus.
    useShortcut({
        id: 'diff.markViewed',
        keys: ['v'],
        label: 'Mark the file viewed',
        when: () => cursorRow?.kind === 'file' && scrollRef.current?.contains(document.activeElement) === true,
        action: () => {
            if (cursorRow?.kind === 'file') {
                onToggleViewed(cursorRow.fileId);
            }
        },
    });

    if (files.length === 0) {
        return <p className="file-panel__empty">No files in this filter.</p>;
    }
    if (tree.rows.length === 0) {
        return (
            <p className="file-panel__empty">
                No files match.
                <button type="button" className="file-panel__link" onClick={onClearQuery}>
                    Clear
                </button>
            </p>
        );
    }

    return (
        <div
            className="file-tree"
            ref={scrollRef}
            role="tree"
            aria-label="File tree"
            tabIndex={0}
            aria-activedescendant={cursorRow === undefined ? undefined : rowDomId(cursorRow)}
            onKeyDown={onKeyDown}
        >
            <div className="file-tree__inner" style={{ height: `${String(virtualizer.getTotalSize())}px` }}>
                {virtualizer.getVirtualItems().map((item) => {
                    const row = tree.rows[item.index];
                    if (row === undefined) {
                        return null;
                    }
                    return (
                        <div
                            key={rowKey(row)}
                            id={rowDomId(row)}
                            role="treeitem"
                            aria-level={row.depth + 1}
                            aria-expanded={row.kind === 'dir' ? !row.collapsed : undefined}
                            aria-selected={row.kind === 'file' && row.fileId === activeFileId}
                            className={rowClassName(row, activeFileId, item.index === cursor)}
                            // Position with `top`, not `transform`. Lesson from T6: transforms break
                            // sticky elements inside a scrolling panel.
                            style={{ top: `${String(item.start)}px`, paddingLeft: `${String(INDENT_BASE + row.depth * INDENT_STEP)}px` }}
                            onClick={(event) => {
                                setCursor(item.index);
                                if (row.kind === 'dir') {
                                    persist(toggleDirectory(tree, collapsed, row.path, event.altKey));
                                } else {
                                    onOpenFile(row.fileId);
                                }
                            }}
                        >
                            {row.kind === 'dir' ? <DirRow row={row} /> : <FileRow row={row} />}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/** DOM row id: safely encoded row key (IDREF cannot contain spaces). */
function rowDomId(row: TreeRow): string {
    return `tree-row-${encodeURIComponent(rowKey(row))}`;
}

function rowClassName(row: TreeRow, activeFileId: string | null, cursor: boolean): string {
    const classes = ['file-tree__row', `file-tree__row--${row.kind}`];
    if (row.kind === 'file' && row.fileId === activeFileId) {
        classes.push('is-active');
    }
    if (cursor) {
        classes.push('is-cursor');
    }
    if (row.generated) {
        classes.push('is-generated');
    }
    if (row.kind === 'dir' && row.foreign) {
        classes.push('is-foreign');
    }
    return classes.join(' ');
}

function DirRow({ row }: { row: TreeDirRow }) {
    const summary = readSummary(row);
    return (
        <>
            <span className="file-tree__chevron" aria-hidden="true">
                {row.collapsed ? '›' : '⌄'}
            </span>
            <span
                className={`file-tree__read file-tree__read--${summary}`}
                title={`${String(row.readFiles)} of ${String(row.files)} read`}
            >
                {summary === 'full' ? '✓' : ''}
            </span>
            <Label label={row.label} title={row.path} />
            <Counts additions={row.additions} deletions={row.deletions} />
        </>
    );
}

function FileRow({ row }: { row: TreeFileRow }) {
    return (
        <>
            <span className="file-tree__chevron" aria-hidden="true" />
            {/* Three read-state values (SPEC §2.12). The tooltip always has counts. */}
            <span className={`file-tree__read file-tree__read--${readBox(row.read.state)}`} title={row.read.tooltip}>
                {row.read.state === 'read' ? '✓' : ''}
            </span>
            <Label label={row.label} title={row.path} />
            {row.pci ? <span className="file-tree__tag">pci</span> : null}
            {row.generated ? <span className="file-tree__tag file-tree__tag--gen">gen</span> : null}
            <Counts additions={row.additions} deletions={row.deletions} />
        </>
    );
}

/**
 * Row label (SPEC §1.2): truncate the directory chain from the left, letting it give up space first.
 * Preserve the last segment with its extension as long as possible. `bdi` isolates text direction,
 * otherwise left truncation (`direction: rtl`) would move the slash to the other end.
 */
function Label({ label, title }: { label: string; title: string }) {
    const { dir, name } = splitLabel(label);
    return (
        <span className="file-tree__label" title={title}>
            {dir === '' ? null : (
                <span className="file-tree__label-dir">
                    <bdi>{dir}</bdi>
                </span>
            )}
            <span className="file-tree__label-name">
                <bdi>{name}</bdi>
            </span>
        </span>
    );
}

/** Show `−M` only when there is something to show. Space is scarce in a 290px panel. */
function Counts({ additions, deletions }: { additions: number; deletions: number }) {
    return (
        <span className="file-tree__counts">
            <span className="file-tree__add">+{formatCount(additions)}</span>
            {deletions > 0 ? <span className="file-tree__del">−{formatCount(deletions)}</span> : null}
        </span>
    );
}

/**
 * Single-file PR outline (SPEC §2.20: "the tree is replaced by the file's outline").
 * Entries are hunks with entity labels from the T5 model. This approximates real symbol
 * navigation, which comes in M5.
 */
function FileOutline({
    outline,
    onOpenHunk,
    name,
}: {
    outline: FileOutlineModel;
    onOpenHunk: (index: number) => void;
    name: string;
}) {
    if (outline.state === 'parsing') {
        return <p className="file-panel__empty">The diff is still being parsed.</p>;
    }
    if (outline.state === 'empty') {
        return <p className="file-panel__empty">{outline.reason}</p>;
    }

    return (
        <nav className="file-tree file-tree--outline" aria-label={`Outline of ${name}`}>
            {outline.entries.map((entry) => (
                <button
                    key={entry.index}
                    type="button"
                    className="file-tree__row file-tree__row--outline"
                    onClick={() => {
                        onOpenHunk(entry.index);
                    }}
                >
                    {/* An outline entry is an entity name, not a path. Truncate it from the end. */}
                    <span className="file-tree__outline-label">{entry.label}</span>
                </button>
            ))}
        </nav>
    );
}
