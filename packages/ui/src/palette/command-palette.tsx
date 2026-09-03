import type { KeyboardEvent, MouseEvent } from 'react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '../icons/icon.tsx';
import { translateKey, useT } from '../i18n/index.js';
import type { MessageKey } from '../i18n/index.js';
import { usePrState, usePrStateStore } from '../pr-state/context.tsx';
import { addRecentCommand, PALETTE_RECENT_LIMIT } from '../pr-state/pr-state-store.js';
import { useShortcut, useShortcutList } from '../shortcuts/context.tsx';
import type { Shortcut } from '../shortcuts/registry.js';
import { movePaletteCursor, scrollPaletteCursor } from './cursor.js';
import type { PaletteDiffSource } from './diff-source.tsx';
import { lineSideInDiff, searchDiff } from './diff-search.js';
import type { DiffSearchMatch } from './diff-search.js';
import { fuzzyMatch } from './fuzzy.js';
import { parsePaletteQuery } from './query.js';
import './command-palette.css';

export interface CommandPaletteProps {
    readonly open: boolean;
    readonly source: PaletteDiffSource | null;
    readonly sourceError?: string | null;
    readonly onOpen: () => void;
    readonly onClose: () => void;
    readonly initialQuery?: string;
    /**
     * Reply from a command that left the palette open (`keepOpen`), such as "Check for
     * updates". Replaces the usual hint until the query changes or the palette closes.
     */
    readonly status?: string | null;
    /** The status line is no longer relevant: the query changed or the palette closed. */
    readonly onStatusHandled?: () => void;
}

interface PaletteItem {
    readonly id: string;
    readonly group: MessageKey;
    readonly label: string;
    readonly keyHint: string | null;
    readonly consequence: string | null;
    readonly detail: DiffSearchMatch | null;
    readonly commandId: string | null;
    readonly keepOpen: boolean;
    readonly action: () => void;
}

const SUGGESTED_IDS = ['palette.goToFile', 'palette.searchDiff', 'diff.toggleMode'] as const;

/** Limit on file results and search matches, also used in the truncation notice. */
const SEARCH_LIMIT = 50;

/** Command and client-side search palette (README §14, SPEC §2.3). */
export function CommandPalette({
    open,
    source,
    sourceError = null,
    onOpen,
    onClose,
    initialQuery = '',
    status = null,
    onStatusHandled,
}: CommandPaletteProps) {
    const t = useT();
    const [query, setQuery] = useState(initialQuery);
    // SPEC has no file prefix. The command switches the internal results to files only.
    const [browseMode, setBrowseMode] = useState<'all' | 'files'>('all');
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
    const cursorOrigin = useRef<'keyboard' | 'mouse' | 'programmatic'>('programmatic');
    const wasOpen = useRef(false);
    const shortcuts = useShortcutList();

    useShortcut({
        id: 'palette.goToFile',
        keys: [],
        label: 'shortcut.palette.goToFile',
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
        label: 'shortcut.palette.searchDiff',
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
        label: 'shortcut.diff.toggleMode',
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
                ? searchDiff(source.files, parsed.text, SEARCH_LIMIT, source.searchModels())
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

    const result: PaletteResult = (() => {
        const itemFromCommand = (shortcut: Shortcut, group: MessageKey): PaletteItem => ({
            id: `command:${shortcut.id}`,
            group,
            label: translateKey(t, shortcut.label, shortcut.labelArg),
            keyHint: formatKeys(shortcut.keys),
            consequence:
                shortcut.consequence === undefined
                    ? null
                    : translateKey(t, shortcut.consequence, shortcut.consequenceArg),
            detail: null,
            commandId: shortcut.id,
            keepOpen:
                shortcut.keepOpen ?? (shortcut.id === 'palette.goToFile' || shortcut.id === 'palette.searchDiff'),
            action: shortcut.action,
        });
        const itemFromFile = (file: PaletteDiffSource['files'][number]): PaletteItem => ({
            id: `file:${file.fileId}`,
            group: 'palette.group.files',
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
                return emptyResult(t('palette.notice.openFile'));
            }
            if (parsed.line === null) {
                return emptyResult(t('palette.notice.lineNumber'));
            }
            const file = source.files.find((candidate) => candidate.fileId === source.activeFileId);
            if (file === undefined) {
                return emptyResult(t('palette.notice.openFile'));
            }
            const side = resolvedLineSide;
            if (side === null) {
                return emptyResult(t('palette.notice.lineMissing', parsed.line, file.path));
            }
            const line = parsed.line;
            return {
                items: [
                    {
                        id: `line:${file.fileId}:${side}:${String(line)}`,
                        group: 'palette.group.jump',
                        label: t('palette.goToLine', line),
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
                nothingFound: false,
                truncated: false,
            };
        }

        if (parsed.kind === 'diff') {
            if (source === null) {
                return emptyResult(
                    sourceError === null
                        ? t('palette.notice.diffLoading')
                        : t('palette.notice.diffFailed', sourceError),
                );
            }
            if (parsed.text === '') {
                return emptyResult(t('palette.notice.searchText'));
            }
            const found = diffSearch ?? { matches: [], truncated: false };
            return {
                items: found.matches.map((match, index) => ({
                    id: `search:${match.fileId}:${match.side}:${String(match.line)}:${String(index)}`,
                    group: 'palette.group.search' as const,
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
                notice: found.matches.length === 0 ? t('palette.notice.nothingFor', parsed.text) : null,
                nothingFound: found.matches.length === 0,
                truncated: found.truncated,
            };
        }

        if (browseMode === 'files') {
            const matchingFiles =
                source?.files.filter((file) => parsed.text === '' || fuzzyMatch(file.path, parsed.text)) ?? [];
            const files = matchingFiles.slice(0, SEARCH_LIMIT).map(itemFromFile);
            return {
                items: files,
                notice: files.length === 0 ? t('palette.notice.nothingFor', parsed.text) : null,
                nothingFound: files.length === 0,
                truncated: matchingFiles.length > files.length,
            };
        }

        if (parsed.text === '') {
            const recent = recentIds
                .map((id) => commandById.get(id))
                .filter((shortcut): shortcut is Shortcut => shortcut !== undefined)
                .map((shortcut) => itemFromCommand(shortcut, 'palette.group.recent'));
            const suggestedIds = source === null ? [...SUGGESTED_IDS, 'view.diff'] : SUGGESTED_IDS;
            const suggested = suggestedIds
                .map((id) => commandById.get(id))
                .filter((shortcut): shortcut is Shortcut => shortcut !== undefined)
                .filter((shortcut) => !recentIds.includes(shortcut.id))
                .map((shortcut) => itemFromCommand(shortcut, 'palette.group.suggested'));
            return { items: [...recent, ...suggested], notice: null, nothingFound: false, truncated: false };
        }

        const files =
            source?.files
                .filter((file) => fuzzyMatch(file.path, parsed.text))
                .slice(0, SEARCH_LIMIT)
                .map(itemFromFile) ?? [];
        // Search the translated label: the registry stores a key, but the reviewer types in their language.
        const commands = availableCommands
            .map((shortcut) => ({ shortcut, label: translateKey(t, shortcut.label, shortcut.labelArg) }))
            .filter(({ label }) => fuzzyMatch(label, parsed.text))
            // The command's own group ("Sherpa") applies in the full results. In recent commands and suggestions,
            // the group describes where the row came from, rather than which section it belongs to.
            .map(({ shortcut }) => itemFromCommand(shortcut, shortcut.group ?? 'palette.group.commands'));
        const items = [...files, ...commands];
        if (items.length > 0) {
            return { items, notice: null, nothingFound: false, truncated: false };
        }
        return {
            items: [
                {
                    id: 'search-fallback',
                    group: 'palette.group.search' as const,
                    label: t('shortcut.palette.searchDiff'),
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
            notice: t('palette.notice.nothingFor', parsed.text),
            nothingFound: true,
            truncated: false,
        };
    })();

    const items = result.items;
    const hasRecentItems = items.some((item) => item.group === 'palette.group.recent');
    const activeCursor = items.length === 0 ? -1 : Math.min(Math.max(cursor, 0), items.length - 1);
    // The command response takes precedence over the usual hint: it's why the palette stayed open.
    const notice = status ?? result.notice;
    const announcement =
        status ??
        (result.nothingFound ? t('palette.notice.nothing') : (result.notice ?? t('palette.results.count', items.length)));

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
        onStatusHandled?.();
        onClose();
        if (restoreFocus) {
            requestAnimationFrame(() => {
                triggerRef.current?.focus();
            });
        }
    };
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
                    {t('palette.title')}
                </h2>
                <div className="command-palette__query-row">
                    <span className="command-palette__search-icon" aria-hidden="true">
                        <Icon name="search" size={14} />
                    </span>
                    <input
                        ref={inputRef}
                        className="command-palette__query"
                        value={query}
                        placeholder={browseMode === 'files' ? t('palette.placeholder.files') : t('palette.placeholder')}
                        aria-controls="command-palette-listbox"
                        aria-activedescendant={
                            activeCursor < 0 ? undefined : `command-palette-option-${String(activeCursor)}`
                        }
                        onChange={(event) => {
                            onStatusHandled?.();
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
                        <div className="command-palette__group" aria-label={t('palette.group.recent')}>
                            <div className="command-palette__group-label">{t('palette.group.recent')}</div>
                            <div className="command-palette__empty-recent">{t('palette.recent.empty')}</div>
                        </div>
                    ) : null}
                    {notice === null ? null : <div className="command-palette__notice">{notice}</div>}
                    <div id="command-palette-listbox" role="listbox" aria-label={t('palette.results')}>
                        {groups.map((group) => (
                            <div
                                className="command-palette__group"
                                role="group"
                                aria-label={translateKey(t, group.key)}
                                key={group.key}
                            >
                                <div className="command-palette__group-label">{translateKey(t, group.key)}</div>
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
                        <div className="command-palette__limit">{t('palette.truncated', SEARCH_LIMIT)}</div>
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
    readonly key: MessageKey;
    readonly items: readonly { readonly item: PaletteItem; readonly index: number }[];
}[] {
    const groups = new Map<MessageKey, { item: PaletteItem; index: number }[]>();
    items.forEach((item, index) => {
        const group = groups.get(item.group) ?? [];
        group.push({ item, index });
        groups.set(item.group, group);
    });
    return [...groups].map(([key, grouped]) => ({ key, items: grouped }));
}

/** Results with no rows: a shared result shape keeps the hint consistent with the flag. */
function emptyResult(notice: string): PaletteResult {
    return { items: [], notice, nothingFound: false, truncated: false };
}

interface PaletteResult {
    readonly items: readonly PaletteItem[];
    readonly notice: string | null;
    /** "Nothing found" hint: the live region uses a shorter version without the query. */
    readonly nothingFound: boolean;
    readonly truncated: boolean;
}
