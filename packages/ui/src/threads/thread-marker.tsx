import type { Thread } from '@sherpa/protocol';

import { Avatar } from '../components/avatar.tsx';
import { useT } from '../i18n/index.js';
import { authorName, commentFirstLine, threadCommentCount } from './model.js';
import type { ThreadStore } from './store.js';

/**
 * A collapsed thread beside code has a marker on the left card border (docs/design/SPEC-changes-2026-09-20.md §3).
 * It floats over the border. The row grid stays unchanged, with no marker column and the same code width.
 * Multiple threads on the same line share a marker with a total count.
 */
export function ThreadMarker({
    threads,
    store,
    openThreads,
}: {
    threads: readonly Thread[];
    store: ThreadStore;
    openThreads: ReadonlySet<string>;
}) {
    const t = useT();
    const first = threads[0];
    if (first === undefined) {
        return null;
    }
    // The marker is expanded only when all threads on the line are expanded. Otherwise a click would hide
    // a visible thread instead of revealing a hidden one (a line can have both regular and resolved threads).
    const open = threads.every((thread) => openThreads.has(thread.id));
    const partly = !open && threads.some((thread) => openThreads.has(thread.id));
    const resolved = threads.every((thread) => thread.resolved);
    const messages = threads.reduce((total, thread) => total + threadCommentCount(thread), 0);
    const author = first.root.author.bot ? first.root.author.login : authorName(first.root);
    const preview = commentFirstLine(first.root.body, 60);
    return (
        <button
            type="button"
            className={`ctl thread-marker${open ? ' is-open' : ''}${partly ? ' is-partly-open' : ''}${resolved ? ' thread-marker--resolved' : ''}`}
            aria-expanded={open}
            aria-label={t('thread.marker.aria', messages)}
            title={t(open ? 'thread.marker.collapse' : 'thread.marker.expand', author, preview)}
            // The marker is inside `.diff-row`, and line selection starts on row mousedown
            // (`file-card` → `onSelectStart`). Without stopping propagation, a marker click would also select the line.
            onMouseDown={(event) => {
                event.stopPropagation();
            }}
            onClick={() => {
                store.setThreadsOpen(
                    threads.map((thread) => thread.id),
                    !open,
                );
            }}
        >
            <Avatar
                className="thread-marker__avatar"
                name={first.root.author.displayName ?? first.root.author.login}
                url={first.root.author.avatarUrl}
            />
            <span className="thread-marker__count" aria-hidden="true">
                {resolved ? '✓' : messages}
            </span>
        </button>
    );
}
