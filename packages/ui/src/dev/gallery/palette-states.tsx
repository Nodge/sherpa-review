import { fixtureData } from '@sherpa/fixtures';
import type { ReactNode } from 'react';
import { useMemo, useSyncExternalStore } from 'react';

import { CommandPalette } from '../../palette/command-palette.tsx';
import { PaletteDiffSourceProvider, usePaletteDiffSource } from '../../palette/diff-source.tsx';
import type { RecentStorage } from '../../palette/recent-storage.js';
import { writeRecent } from '../../palette/recent-storage.js';
import { createSessionStore } from '../../session/session-store.js';
import { ShortcutsProvider } from '../../shortcuts/context.tsx';
import { createShortcutRegistry } from '../../shortcuts/registry.js';

export interface PaletteGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

const DATA = fixtureData('medium');

export const PALETTE_STATES: readonly PaletteGalleryState[] = [
    {
        id: 'palette-fuzzy',
        title: 'fuzzy search: files and commands',
        // key remounts the palette when switching states. query is its internal state,
        // so without a remount the previous query would survive the switch.
        render: () => <PaletteState key="palette-fuzzy" query="hand" />,
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
];

function PaletteState({ query, recent = false }: { query: string; recent?: boolean }) {
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
            label: 'Open full diff',
            action: () => undefined,
        });
        created.register({
            id: 'gallery.handlers',
            keys: ['g'],
            label: 'Open handlers.ts',
            action: () => undefined,
        });
        created.register({
            id: 'gallery.copyLink',
            keys: [],
            label: 'Copy review link',
            action: () => undefined,
        });
        return created;
    }, []);
    const storage = useMemo(() => {
        const created = memoryStorage();
        if (recent) {
            writeRecent(created, 'fixture-medium', ['gallery.copyLink']);
        }
        return created;
    }, [recent]);
    const source = useMemo(
        () => ({
            files: DATA.diff.files,
            activeFileId: DATA.diff.files[0]?.fileId ?? null,
            goToFile: () => undefined,
            goToLine: () => undefined,
            toggleDiffMode: () => undefined,
        }),
        [],
    );

    return (
        <ShortcutsProvider registry={registry}>
            <PaletteDiffSourceProvider value={source}>
                <PaletteFromContext
                    open={paletteOpen}
                    query={query}
                    storage={storage}
                    onClose={() => {
                        session.setPaletteOpen(false);
                    }}
                />
            </PaletteDiffSourceProvider>
        </ShortcutsProvider>
    );
}

function PaletteFromContext({
    open,
    query,
    storage,
    onClose,
}: {
    open: boolean;
    query: string;
    storage: RecentStorage;
    onClose: () => void;
}) {
    const source = usePaletteDiffSource();
    return (
        <CommandPalette
            open={open}
            prKey="fixture-medium"
            source={source}
            initialQuery={query}
            recentStorage={storage}
            onOpen={() => undefined}
            onClose={onClose}
        />
    );
}

function memoryStorage(): RecentStorage {
    const data = new Map<string, string>();
    return {
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => {
            data.set(key, value);
        },
    };
}
