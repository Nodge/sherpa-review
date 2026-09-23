import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useT } from '../i18n/index.js';

/**
 * Deletion confirmation in the action row: a question, red "Delete", "Cancel" (§3).
 * The same view handles both deleting a thread message and discarding an entered draft
 * in the composer: the reviewer loses unpublished text in both cases.
 */
export function DeleteConfirm({
    question,
    confirmLabel,
    busy = false,
    onConfirm,
    onCancel,
}: {
    question: string;
    confirmLabel: string;
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const t = useT();
    return (
        <div className="thread__delete-confirm" onKeyDown={onEscape(onCancel)}>
            <span>{question}</span>
            <button
                type="button"
                className="ctl ctl--danger thread__delete-confirm-button"
                disabled={busy}
                autoFocus
                onClick={onConfirm}
            >
                {confirmLabel}
            </button>
            <button
                type="button"
                className="ctl ctl--ghost ctl--compact thread__keep-draft"
                disabled={busy}
                onClick={onCancel}
            >
                {t('thread.composer.cancel')}
            </button>
        </div>
    );
}

/** Esc in the confirmation row = "Cancel": the event does not bubble, and the thread stays expanded. */
function onEscape(cancel: () => void): (event: ReactKeyboardEvent<HTMLElement>) => void {
    return (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            cancel();
        }
    };
}
