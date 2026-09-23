import { useSyncExternalStore } from 'react';

import type { DiffViewStore } from '../diff-view/store.js';
import type { FileFilter } from '../filters/lens-filters.js';
import { useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { FilterSelect } from './filter-select.tsx';
import './toolbar-controls.css';

/** Shared right-hand controls of the route and full diff toolbars in docs/design/README.md §1 order. */
export function ToolbarRightCluster({
    store,
    filters,
    filter,
    onFilter,
    authorLens = null,
}: {
    readonly store: DiffViewStore;
    readonly filters: readonly FileFilter[];
    readonly filter: FileFilter;
    readonly onFilter: (id: string) => void;
    /** Author lens from the discussion card. `null` means no lens and no chip. */
    readonly authorLens?: AuthorLens | null;
}) {
    return (
        <div className="toolbar-right-cluster">
            <DiffModeToggle store={store} />
            <FilterSelect filters={filters} active={filter} onSelect={onFilter} />
            {authorLens === null ? null : <AuthorLensChip lens={authorLens} />}
        </div>
    );
}

/** Threads by one participant: the discussion card sets the lens, this chip clears it. */
export interface AuthorLens {
    readonly name: string;
    readonly onClear: () => void;
}

function AuthorLensChip({ lens }: { lens: AuthorLens }) {
    const t = useT();
    return (
        <button
            type="button"
            className="ctl ctl--chip thread-chip thread-chip--author is-on"
            title={t('overview.discussion.lens.clear', lens.name)}
            onClick={lens.onClear}
        >
            {t('overview.discussion.lens.chip', lens.name)}
            <Icon name="cross" size={9} />
        </button>
    );
}

/**
 * Diff mode toggle is "deliberately quiet" (docs/design/README.md §1), global across all views
 * (docs/design/SPEC-elements.md §2.6).
 */
export function DiffModeToggle({ store }: { store: DiffViewStore }) {
    const t = useT();
    const { diffMode, splitAvailable, effectiveMode } = useSyncExternalStore(
        store.subscribe,
        store.getSnapshot,
        store.getSnapshot,
    );

    // Below 1100px there is no choice (docs/design/SPEC-elements.md §2.6), and the label always names the mode
    // currently rendering the diff, not the user's deferred selection.
    return (
        <button
            type="button"
            className="ctl ctl--quiet diff-mode-toggle"
            disabled={!splitAvailable}
            title={splitAvailable ? undefined : t('toolbar.splitUnavailable')}
            onClick={() => {
                store.setDiffMode(diffMode === 'unified' ? 'split' : 'unified');
            }}
        >
            <Icon name="swap" size={14} />
            {effectiveMode === 'unified' ? t('toolbar.mode.unified') : t('toolbar.mode.split')}
        </button>
    );
}
