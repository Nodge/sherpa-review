import type { ThreadStore } from './store.js';

interface BeforeUnloadTarget {
    readonly addEventListener: (type: 'beforeunload', listener: (event: BeforeUnloadEvent) => void) => void;
    readonly removeEventListener: (type: 'beforeunload', listener: (event: BeforeUnloadEvent) => void) => void;
}

/** Warns before leaving while the composer holds unsaved text or a write in flight. */
export function attachComposerBeforeUnload(store: ThreadStore, target: BeforeUnloadTarget = window): () => void {
    let attached = false;
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
        event.preventDefault();
        // Older browsers only show the dialog when the deprecated field is set.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        event.returnValue = '';
    };
    const sync = (): void => {
        const pending = store.getComposerGuardSnapshot().pending;
        if (pending === attached) {
            return;
        }
        attached = pending;
        if (attached) {
            target.addEventListener('beforeunload', handleBeforeUnload);
        } else {
            target.removeEventListener('beforeunload', handleBeforeUnload);
        }
    };
    const unsubscribe = store.subscribeComposerGuard(sync);
    sync();
    return () => {
        unsubscribe();
        if (attached) {
            target.removeEventListener('beforeunload', handleBeforeUnload);
        }
    };
}
