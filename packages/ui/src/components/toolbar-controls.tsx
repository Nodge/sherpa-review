import { useState, useSyncExternalStore } from 'react';

import type { DiffViewStore } from '../diff-view/store.js';
import { Icon } from '../icons/icon.tsx';
import type { ThreadsShow } from '../session/session-store.js';
import type { ThreadSourceCounts } from '../threads/model.js';
import './toolbar-controls.css';

/**
 * Shared controls for full diff and route toolbars: diff mode toggle and additive
 * comment source chips. The mode is global, held in one store for all views (SPEC §2.6),
 * so there is one control too. A second implementation could diverge.
 */

/** Diff mode toggle, "deliberately quiet" (README §1) and global across views (SPEC §2.6). */
export function DiffModeToggle({ store }: { store: DiffViewStore }) {
    const { diffMode, splitAvailable, effectiveMode } = useSyncExternalStore(
        store.subscribe,
        store.getSnapshot,
        store.getSnapshot,
    );

    // Below 1100px there is no choice (SPEC §2.6), and the label always names the mode,
    // currently rendering the diff, not the user's deferred selection.
    return (
        <button
            type="button"
            className="diff-mode-toggle"
            disabled={!splitAvailable}
            title={splitAvailable ? undefined : 'not enough width for two columns'}
            onClick={() => {
                store.setDiffMode(diffMode === 'unified' ? 'split' : 'unified');
            }}
        >
            <Icon name="swap" size={14} />
            {effectiveMode === 'unified' ? 'unified' : 'side by side'}
        </button>
    );
}

/**
 * Comment sources: 3 additive chips. The last one can be disabled, but then the chips
 * are replaced with a "Comments hidden" message and undo (SPEC §2.8).
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
    const [hiddenBackup, setHiddenBackup] = useState<ThreadsShow | null>(null);

    if (!show.people && !show.bots && !show.resolved) {
        return (
            <span className="thread-chips-hidden">
                Comments hidden ·{' '}
                <button
                    type="button"
                    onClick={() => {
                        onChange(hiddenBackup ?? { people: true, bots: false, resolved: false });
                        setHiddenBackup(null);
                    }}
                >
                    undo
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

function CommentSourceChips({
    show,
    counts,
    onChange,
}: {
    show: ThreadsShow;
    counts: ThreadSourceCounts;
    onChange: (show: ThreadsShow) => void;
}) {
    const chips = [
        { id: 'people' as const, label: 'People' },
        { id: 'bots' as const, label: 'Bots' },
        { id: 'resolved' as const, label: 'Resolved' },
    ];
    return (
        <span className="thread-chips" aria-label="Comment sources">
            {chips.map((chip) => {
                const count = counts[chip.id];
                return (
                    <button
                        key={chip.id}
                        type="button"
                        className={`thread-chip${show[chip.id] ? ' is-on' : ''}`}
                        aria-pressed={show[chip.id]}
                        disabled={count === 0}
                        title={count === 0 ? `This PR has no threads in the "${chip.label}" category` : undefined}
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
