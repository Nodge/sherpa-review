import type { AgentNote, ChatExchange, ChatExchangeStatus } from '@sherpa/protocol';
import type { KeyboardEvent, MouseEvent } from 'react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { chatAnchorLabel } from '../components/chat-panel.tsx';
import { Icon } from '../icons/icon.tsx';
import { translateKey, useFormat, useLocale, useT } from '../i18n/index.js';
import type { Formatters, MessageKey, Translate } from '../i18n/index.js';
import { usePrState, usePrStateStore } from '../pr-state/context.tsx';
import { addRecentCommand, PALETTE_RECENT_LIMIT } from '../pr-state/pr-state-store.js';
import { useEscapeLayer, useShortcut, useShortcutList } from '../shortcuts/context.tsx';
import type { Shortcut } from '../shortcuts/registry.js';
import { formatKeys } from '../shortcuts/registry.js';
import { isRowSelected, menuSections, rowText, rowTitle } from '../iterations/snapshot-picker.tsx';
import type { PickerRows, Viewing } from '../iterations/viewing.js';
import { searchChat } from './chat-search.js';
import { movePaletteCursor, scrollPaletteCursor } from './cursor.js';
import type { PaletteDiffSource } from './diff-source.tsx';
import { lineSideInDiff, searchDiff } from './diff-search.js';
import type { DiffSearchMatch } from './diff-search.js';
import { fuzzyMatch } from './fuzzy.js';
import { parsePaletteQuery } from './query.js';
import './command-palette.css';

/** "Iterations…" mode: the same rows as in the snapshot pill menu. */
export interface PaletteIterations {
    readonly rows: PickerRows;
    readonly viewing: Viewing;
    /** Reference time for relative timestamps, to keep the gallery deterministic. */
    readonly now: number;
    readonly onSelect: (viewing: Viewing) => void;
}

/** `@` mode: this PR's chat history (docs/design/SPEC-elements.md §2.18), all exchanges from all iterations, filtered on the client. */
export interface PaletteChat {
    readonly exchanges: readonly ChatExchange[];
    readonly notes: readonly AgentNote[];
    /** Files in the viewed iteration, used to decide whether an anchor is alive. */
    readonly liveFileIds: ReadonlySet<string>;
    /** Reference time for relative timestamps, to keep the gallery deterministic. */
    readonly now: number;
    /** History is still loading: an empty list does not mean there is no history. */
    readonly loading?: boolean;
    readonly error?: string | null;
    readonly onSelect: (exchange: ChatExchange, anchorAlive: boolean) => void;
}

export interface CommandPaletteProps {
    readonly open: boolean;
    readonly source: PaletteDiffSource | null;
    readonly iterations?: PaletteIterations;
    readonly chat?: PaletteChat | undefined;
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

type BrowseMode = 'all' | 'files' | 'iterations';

const PLACEHOLDER: Readonly<Record<BrowseMode, MessageKey>> = {
    all: 'palette.placeholder',
    files: 'palette.placeholder.files',
    iterations: 'palette.placeholder.iterations',
};

/** Limit on file results and search matches, also used in the truncation notice. */
const SEARCH_LIMIT = 50;

/** Command and client-side search palette (docs/design/README.md §14, docs/design/SPEC-elements.md §2.3). */
export function CommandPalette({
    open,
    source,
    iterations,
    chat,
    sourceError = null,
    onOpen,
    onClose,
    initialQuery = '',
    status = null,
    onStatusHandled,
}: CommandPaletteProps) {
    const t = useT();
    const locale = useLocale();
    const format = useFormat();
    const [query, setQuery] = useState(initialQuery);
    // The spec defines no file prefix: the command switches the internal results to files only.
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
        label: 'shortcut.palette.goToFile',
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
    // Route has no file tree, so `f` opens the same file results in the palette (docs/design/SPEC-elements.md §5).
    useShortcut({
        id: 'palette.findFile',
        keys: ['f'],
        label: 'shortcut.palette.findFile',
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
        label: 'shortcut.palette.searchDiff',
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
        id: 'palette.chatHistory',
        keys: [],
        label: 'shortcut.palette.chatHistory',
        group: 'palette.group.sherpa',
        scope: 'global',
        section: 'agent',
        when: () => chat !== undefined,
        action: () => {
            requestedQuery.current = '@';
            setBrowseMode('all');
            setQuery('@');
            setCursor(0);
            cursorOrigin.current = 'programmatic';
            onOpen();
        },
    });
    useShortcut({
        id: 'palette.iterations',
        keys: [],
        label: 'shortcut.palette.iterations',
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
        label: 'shortcut.diff.toggleMode',
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
            keyHint: formatKeys(shortcut.keys, t),
            consequence:
                shortcut.consequence === undefined
                    ? null
                    : translateKey(t, shortcut.consequence, shortcut.consequenceArg),
            detail: null,
            commandId: shortcut.id,
            keepOpen:
                shortcut.keepOpen ??
                (shortcut.id === 'palette.goToFile' ||
                    shortcut.id === 'palette.findFile' ||
                    shortcut.id === 'palette.searchDiff' ||
                    shortcut.id === 'palette.chatHistory' ||
                    shortcut.id === 'palette.iterations'),
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

        if (parsed.kind === 'chat') {
            // Nothing to show. First distinguish "not loaded" from "empty", and only treat a nonempty
            // query as a search with no results. Don't offer "search the diff":
            // the query wasn't about the diff.
            const nothing = (): PaletteResult => {
                if (chat?.error != null) {
                    return emptyResult(t('palette.notice.chatFailed', chat.error));
                }
                if (chat?.loading === true) {
                    return emptyResult(t('palette.notice.chatLoading'));
                }
                if (parsed.text === '') {
                    return emptyResult(t('palette.chat.empty'));
                }
                return {
                    items: [],
                    notice: t('palette.notice.nothingFor', parsed.text),
                    nothingFound: true,
                    truncated: false,
                };
            };
            if (chat === undefined) {
                return nothing();
            }
            const found = searchChat(chat.exchanges, parsed.text, SEARCH_LIMIT);
            const items = found.exchanges.map((exchange): PaletteItem => {
                const anchorAlive = exchange.anchor !== null && chat.liveFileIds.has(exchange.anchor.fileId);
                return {
                    id: `chat:${String(exchange.id)}`,
                    group: 'palette.group.chat',
                    label: exchange.question,
                    keyHint: null,
                    consequence: chatConsequence(exchange, anchorAlive, chat, format.relativeTime, t),
                    detail: null,
                    commandId: null,
                    keepOpen: false,
                    action: () => {
                        chat.onSelect(exchange, anchorAlive);
                    },
                };
            });
            return items.length === 0
                ? nothing()
                : { items, notice: null, nothingFound: false, truncated: found.truncated };
        }

        if (browseMode === 'iterations') {
            if (iterations === undefined) {
                return {
                    items: [] as PaletteItem[],
                    notice: t('palette.notice.noIterations'),
                    nothingFound: true,
                    truncated: false,
                };
            }
            const items = menuSections(iterations.rows).flatMap((section) =>
                section.rows
                    .map((row): PaletteItem => {
                        const text = rowText(row, iterations.now, t, locale);
                        return {
                            // Keyed by kind+id, as in the picker itself: one commit can have
                            // several snapshots after route regeneration.
                            id: `iteration:${row.kind}:${row.id}`,
                            group: section.title,
                            label: text,
                            keyHint: null,
                            consequence: isRowSelected(row, iterations.viewing)
                                ? t('palette.iteration.current')
                                : rowTitle(row),
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
                notice: items.length === 0 ? t('palette.notice.nothingFor', parsed.text) : null,
                nothingFound: items.length === 0,
                truncated: false,
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

    const close = useCallback(
        (restoreFocus: boolean): void => {
            onStatusHandled?.();
            onClose();
            if (restoreFocus) {
                requestAnimationFrame(() => {
                    triggerRef.current?.focus();
                });
            }
        },
        [onClose, onStatusHandled],
    );
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
                        placeholder={t(PLACEHOLDER[browseMode])}
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

/**
 * The right side of a history row: "when · where" and labels explaining why jumping to the anchor
 * won't work as the reviewer expects.
 */
function chatConsequence(
    exchange: ChatExchange,
    anchorAlive: boolean,
    chat: PaletteChat,
    relativeTime: Formatters['relativeTime'],
    t: Translate,
): string {
    const parts = [
        relativeTime(exchange.createdAt, chat.now),
        exchange.anchor === null ? t('palette.chat.wholePr') : chatAnchorLabel(exchange.anchor),
    ];
    if (exchange.anchor !== null && !anchorAlive) {
        parts.push(t('palette.chat.anchorGone'));
    }
    if (chat.notes.some((note) => note.exchangeId === exchange.id && note.lostAnchor)) {
        parts.push(t('palette.chat.noteLost'));
    }
    const status = CHAT_STATUS_MARK[exchange.status];
    if (status !== null) {
        parts.push(t(status));
    }
    return parts.join(' · ');
}

/** Status label for an unfinished exchange. Accepted answers have none. */
const CHAT_STATUS_MARK: Readonly<Record<ChatExchangeStatus, MessageKey | null>> = {
    queued: 'palette.chat.pending',
    running: 'palette.chat.pending',
    done: null,
    failed: 'palette.chat.failed',
    cancelled: 'palette.chat.cancelled',
};

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
