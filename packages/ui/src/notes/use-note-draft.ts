import type { AgentNote } from '@sherpa/protocol';
import { useCallback, useEffect, useRef } from 'react';

import { findComposer, focusComposerInput, revealWhenReady } from '../diff-view/line-target.js';
import { useT } from '../i18n/index.js';
import type { ThreadStore } from '../threads/store.js';
import { openNewComposer } from '../threads/thread-list.tsx';
import { noteComposerAnchor, noteComposerKey, noteDraftText } from './note-draft.js';

/**
 * The note action "Turn into a comment draft" (docs/design/SPEC-elements.md §2.16) opens a regular
 * new-comment composer at the note anchor with a quote of the agent answer. The draft belongs to the reviewer and follows the usual
 * rules: no autosave, it goes to the host only when explicitly
 * saved. The hook is shared by the full diff and route, so both views behave the same way.
 */

/** Wait for the target for a limited time: the composer may never reach the DOM (virtualization, collapsed card). */
const COMPOSER_SEARCH_MS = 3000;

export interface TurnNoteIntoDraftOptions {
    readonly threadStore: ThreadStore;
    /** The range has moved into the composer, so the selection popover over it is no longer needed. */
    readonly clearSelection: () => void;
    readonly commentIssues: boolean;
}

/**
 * Opens the composer at the note anchor, scrolls it into the viewport and focuses the input. The composer
 * node appears in a later frame (React rerenders the card after the store update),
 * so the target uses the same waiting mechanism as a note opened from chat.
 */
export function useTurnNoteIntoDraft({
    threadStore,
    clearSelection,
    commentIssues,
}: TurnNoteIntoDraftOptions): (note: AgentNote) => void {
    const t = useT();
    const stopReveal = useRef<(() => void) | null>(null);
    useEffect(
        () => () => {
            stopReveal.current?.();
            stopReveal.current = null;
        },
        [],
    );

    return useCallback(
        (note: AgentNote) => {
            const key = noteComposerKey(note.anchor);
            openNewComposer(threadStore, key, noteComposerAnchor(note.anchor), commentIssues, noteDraftText(note, t));
            clearSelection();
            stopReveal.current?.();
            stopReveal.current = revealWhenReady(() => {
                const composer = findComposer(document, key);
                if (composer === null) {
                    return false;
                }
                composer.scrollIntoView({ block: 'center' });
                focusComposerInput(composer);
                return true;
            }, COMPOSER_SEARCH_MS);
        },
        [clearSelection, commentIssues, t, threadStore],
    );
}
