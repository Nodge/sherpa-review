import type { KeyboardEvent, MouseEvent } from 'react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../icons/icon.tsx';
import { usePrState, usePrStateStore } from '../pr-state/context.tsx';
import { addRecentCommand, PALETTE_RECENT_LIMIT } from '../pr-state/pr-state-store.js';
import { useEscapeLayer, useShortcut, useShortcutList } from '../shortcuts/context.tsx';
import type { Shortcut } from '../shortcuts/registry.js';
import { formatKeys } from '../shortcuts/registry.js';
import { plural } from '../text.js';
import { isRowSelected, menuSections, rowText, rowTitle } from '../iterations/snapshot-picker.tsx';
import type { PickerRows, Viewing } from '../iterations/viewing.js';
import { movePaletteCursor, scrollPaletteCursor } from './cursor.js';
import type { PaletteDiffSource } from './diff-source.tsx';
import { lineSideInDiff, searchDiff } from './diff-search.js';
import type { DiffSearchMatch } from './diff-search.js';
import { fuzzyMatch } from './fuzzy.js';
import { parsePaletteQuery } from './query.js';
import './command-palette.css';

/** "Iterations…" mode uses the same rows as the snapshot pill menu (M4-T9, M5-T5). */
export interface PaletteIterations {
    readonly rows: PickerRows;
    readonly viewing: Viewing;
    /** Reference time for relative timestamps, to keep the gallery deterministic. */
    readonly now: number;
    readonly onSelect: (viewing: Viewing) => void;
}

export interface CommandPaletteProps {
    readonly open: boolean;
    readonly source: PaletteDiffSource | null;
    readonly iterations?: PaletteIterations;
    readonly sourceError?: string | null;
    readonly onOpen: () => void;
    readonly onClose: () => void;
    readonly initialQuery?: string;
}

interface PaletteItem {
    readonly id: string;
    readonly group: string;
    readonly label: string;
    readonly keyHint: string | null;
    readonly consequence: string | null;
    readonly detail: DiffSearchMatch | null;
    readonly commandId: string | null;
    readonly keepOpen: boolean;
    readonly action: () => void;
}

const SUGGESTED_IDS = ['palette.goToFile', 'palette.searchDiff', 'diff.toggleMode'] as const;

type BrowseMode = 'all' | 'files' | 'iterations';

const PLACEHOLDER: Readonly<Record<BrowseMode, string>> = {
    all: 'Command, file, /search or :line',
    files: 'File…',
    iterations: 'Iteration…',
};

/** Command and client-side search palette (README §14, SPEC §2.3). */
export function CommandPalette({
    open,
    source,
    iterations,
    sourceError = null,
    onOpen,
    onClose,
    initialQuery = '',
}: CommandPaletteProps) {
    const [query, setQuery] = useState(initialQuery);
    // SPEC has no file prefix. The command switches the internal results to files only.
    const [browseMode, setBrowseMode] = useState<BrowseMode>('all');
    const [cursor, setCursor] = useState(0);
    // Command history is part of server-side PR state. The server only stores it, the display limit lives here.
    const prState = usePrStateStore();
    const paletteRecent = usePrState().paletteRecent;
    const recentIds = useMemo(
        () => [...new Set(paletteRecent)].slice(0, PALETTE_RECENT_LIMIT),
        [paletteRecent],
    );
    const inputRef = useRef<HTMLInputElement | null>(null);
    const resultsRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLElement | null>(null);
    const requestedQuery = useRef<string | null>(null);
    /** Result mode requested by a command that opens the palette itself (`f` on Route). */
    const requestedMode = useRef<BrowseMode | null>(null);
    const cursorOrigin = useRef<'keyboard' | 'mouse' | 'programmatic'>('programmatic');
    const wasOpen = useRef(false);
    const shortcuts = useShortcutList();

    useShortcut({
        id: 'palette.goToFile',
        keys: [],
        label: 'Go to file',
        scope: 'global',
        section: 'navigation',
        when: () => source !== null,
        action: () => {
            setBrowseMode('files');
            setQuery('');
            setCursor(0);
            cursorOrigin.current = 'programmatic';
        },
    });
    // Route has no file tree, so `f` opens the same file results in the palette (SPEC §5).
    useShortcut({
        id: 'palette.findFile',
        keys: ['f'],
        label: 'Find a file',
        scope: 'route',
        section: 'navigation',
        when: () => source !== null,
        action: () => {
            requestedQuery.current = '';
            requestedMode.current = 'files';
            setBrowseMode('files');
            setQuery('');
            setCursor(0);
            cursorOrigin.current = 'programmatic';
            onOpen();
        },
    });
    useShortcut({
        id: 'palette.searchDiff',
        keys: ['/'],
        label: 'Search diff contents',
        scope: 'global',
        section: 'navigation',
        action: () => {
            requestedQuery.current = '/';
            setBrowseMode('all');
            setQuery('/');
            setCursor(0);
            cursorOrigin.current = 'programmatic';
            onOpen();
        },
    });
    useShortcut({
        id: 'palette.iterations',
        keys: [],
        label: 'Iterations…',
        scope: 'global',
        section: 'navigation',
        when: () => iterations !== undefined,
        action: () => {
            setBrowseMode('iterations');
            setQuery('');
            setCursor(0);
            cursorOrigin.current = 'programmatic';
        },
    });
    useShortcut({
        id: 'diff.toggleMode',
        keys: ['d'],
        label: 'Toggle diff mode',
        scope: 'global',
        section: 'reading',
        when: () => source !== null,
        action: () => {
            source?.toggleDiffMode();
        },
    });

    useLayoutEffect(() => {
        if (open && !wasOpen.current) {
            triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const nextQuery = requestedQuery.current ?? initialQuery;
            requestedQuery.current = null;
            setBrowseMode(requestedMode.current ?? 'all');
            requestedMode.current = null;
            setQuery(nextQuery);
            setCursor(0);
            cursorOrigin.current = 'programmatic';
            inputRef.current?.focus();
            requestAnimationFrame(() => {
                inputRef.current?.select();
            });
        }
        if (!open) {
            // The mode request lasts only until opening. A command run from an already open palette
            // does not consume it, so without resetting, the next ⌘K would open in the wrong mode.
            requestedQuery.current = null;
            requestedMode.current = null;
        }
        wasOpen.current = open;
    }, [initialQuery, open]);

    const parsed = useMemo(() => parsePaletteQuery(query), [query]);
    // Contextual `when()` checks run on every render: row focus changes without registry events.
    const availableCommands = shortcuts.filter((shortcut) => shortcut.when?.() !== false);
    const commandById = new Map(availableCommands.map((shortcut) => [shortcut.id, shortcut]));
    const diffSearch = useMemo(
        () =>
            parsed.kind === 'diff' && source !== null && parsed.text !== ''
                ? searchDiff(source.files, parsed.text, 50, source.searchModels())
                : null,
        [parsed, source],
    );
    const resolvedLineSide = useMemo(() => {
        if (parsed.kind !== 'line' || parsed.line === null || source?.activeFileId == null) {
            return null;
        }
        const file = source.files.find((candidate) => candidate.fileId === source.activeFileId);
        return file === undefined ? null : lineSideInDiff(file, parsed.line);
    }, [parsed, source]);

    const result = (() => {
        const itemFromCommand = (shortcut: Shortcut, group: string): PaletteItem => ({
            id: `command:${shortcut.id}`,
            group,
            label: shortcut.label,
            keyHint: formatKeys(shortcut.keys),
            consequence: shortcut.consequence ?? null,
            detail: null,
            commandId: shortcut.id,
            keepOpen:
                shortcut.id === 'palette.goToFile' ||
                shortcut.id === 'palette.findFile' ||
                shortcut.id === 'palette.searchDiff' ||
                shortcut.id === 'palette.iterations',
            action: shortcut.action,
        });
        const itemFromFile = (file: PaletteDiffSource['files'][number]): PaletteItem => ({
            id: `file:${file.fileId}`,
            group: 'Files',
            label: file.path,
            keyHint: null,
            consequence: null,
            detail: null,
            commandId: null,
            keepOpen: false,
            action: () => {
                source?.goToFile(file.fileId);
            },
        });

        if (parsed.kind === 'line') {
            if (source?.activeFileId == null) {
                return { items: [] as PaletteItem[], notice: 'Open a file first', truncated: false };
            }
            if (parsed.line === null) {
                return { items: [] as PaletteItem[], notice: 'Enter a line number after the colon', truncated: false };
            }
            const file = source.files.find((candidate) => candidate.fileId === source.activeFileId);
            if (file === undefined) {
                return { items: [] as PaletteItem[], notice: 'Open a file first', truncated: false };
            }
            const side = resolvedLineSide;
            if (side === null) {
                return {
                    items: [] as PaletteItem[],
                    notice: `Line ${String(parsed.line)} does not exist in ${file.path}`,
                    truncated: false,
                };
            }
            const line = parsed.line;
            return {
                items: [
                    {
                        id: `line:${file.fileId}:${side}:${String(line)}`,
                        group: 'Navigation',
                        label: `Go to line ${String(line)}`,
                        keyHint: null,
                        consequence: file.path,
                        detail: null,
                        commandId: null,
                        keepOpen: false,
                        action: () => {
                            source.goToLine(file.fileId, side, line);
                        },
                    },
                ],
                notice: null,
                truncated: false,
            };
        }

        if (parsed.kind === 'diff') {
            if (source === null) {
                return {
                    items: [] as PaletteItem[],
                    notice: sourceError === null ? 'The diff is still loading' : `Could not load the diff: ${sourceError}`,
                    truncated: false,
                };
            }
            if (parsed.text === '') {
                return { items: [] as PaletteItem[], notice: 'Enter text after /', truncated: false };
            }
            const found = diffSearch ?? { matches: [], truncated: false };
            return {
                items: found.matches.map((match, index) => ({
                    id: `search:${match.fileId}:${match.side}:${String(match.line)}:${String(index)}`,
                    group: 'Search',
                    label: `${match.path}:${String(match.line)}`,
                    keyHint: null,
                    consequence: null,
                    detail: match,
                    commandId: null,
                    keepOpen: false,
                    action: () => {
                        source.goToLine(match.fileId, match.side, match.line);
                    },
                })),
                notice: found.matches.length === 0 ? `No results for "${parsed.text}"` : null,
                truncated: found.truncated,
            };
        }

        if (browseMode === 'iterations') {
            if (iterations === undefined) {
                return { items: [] as PaletteItem[], notice: 'This PR has no iterations', truncated: false };
            }
            const items = menuSections(iterations.rows).flatMap((section) =>
                section.rows
                    .map((row): PaletteItem => {
                        const text = rowText(row, iterations.now);
                        return {
                            // Keyed by kind+id, as in the picker itself: one commit can have
                            // several snapshots after route regeneration.
                            id: `iteration:${row.kind}:${row.id}`,
                            group: section.title,
                            label: text,
                            keyHint: null,
                            consequence: isRowSelected(row, iterations.viewing) ? 'currently viewing' : rowTitle(row),
                            detail: null,
                            commandId: null,
                            keepOpen: false,
                            action: () => {
                                iterations.onSelect(row.viewing);
                            },
                        };
                    })
                    .filter((item) => parsed.text === '' || fuzzyMatch(item.label, parsed.text)),
            );
            return {
                items,
                notice: items.length === 0 ? `Nothing matches "${parsed.text}"` : null,
                truncated: false,
            };
        }

        if (browseMode === 'files') {
            const matchingFiles =
                source?.files.filter((file) => parsed.text === '' || fuzzyMatch(file.path, parsed.text)) ?? [];
            const files = matchingFiles.slice(0, 50).map(itemFromFile);
            return {
                items: files,
                notice: files.length === 0 ? `No results for "${parsed.text}"` : null,
                truncated: matchingFiles.length > files.length,
            };
        }

        if (parsed.text === '') {
            const recent = recentIds
                .map((id) => commandById.get(id))
                .filter((shortcut): shortcut is Shortcut => shortcut !== undefined)
                .map((shortcut) => itemFromCommand(shortcut, 'Recent'));
            const suggestedIds = source === null ? [...SUGGESTED_IDS, 'view.diff'] : SUGGESTED_IDS;
            const suggested = suggestedIds
                .map((id) => commandById.get(id))
                .filter((shortcut): shortcut is Shortcut => shortcut !== undefined)
                .filter((shortcut) => !recentIds.includes(shortcut.id))
                .map((shortcut) => itemFromCommand(shortcut, 'Suggestions'));
            return { items: [...recent, ...suggested], notice: null, truncated: false };
        }

        const files =
            source?.files
                .filter((file) => fuzzyMatch(file.path, parsed.text))
                .slice(0, 50)
                .map(itemFromFile) ?? [];
        const commands = availableCommands
            .filter((shortcut) => fuzzyMatch(shortcut.label, parsed.text))
            .map((shortcut) => itemFromCommand(shortcut, 'Commands'));
        const items = [...files, ...commands];
        if (items.length > 0) {
            return { items, notice: null, truncated: false };
        }
        return {
            items: [
                {
                    id: 'search-fallback',
                    group: 'Search',
                    label: 'Search diff contents',
                    keyHint: null,
                    consequence: null,
                    detail: null,
                    commandId: null,
                    keepOpen: true,
                    action: () => {
                        setBrowseMode('all');
                        setQuery(`/${parsed.text}`);
                    },
                },
            ],
            notice: `No results for "${parsed.text}"`,
            truncated: false,
        };
    })();

    const items = result.items;
    const hasRecentItems = items.some((item) => item.group === 'Recent');
    const activeCursor = items.length === 0 ? -1 : Math.min(Math.max(cursor, 0), items.length - 1);
    const announcement =
        result.notice?.startsWith('No results') === true
            ? 'No results'
            : result.notice ?? `${String(items.length)} ${plural(items.length, 'result', 'results', 'results')}`;

    useLayoutEffect(() => {
        if (!open || activeCursor < 0 || cursorOrigin.current === 'mouse') {
            return;
        }
        scrollPaletteCursor(resultsRef.current, activeCursor);
    }, [activeCursor, open]);

    const close = useCallback((restoreFocus: boolean): void => {
        onClose();
        if (restoreFocus) {
            requestAnimationFrame(() => {
                triggerRef.current?.focus();
            });
        }
    }, [onClose]);
    // The palette is the top layer in the Esc order: it closes before the selection beneath it.
    useEscapeLayer('palette', () => {
        close(true);
    }, open);

    if (!open) {
        return null;
    }

    const execute = (item: PaletteItem): void => {
        if (item.commandId !== null) {
            prState.update({ paletteRecent: addRecentCommand(recentIds, item.commandId) });
        }
        if (!item.keepOpen) {
            close(false);
        }
        item.action();
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        // Let Esc through: the registry's close order handles it, rather than the palette.
        if (event.key !== 'Escape') {
            event.stopPropagation();
        }
        if (event.key === 'Tab') {
            event.preventDefault();
            inputRef.current?.focus();
            return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            cursorOrigin.current = 'keyboard';
            setCursor((current) => movePaletteCursor(current, items.length, event.key === 'ArrowDown' ? 1 : -1));
            return;
        }
        if (event.key === 'Enter' && activeCursor >= 0) {
            const item = items[activeCursor];
            if (item !== undefined) {
                event.preventDefault();
                execute(item);
            }
        }
    };
    const groups = groupItems(items);

    return (
        <div
            className="command-palette__overlay"
            onKeyDown={onKeyDown}
            onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
                if (event.target === event.currentTarget) {
                    close(true);
                }
            }}
        >
            <section
                className="command-palette"
                role="dialog"
                aria-modal="true"
                aria-labelledby="command-palette-title"
            >
                <h2 id="command-palette-title" className="visually-hidden">
                    Command palette
                </h2>
                <div className="command-palette__query-row">
                    <span className="command-palette__search-icon" aria-hidden="true">
                        <Icon name="search" size={14} />
                    </span>
                    <input
                        ref={inputRef}
                        className="command-palette__query"
                        value={query}
                        placeholder={PLACEHOLDER[browseMode]}
                        aria-controls="command-palette-listbox"
                        aria-activedescendant={
                            activeCursor < 0 ? undefined : `command-palette-option-${String(activeCursor)}`
                        }
                        onChange={(event) => {
                            setQuery(event.currentTarget.value);
                            setCursor(0);
                            cursorOrigin.current = 'programmatic';
                        }}
                    />
                    <kbd className="command-palette__escape">esc</kbd>
                </div>

                <div className="visually-hidden" role="status" aria-live="polite">
                    {announcement}
                </div>
                <div ref={resultsRef} className="command-palette__results">
                    {parsed.kind === 'browse' && parsed.text === '' && browseMode === 'all' && !hasRecentItems ? (
                        <div className="command-palette__group" aria-label="Recent">
                            <div className="command-palette__group-label">Recent</div>
                            <div className="command-palette__empty-recent">No recent commands yet</div>
                        </div>
                    ) : null}
                    {result.notice === null ? null : <div className="command-palette__notice">{result.notice}</div>}
                    <div id="command-palette-listbox" role="listbox" aria-label="Palette results">
                        {groups.map((group) => (
                            <div
                                className="command-palette__group"
                                role="group"
                                aria-label={group.label}
                                key={group.label}
                            >
                                <div className="command-palette__group-label">{group.label}</div>
                                {group.items.map(({ item, index }) => (
                                    <button
                                        type="button"
                                        role="option"
                                        id={`command-palette-option-${String(index)}`}
                                        data-index={index}
                                        aria-selected={index === activeCursor}
                                        tabIndex={-1}
                                        className={`command-palette__item${index === activeCursor ? ' is-active' : ''}`}
                                        key={item.id}
                                        onMouseMove={() => {
                                            if (index !== activeCursor) {
                                                cursorOrigin.current = 'mouse';
                                                setCursor(index);
                                            }
                                        }}
                                        onMouseDown={(event) => {
                                            event.preventDefault();
                                        }}
                                        onClick={() => {
                                            execute(item);
                                        }}
                                    >
                                        <span className="command-palette__item-main">
                                            <span className="command-palette__item-label">{item.label}</span>
                                            {item.detail === null ? null : <SearchSnippet match={item.detail} />}
                                            {item.consequence === null ? null : (
                                                <span className="command-palette__consequence">{item.consequence}</span>
                                            )}
                                        </span>
                                        {item.keyHint === null ? null : (
                                            <kbd className="command-palette__key-hint">{item.keyHint}</kbd>
                                        )}
                                    </button>
                                ))}
                            </div>
                        ))}
                    </div>
                    {result.truncated ? (
                        <div className="command-palette__limit">Showing the first 50 matches</div>
                    ) : null}
                </div>
            </section>
        </div>
    );
}

function SearchSnippet({ match }: { match: DiffSearchMatch }) {
    return (
        <span className="command-palette__snippet">
            {match.text.slice(0, match.matchStart)}
            <mark>{match.text.slice(match.matchStart, match.matchEnd)}</mark>
            {match.text.slice(match.matchEnd)}
        </span>
    );
}

function groupItems(items: readonly PaletteItem[]): readonly {
    readonly label: string;
    readonly items: readonly { readonly item: PaletteItem; readonly index: number }[];
}[] {
    const groups = new Map<string, { item: PaletteItem; index: number }[]>();
    items.forEach((item, index) => {
        const group = groups.get(item.group) ?? [];
        group.push({ item, index });
        groups.set(item.group, group);
    });
    return [...groups].map(([label, grouped]) => ({ label, items: grouped }));
}
