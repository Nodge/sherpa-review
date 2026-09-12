import type { FileDiff } from '@sherpa/protocol';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { FileContextMenu, useContextMenu } from '../components/context-menu.tsx';
import type { FileFilter } from '../filters/lens-filters.js';
import type { MessageKey } from '../i18n/index.js';
import { useFormat, useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { usePrState, usePrStateStore } from '../pr-state/context.tsx';
import { collapsedFromMap, collapsedToMap } from '../pr-state/pr-state-store.js';
import { useReadOnlyIteration, useReadOnlyReason } from '../iterations/read-only.tsx';
import type { FileReadState } from '../progress/read-state.js';
import { readStateTooltip } from '../progress/read-state.js';
import type { RouteMarginModel } from '../route/margin-model.js';
import { marginFooterNote } from '../route/margin-model.js';
import { RouteBadge } from '../route/route-margin.tsx';
import { useShortcut } from '../shortcuts/context.tsx';
import type { FileTree, TreeDirRow, TreeFileRow, TreeRow } from './file-tree.js';
import { buildFileTree, filterByQuery, readBox, rowKey, splitLabel, toggleDirectory } from './file-tree.js';
import './file-tree.css';
import { treeKeyCommand } from './tree-keys.js';

/**
 * Left panel of the full diff (docs/design/README.md §10, docs/design/SPEC-elements.md §2.20):
 * filter field, lens filter chips and file tree. The panel loads nothing and owns only its local
 * state: collapsed directories, search text and keyboard cursor position.
 *
 * A single-file PR gets a file outline, a list of hunks, instead of a single-row tree.
 */

/** Tree row height (docs/design/SPEC-elements.md §2.20). The virtualizer needs an exact size, not an estimate. */
const ROW_HEIGHT = 26;

/** Row indentation: base plus nesting depth (docs/design/README.md §10). */
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
    | { readonly state: 'empty'; readonly reason: MessageKey }
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
    /** Route in the margins (docs/design/README.md §10): row badges and footer note. null means no route. */
    readonly route: RouteMarginModel | null;
    /** Navigate to a stop on the route tab. Without this, badges remain labels. */
    readonly onJumpToStop?: ((stopId: string) => void) | undefined;
    /** The active file is the top card in the viewport (right-panel scroll-spy). */
    readonly activeFileId: string | null;
    readonly onOpenFile: (fileId: string) => void;
    /** Shared action for the viewed checkbox and the `v` key on a file row (docs/design/SPEC-elements.md §2.10). */
    readonly onToggleViewed: (fileId: string) => void;
    /** Failed mark write from the tree: inline hint with retry (docs/design/SPEC-elements.md §1.2, §2.10). */
    readonly writeError: { readonly text: string; readonly onRetry: () => void } | null;
    /** Outline instead of a tree. null means the PR has more than one file. */
    readonly outline: FileOutlineModel | null;
    readonly onOpenHunk: (index: number) => void;
    readonly inputRef?: RefObject<HTMLInputElement | null>;
}

export function FilePanel(props: FilePanelProps) {
    const t = useT();
    const { files, filters, activeFilter, onFilter, outline, inputRef, writeError, route } = props;
    const [query, setQuery] = useState('');
    // The note describes the whole route, regardless of the current filter. Badges ignore the filter too.
    const footer = route === null ? null : marginFooterNote(route, t);

    return (
        <aside className="file-panel" aria-label={t('tree.aria')}>
            <div className="file-panel__search">
                <span className="file-panel__search-icon" aria-hidden="true">
                    <Icon name="search" size={13} />
                </span>
                <input
                    ref={inputRef}
                    className="file-panel__input"
                    type="search"
                    value={query}
                    placeholder={t('tree.filter.placeholder')}
                    aria-label={t('tree.filter.aria')}
                    onChange={(event) => {
                        setQuery(event.target.value);
                    }}
                    onKeyDown={(event) => {
                        // Esc clears the query. The registry's priority chain receives it only when
                        // there was nothing to clear, otherwise the field would swallow the overlay close action.
                        if (event.key === 'Escape' && query !== '') {
                            event.stopPropagation();
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
                        title={filter.available ? filter.label : (filter.note ?? t('tree.filter.unavailable'))}
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
                        {t('tree.retry')}
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

            {/* Route footer note (docs/design/README.md §10): computed counts, placed
                below the tree, outside its scroll area. */}
            {footer === null ? null : <p className="file-panel__footer">{footer}</p>}
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
    route,
    onJumpToStop,
}: FileTreeViewProps) {
    const t = useT();
    // Only the active iteration allows marking files viewed.
    const readOnly = useReadOnlyIteration();
    // Directory collapse state lives in the server's PR state. It stores the reviewer's explicit choice,
    // and directories without a record follow the size-based default.
    const prState = usePrStateStore();
    const treeCollapsed = usePrState().treeCollapsed;
    const collapsed = useMemo(() => collapsedToMap(treeCollapsed), [treeCollapsed]);

    const tree: FileTree = useMemo(
        () =>
            buildFileTree({
                files: filterByQuery(files, query),
                pciFileIds,
                mineFileIds,
                readState,
                routeFiles: route?.files ?? null,
                collapsed,
            }),
        [files, query, pciFileIds, mineFileIds, readState, route, collapsed],
    );

    const persist = useCallback(
        (next: ReadonlyMap<string, boolean>) => {
            prState.update({ treeCollapsed: collapsedFromMap(next) });
        },
        [prState],
    );

    const [cursor, setCursor] = useState(-1);
    // One menu per tree. Its target row is stored separately from the anchor point.
    const menu = useContextMenu();
    const [menuRow, setMenuRow] = useState<TreeFileRow | null>(null);
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
    // `v` is a registry command (docs/architecture.md §7.3), rather than a separate key handler, so it
    // appears in the palette and shortcuts sheet. It acts on the row under the cursor only while the tree has
    // focus. Previous iterations have no marks, so the command is unavailable there.
    useShortcut({
        id: 'diff.markViewed',
        keys: ['v'],
        label: 'shortcut.diff.markViewed',
        scope: 'full-diff',
        section: 'reading',
        when: () =>
            !readOnly && cursorRow?.kind === 'file' && scrollRef.current?.contains(document.activeElement) === true,
        action: () => {
            if (cursorRow?.kind === 'file') {
                onToggleViewed(cursorRow.fileId);
            }
        },
    });

    if (files.length === 0) {
        return <p className="file-panel__empty">{t('tree.empty.filter')}</p>;
    }
    if (tree.rows.length === 0) {
        return (
            <p className="file-panel__empty">
                {t('tree.empty.query')}
                <button type="button" className="file-panel__link" onClick={onClearQuery}>
                    {t('tree.empty.clear')}
                </button>
            </p>
        );
    }

    return (
        <div
            className="file-tree"
            ref={scrollRef}
            role="tree"
            aria-label={t('tree.rows.aria')}
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
                            title={
                                row.kind === 'dir'
                                    ? t('tree.dir.read', row.readFiles, row.files)
                                    : undefined
                            }
                            className={rowClassName(row, activeFileId, item.index === cursor)}
                            // Position with `top`. Using `transform` breaks sticky
                            // elements inside the scrollable panel.
                            style={{ top: `${String(item.start)}px`, paddingLeft: `${String(INDENT_BASE + row.depth * INDENT_STEP)}px` }}
                            onClick={(event) => {
                                setCursor(item.index);
                                if (row.kind === 'dir') {
                                    persist(toggleDirectory(tree, collapsed, row.path, event.altKey));
                                } else {
                                    onOpenFile(row.fileId);
                                }
                            }}
                            onContextMenu={(event) => {
                                if (row.kind !== 'file') {
                                    return;
                                }
                                setCursor(item.index);
                                setMenuRow(row);
                                menu.openAtPointer(event);
                            }}
                        >
                            {row.kind === 'dir' ? (
                                <DirRow row={row} />
                            ) : (
                                <FileRow
                                    row={row}
                                    otherStopId={route?.otherStopId ?? null}
                                    onJumpToStop={onJumpToStop}
                                    menuOpen={menu.open && menuRow?.fileId === row.fileId}
                                    onMenu={(event) => {
                                        setCursor(item.index);
                                        setMenuRow(row);
                                        menu.openAtButton(event);
                                    }}
                                    onToggleViewed={(fileId) => {
                                        setCursor(item.index);
                                        onToggleViewed(fileId);
                                    }}
                                />
                            )}
                        </div>
                    );
                })}
            </div>

            {menu.anchor === null || menuRow === null ? null : (
                <FileContextMenu
                    file={menuRow}
                    viewed={menuRow.read.state === 'read'}
                    onToggleViewed={() => {
                        onToggleViewed(menuRow.fileId);
                    }}
                    anchor={menu.anchor}
                    onClose={menu.close}
                    toggleRef={menu.toggleRef}
                />
            )}
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
    return (
        <>
            <span className="file-tree__chevron" aria-hidden="true">
                <Icon name={row.collapsed ? 'chev-right' : 'chev-down'} size={13} />
            </span>
            <Label label={row.label} title={row.path} />
            <Counts additions={row.additions} deletions={row.deletions} />
        </>
    );
}

function FileRow({
    row,
    otherStopId,
    onJumpToStop,
    menuOpen,
    onMenu,
    onToggleViewed,
}: {
    row: TreeFileRow;
    otherStopId: string | null;
    onJumpToStop?: ((stopId: string) => void) | undefined;
    menuOpen: boolean;
    onMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
    onToggleViewed: (fileId: string) => void;
}) {
    const t = useT();
    const readOnly = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();
    return (
        <>
            <span className="file-tree__chevron" aria-hidden="true" />
            {/* Three read-state values (docs/design/SPEC-elements.md §2.12). The tooltip always includes counts. */}
            <button
                type="button"
                className={`file-tree__read file-tree__read--${readBox(row.read.state)}`}
                aria-pressed={row.read.state === 'read'}
                aria-hidden="true"
                tabIndex={-1}
                disabled={readOnly}
                title={readOnly ? readOnlyReason : readStateTooltip(t, row.read)}
                onMouseDown={(event) => {
                    event.preventDefault();
                }}
                onClick={(event) => {
                    event.stopPropagation();
                    onToggleViewed(row.fileId);
                }}
            >
                {row.read.state === 'read' ? <Icon name="check" size={9} /> : null}
            </button>
            <Label label={row.label} title={row.path} />
            {row.pci ? <span className="file-tree__tag">pci</span> : null}
            {row.generated ? <span className="file-tree__tag file-tree__tag--gen">gen</span> : null}
            {row.conflict ? (
                <span className="file-tree__tag file-tree__tag--conflict">{t('file.conflict')}</span>
            ) : null}
            {row.route === null ? null : (
                <RouteBadge file={row.route} otherStopId={otherStopId} variant="tree" onJump={onJumpToStop} />
            )}
            {/* The menu button stays out of the tab order, like the read-state checkbox. Arrow keys navigate the tree. */}
            <button
                type="button"
                className={`file-tree__more${menuOpen ? ' is-open' : ''}`}
                tabIndex={-1}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={t('file.menu.more')}
                onMouseDown={(event) => {
                    event.preventDefault();
                }}
                onClick={onMenu}
            >
                ⋯
            </button>
            <Counts additions={row.additions} deletions={row.deletions} />
        </>
    );
}

/**
 * Row label (docs/design/SPEC-elements.md §1.2): the directory chain truncates from the left and gives up space first,
 * the final segment with its extension holds out longest and truncates from the end if it still does not fit.
 * `bdi` isolates direction, or left truncation (`direction: rtl`) would move the slash to the other edge.
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
    const { count } = useFormat();
    return (
        <span className="file-tree__counts">
            <span className="file-tree__add">+{count(additions)}</span>
            {deletions > 0 ? <span className="file-tree__del">−{count(deletions)}</span> : null}
        </span>
    );
}

/**
 * Single-file PR outline (docs/design/SPEC-elements.md §2.20: "the tree is replaced by the file's outline").
 * Items are hunks with entity labels from the diff model, an approximation of symbol navigation.
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
    const t = useT();
    if (outline.state === 'parsing') {
        return <p className="file-panel__empty">{t('tree.outline.parsing')}</p>;
    }
    if (outline.state === 'empty') {
        return <p className="file-panel__empty">{t(outline.reason)}</p>;
    }

    return (
        <nav className="file-tree file-tree--outline" aria-label={t('tree.outline.aria', name)}>
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
