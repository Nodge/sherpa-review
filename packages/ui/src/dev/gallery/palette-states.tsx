import { chatFixtures, fixtureIteration } from '@sherpa/fixtures';
import type { AgentNote, ChatExchange } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo, useSyncExternalStore } from 'react';

import type { PaletteChat } from '../../palette/command-palette.tsx';
import { CommandPalette } from '../../palette/command-palette.tsx';
import { PaletteDiffSourceProvider, usePaletteDiffSource } from '../../palette/diff-source.tsx';
import { PrStateProvider } from '../../pr-state/context.tsx';
import { createUiPrStateStore } from '../../pr-state/pr-state-store.js';
import { createSessionStore } from '../../session/session-store.js';
import { ShortcutsProvider } from '../../shortcuts/context.tsx';
import { createShortcutRegistry } from '../../shortcuts/registry.js';
import { asFetched } from './fetched.js';

export interface PaletteGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

const DATA = asFetched(fixtureIteration('medium'));
const CHAT = chatFixtures('medium');
/** The gallery clock is frozen so relative times in history rows stay the same between runs. */
const NOW = Date.parse('2026-08-20T10:00:00.000Z');
const LIVE_FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const EDIT_WINDOW_FILE_ID = DATA.diff.files.find((file) => file.path.endsWith('domain/edit-window.ts'))?.fileId ?? '';

function paletteChat(exchanges: readonly ChatExchange[], notes: readonly AgentNote[], live: ReadonlySet<string>): PaletteChat {
    return { exchanges, notes, liveFileIds: live, now: NOW, onSelect: () => undefined };
}

const CHAT_HISTORY = paletteChat(CHAT?.exchanges ?? [], CHAT?.notes ?? [], LIVE_FILE_IDS);
/**
 * Different anchor states in one result list: a question about the whole PR (2), a live anchor on
 * `edit-window.ts` (7), and an exchange on `handlers.ts` (1). Its file is absent from this iteration, and the note
 * lost its anchor after a push.
 */
const CHAT_ANCHORS = paletteChat(
    (CHAT?.exchanges ?? []).filter((exchange) => [1, 2, 7].includes(exchange.id)),
    CHAT?.notesAfterPush ?? [],
    new Set([EDIT_WINDOW_FILE_ID]),
);

export const PALETTE_STATES: readonly PaletteGalleryState[] = [
    {
        id: 'palette-fuzzy',
        title: 'fuzzy search: files and commands',
        // key remounts the palette when switching states. query is its internal state,
        // so without a remount the previous query would survive the switch.
        // "re" matches both file paths and the Request changes label, which is the same in both languages.
        render: () => <PaletteState key="palette-fuzzy" query="re" />,
    },
    {
        id: 'palette-empty',
        title: 'empty query: recent items and suggestions',
        render: () => <PaletteState key="palette-empty" query="" recent />,
    },
    {
        id: 'palette-no-results',
        title: 'no results with a diff search action',
        render: () => <PaletteState key="palette-no-results" query="cachee" />,
    },
    {
        id: 'palette-diff-search',
        title: 'search through diff contents',
        render: () => <PaletteState key="palette-diff-search" query="/orderId" />,
    },
    {
        id: 'palette-chat-recent',
        title: 'chat history: recent exchanges',
        render: () => <PaletteState key="palette-chat-recent" query="@" chat={CHAT_HISTORY} />,
    },
    {
        id: 'palette-chat-query',
        title: 'chat history: matches in questions and answers',
        render: () => <PaletteState key="palette-chat-query" query="@deadline" chat={CHAT_HISTORY} />,
    },
    {
        id: 'palette-chat-anchors',
        title: 'chat history: whole-PR question, dead anchor, note with a lost anchor',
        render: () => <PaletteState key="palette-chat-anchors" query="@" chat={CHAT_ANCHORS} />,
    },
];

function PaletteState({
    query,
    recent = false,
    chat,
}: {
    query: string;
    recent?: boolean;
    chat?: PaletteChat;
}) {
    const session = useMemo(
        () => createSessionStore({ initial: { view: 'diff', filter: 'all', paletteOpen: true } }),
        [],
    );
    const paletteOpen = useSyncExternalStore(session.subscribe, session.getSnapshot).paletteOpen;
    const registry = useMemo(() => {
        const created = createShortcutRegistry();
        created.register({
            id: 'view.diff',
            keys: ['3'],
            label: 'shortcut.view.diff',
            scope: 'global',
            section: 'navigation',
            action: () => undefined,
        });
        created.register({
            id: 'review.requestChanges',
            keys: ['mod+shift+enter'],
            label: 'shortcut.review.requestChanges',
            scope: 'global',
            section: 'ship',
            action: () => undefined,
        });
        created.register({
            id: 'gallery.toggleMode',
            keys: ['d'],
            label: 'shortcut.diff.toggleMode',
            scope: 'global',
            section: 'reading',
            action: () => undefined,
        });
        return created;
    }, []);
    // The gallery keeps its own PR state in memory. There is no server here, but recent items need to appear.
    const prState = useMemo(
        () => createUiPrStateStore(recent ? { initial: { paletteRecent: ['gallery.toggleMode'] } } : {}),
        [recent],
    );
    const source = useMemo(
        () => ({
            files: DATA.diff.files,
            activeFileId: DATA.diff.files[0]?.fileId ?? null,
            searchModels: () => new Map(),
            goToFile: () => undefined,
            goToLine: () => undefined,
            toggleDiffMode: () => undefined,
        }),
        [],
    );

    return (
        <ShortcutsProvider registry={registry}>
            <PrStateProvider store={prState}>
                <PaletteDiffSourceProvider value={source}>
                    <PaletteFromContext
                        open={paletteOpen}
                        query={query}
                        chat={chat}
                        onClose={() => {
                            session.setPaletteOpen(false);
                        }}
                    />
                </PaletteDiffSourceProvider>
            </PrStateProvider>
        </ShortcutsProvider>
    );
}

function PaletteFromContext({
    open,
    query,
    chat,
    onClose,
}: {
    open: boolean;
    query: string;
    chat?: PaletteChat | undefined;
    onClose: () => void;
}) {
    const source = usePaletteDiffSource();
    return (
        <CommandPalette
            open={open}
            source={source}
            chat={chat}
            initialQuery={query}
            onOpen={() => undefined}
            onClose={onClose}
        />
    );
}
