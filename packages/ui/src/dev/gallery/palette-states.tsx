import { fixtureIteration } from '@sherpa/fixtures';
import type { ReactNode } from 'react';
import { useMemo, useSyncExternalStore } from 'react';

import { CommandPalette } from '../../palette/command-palette.tsx';
import { PaletteDiffSourceProvider, usePaletteDiffSource } from '../../palette/diff-source.tsx';
import { PrStateProvider } from '../../pr-state/context.tsx';
import { createUiPrStateStore } from '../../pr-state/pr-state-store.js';
import { createSessionStore } from '../../session/session-store.js';
import { ShortcutsProvider } from '../../shortcuts/context.tsx';
import { createShortcutRegistry } from '../../shortcuts/registry.js';

export interface PaletteGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

const DATA = fixtureIteration('medium');

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
            scope: 'global',
            section: 'navigation',
            action: () => undefined,
        });
        created.register({
            id: 'gallery.handlers',
            keys: ['g'],
            label: 'Open handlers.ts',
            scope: 'global',
            section: 'navigation',
            action: () => undefined,
        });
        created.register({
            id: 'gallery.copyLink',
            keys: [],
            label: 'Copy review link',
            scope: 'global',
            section: 'navigation',
            action: () => undefined,
        });
        return created;
    }, []);
    // The gallery keeps its own PR state in memory. There is no server here, but recent items need to appear.
    const prState = useMemo(
        () => createUiPrStateStore(recent ? { initial: { paletteRecent: ['gallery.copyLink'] } } : {}),
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
    onClose,
}: {
    open: boolean;
    query: string;
    onClose: () => void;
}) {
    const source = usePaletteDiffSource();
    return (
        <CommandPalette open={open} source={source} initialQuery={query} onOpen={() => undefined} onClose={onClose} />
    );
}
