import type { Comment, DraftBufferEntry, Thread } from '@sherpa/protocol';

import { closeComposersByKey } from './composer.js';
import { draftEditComposerKey } from './draft-editor.tsx';
import type { ComposerSnapshot, ThreadStore } from './store.js';
import { PR_COMPOSER_KEY } from './thread-list.tsx';

/**
 * Restoring the draft buffer into composers (M5-T15). The server remembers text the host has not
 * accepted yet. After a tab reload, it must appear in a composer on the same line.
 *
 * Builds the key exactly as a live composer does, or the restored composer and a new composer
 * would become two separate windows on the same line.
 */

/** Composer key for a buffer record. `null` means no composer location matches the record. */
export function composerKeyOfBufferEntry(entry: DraftBufferEntry): string | null {
    if (entry.commentId !== null) {
        return draftEditComposerKey(entry.commentId);
    }
    const { parentId, anchor } = entry.draft;
    if (parentId !== null) {
        // The reply key uses its thread. A reply belongs to the root comment it is attached to.
        return `reply:${parentId}`;
    }
    if (anchor === null) {
        return PR_COMPOSER_KEY;
    }
    const position = anchor.position;
    return position === null
        ? PR_COMPOSER_KEY
        : `new:${anchor.fileId}:${position.side}:${String(position.line)}`;
}

/**
 * Composer for a buffered entry: text, anchor and the "save when the connection returns" status.
 *
 * An edit (`commentId !== null`) is restored only with its comment, which supplies
 * the original text. Without it, cancelling the edit would mean deleting the draft on the host.
 */
export function composerOfBufferEntry(
    entry: DraftBufferEntry,
    threads: readonly Thread[],
): ComposerSnapshot | null {
    const key = composerKeyOfBufferEntry(entry);
    if (key === null) {
        return null;
    }
    const { draft } = entry;
    const edited = entry.commentId === null ? null : locate(threads, entry.commentId);
    if (entry.commentId !== null && edited === null) {
        return null;
    }
    // Issue status lives on the thread root, just as it does in a normal draft edit.
    const issue =
        draft.issue ??
        (edited !== null && edited.comment.id === edited.thread.root.id ? (edited.comment.issue ?? undefined) : undefined);
    return {
        key,
        threadId: edited?.thread.id ?? draft.parentId,
        parentId: draft.parentId,
        // The entry stores the full selection range: the composer key only knows the first line.
        anchor: draft.anchor,
        ...(issue === undefined ? {} : { issue }),
        text: draft.body,
        ...(edited === null ? {} : { originalText: edited.comment.body }),
        commentId: entry.commentId,
        status: 'buffered',
        clientKey: entry.id,
        bufferEntry: entry,
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: edited?.thread.resolved ?? false,
    };
}

/**
 * Opens composers for buffered entries that are not on screen yet. If a composer with the same
 * `clientKey` is already open, leave it alone: the reviewer is typing there right now.
 */
export function restoreBufferedComposers(
    store: ThreadStore,
    entries: readonly DraftBufferEntry[],
    threads: readonly Thread[] = store.getSnapshot().threads,
): string[] {
    const opened: string[] = [];
    for (const entry of entries) {
        const composer = composerOfBufferEntry(entry, threads);
        if (composer === null) {
            continue;
        }
        const existing = store.getComposer(composer.key);
        if (existing !== null && existing.clientKey === entry.id) {
            // The same composer: update only the buffer entry, keeping the entered text.
            store.updateComposer(composer.key, { bufferEntry: entry });
            continue;
        }
        if (existing !== null) {
            continue;
        }
        store.openComposer(composer);
        opened.push(composer.key);
    }
    return opened;
}

/**
 * Composers no longer in the buffer: the server delivered their entries, and the drafts are now visible
 * as thread cards. The composer keeps any text the reviewer changed after the failure, since
 * that work is missing from the delivered entry.
 */
export function staleBufferedComposers(
    store: ThreadStore,
    entries: readonly DraftBufferEntry[],
): { readonly close: readonly string[]; readonly release: readonly string[] } {
    const known = new Set(entries.map((entry) => entry.id));
    const close: string[] = [];
    const release: string[] = [];
    for (const composer of store.listComposers()) {
        if (composer.status !== 'buffered' || (composer.clientKey !== undefined && known.has(composer.clientKey))) {
            continue;
        }
        (composer.text === composer.bufferEntry?.draft.body ? close : release).push(composer.key);
    }
    return { close, release };
}

/** Reconciles open composers with the buffer: opens missing ones and closes delivered ones. */
export function syncBufferedComposers(
    store: ThreadStore,
    entries: readonly DraftBufferEntry[],
    threads: readonly Thread[] = store.getSnapshot().threads,
): void {
    const stale = staleBufferedComposers(store, entries);
    closeComposersByKey(store, stale.close);
    for (const key of stale.release) {
        // `clientKey` stays: the entry was delivered, and the server turns a save with the same key
        // into an edit to the created draft, without a second draft with almost the same text.
        store.updateComposer(key, { status: 'idle', bufferEntry: null });
    }
    restoreBufferedComposers(store, entries, threads);
}

/** Comment and its thread by id. `null` means it is missing from the snapshot. */
function locate(
    threads: readonly Thread[],
    commentId: string,
): { readonly thread: Thread; readonly comment: Comment } | null {
    const visit = (comment: Comment): Comment | null => {
        if (comment.id === commentId) {
            return comment;
        }
        for (const reply of comment.replies) {
            const found = visit(reply);
            if (found !== null) {
                return found;
            }
        }
        return null;
    };
    for (const thread of threads) {
        const comment = visit(thread.root);
        if (comment !== null) {
            return { thread, comment };
        }
    }
    return null;
}
