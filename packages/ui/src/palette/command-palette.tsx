import type { KeyboardEvent, MouseEvent } from 'react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../icons/icon.tsx';
import { useShortcut, useShortcutList } from '../shortcuts/context.tsx';
import type { Shortcut } from '../shortcuts/registry.js';
import { plural } from '../text.js';
import { movePaletteCursor, scrollPaletteCursor } from './cursor.js';
import type { PaletteDiffSource } from './diff-source.tsx';
import { lineSideInDiff, searchDiff } from './diff-search.js';
import type { DiffSearchMatch } from './diff-search.js';
import { fuzzyMatch } from './fuzzy.js';
import { parsePaletteQuery } from './query.js';
import type { RecentStorage } from './recent-storage.js';
import { addRecent, globalRecentStorage, readRecent } from './recent-storage.js';
import './command-palette.css';

export interface CommandPaletteProps {
    readonly open: boolean;
    readonly prKey: string;
    readonly source: PaletteDiffSource | null;
    readonly sourceError?: string | null;
    readonly onOpen: () => void;
    readonly onClose: () => void;
    readonly initialQuery?: string;
    readonly recentStorage?: RecentStorage | null;
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

/** Command and client-side search palette (README §14, SPEC §2.3). */
export function CommandPalette({
    open,
    prKey,
    source,
    sourceError = null,
    onOpen,
    onClose,
    initialQuery = '',
    recentStorage = globalRecentStorage(),
}: CommandPaletteProps) {
    const [query, setQuery] = useState(initialQuery);
    // SPEC has no file prefix. The command switches the internal results to files only.
    const [browseMode, setBrowseMode] = useState<'all' | 'files'>('all');
    const [cursor, setCursor] = useState(0);
    const [recentIds, setRecentIds] = useState(() => readRecent(recentStorage, prKey));
    const inputRef = useRef<HTMLInputElement | null>(null);
    const resultsRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLElement | null>(null);
    const requestedQuery = useRef<string | null>(null);
    const cursorOrigin = useRef<'keyboard' | 'mouse' | 'programmatic'>('programmatic');
    const wasOpen = useRef(false);
    const shortcuts = useShortcutList();

    useShortcut({
        id: 'palette.goToFile',
        keys: [],
        label: 'Go to file',
        when: () => source !== null,
        action: () => {
            setBrowseMode('files');
            setQuery('');
            setCursor(0);
            cursorOrigin.current = 'programmatic';
        },
    });
    useShortcut({
        id: 'palette.searchDiff',
        keys: ['/'],
        label: 'Search diff contents',
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
        id: 'diff.toggleMode',
        keys: ['d'],
        label: 'Toggle diff mode',
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
            setBrowseMode('all');
            setQuery(nextQuery);
            setCursor(0);
            cursorOrigin.current = 'programmatic';
            inputRef.current?.focus();
            requestAnimationFrame(() => {
                inputRef.current?.select();
            });
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
                ? searchDiff(source.files, parsed.text)
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
            keepOpen: shortcut.id === 'palette.goToFile' || shortcut.id === 'palette.searchDiff',
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

    if (!open) {
        return null;
    }

    const close = (restoreFocus: boolean): void => {
        onClose();
        if (restoreFocus) {
            requestAnimationFrame(() => {
                triggerRef.current?.focus();
            });
        }
    };
    const execute = (item: PaletteItem): void => {
        if (item.commandId !== null) {
            setRecentIds(addRecent(recentStorage, prKey, item.commandId));
        }
        if (!item.keepOpen) {
            close(false);
        }
        item.action();
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        event.stopPropagation();
        if (event.key === 'Escape') {
            event.preventDefault();
            close(true);
            return;
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
                        placeholder={browseMode === 'files' ? 'File…' : 'Command, file, /search or :line'}
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

function formatKeys(keys: readonly string[]): string | null {
    if (keys.length === 0) {
        return null;
    }
    return keys
        .map((keys) =>
            keys
                .replace('mod+', '⌘')
                .replace('shift+', '⇧')
                .replace('alt+', '⌥')
                .toUpperCase(),
        )
        .join(' / ');
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
