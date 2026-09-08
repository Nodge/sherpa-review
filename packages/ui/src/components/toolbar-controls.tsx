import { useState, useSyncExternalStore } from 'react';

import type { DiffViewStore } from '../diff-view/store.js';
import type { FileFilter } from '../filters/lens-filters.js';
import { useT } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import type { ThreadsShow } from '../session/session-store.js';
import type { ThreadSourceCounts } from '../threads/model.js';
import { FilterSelect } from './filter-select.tsx';
import './toolbar-controls.css';

/** Shared right-hand controls of the route and full diff toolbars in docs/design/README.md §1 order. */
export function ToolbarRightCluster({
    store,
    filters,
    filter,
    onFilter,
    threadsShow,
    threadCounts,
    onThreadsShow,
    authorLens = null,
}: {
    readonly store: DiffViewStore;
    readonly filters: readonly FileFilter[];
    readonly filter: FileFilter;
    readonly onFilter: (id: string) => void;
    readonly threadsShow: ThreadsShow;
    readonly threadCounts: ThreadSourceCounts;
    readonly onThreadsShow: (show: ThreadsShow) => void;
    /** Author lens from the discussion card. `null` means no lens and no chip. */
    readonly authorLens?: AuthorLens | null;
}) {
    const t = useT();
    return (
        <div className="toolbar-right-cluster">
            <DiffModeToggle store={store} />
            <FilterSelect filters={filters} active={filter} onSelect={onFilter} />
            <span className="toolbar-right-cluster__divider" aria-hidden="true" />
            <span className="toolbar-right-cluster__label">{t('toolbar.comments')}</span>
            <CommentSources show={threadsShow} counts={threadCounts} onChange={onThreadsShow} />
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
            className="thread-chip thread-chip--author is-on"
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
            className="diff-mode-toggle"
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

/**
 * Comment sources: 3 additive chips. The last one can be disabled, but then the chips
 * are replaced with a "Comments hidden" label and undo action (docs/design/SPEC-elements.md §2.8).
 */
export function CommentSources({
    show,
    counts,
    onChange,
}: {
    show: ThreadsShow;
    counts: ThreadSourceCounts;
    onChange: (show: ThreadsShow) => void;
}) {
    const t = useT();
    const [hiddenBackup, setHiddenBackup] = useState<ThreadsShow | null>(null);

    if (!show.people && !show.bots && !show.resolved) {
        return (
            <span className="thread-chips-hidden">
                {t('toolbar.commentsHidden')}{' '}
                <button
                    type="button"
                    onClick={() => {
                        onChange(hiddenBackup ?? { people: true, bots: false, resolved: false });
                        setHiddenBackup(null);
                    }}
                >
                    {t('toolbar.undo')}
                </button>
            </span>
        );
    }

    return (
        <CommentSourceChips
            show={show}
            counts={counts}
            onChange={(next) => {
                if (!next.people && !next.bots && !next.resolved) {
                    setHiddenBackup(show);
                }
                onChange(next);
            }}
        />
    );
}

export function CommentSourceChips({
    show,
    counts,
    onChange,
}: {
    show: ThreadsShow;
    counts: ThreadSourceCounts;
    onChange: (show: ThreadsShow) => void;
}) {
    const t = useT();
    const chips = [
        { id: 'people' as const, label: t('toolbar.chip.people') },
        { id: 'bots' as const, label: t('toolbar.chip.bots') },
        { id: 'resolved' as const, label: 'Resolved' },
    ];
    return (
        <span className="thread-chips" aria-label={t('toolbar.chips.aria')}>
            {chips.map((chip) => {
                const count = counts[chip.id];
                return (
                    <button
                        key={chip.id}
                        type="button"
                        className={`thread-chip${show[chip.id] ? ' is-on' : ''}`}
                        aria-pressed={show[chip.id]}
                        disabled={count === 0}
                        title={count === 0 ? t('toolbar.chip.empty', chip.label) : undefined}
                        onClick={() => {
                            onChange({ ...show, [chip.id]: !show[chip.id] });
                        }}
                    >
                        {chip.label} {count}
                    </button>
                );
            })}
        </span>
    );
}
