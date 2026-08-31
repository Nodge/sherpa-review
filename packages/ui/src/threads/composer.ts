import type { Comment, CommentDraft } from '@sherpa/protocol';

import type { ThreadStore } from './store.js';

export interface ComposerTransport {
    readonly save: (draft: CommentDraft) => Promise<Comment>;
    readonly update: (commentId: string, body: string) => Promise<void>;
    readonly delete: (commentId: string) => Promise<void>;
}

export interface ComposerController {
    readonly input: (text: string) => void;
    readonly saveNow: (close?: boolean) => Promise<boolean>;
    readonly retry: () => Promise<boolean>;
    readonly restore: (text: string) => Promise<boolean>;
    readonly escape: () => void;
    readonly confirmDiscard: () => Promise<boolean>;
    readonly keepEditing: () => void;
    readonly close: () => void;
}

export interface ComposerControllerOptions {
    readonly store: ThreadStore;
    readonly key: string;
    readonly transport: ComposerTransport;
    readonly debounceMs?: number;
    readonly slowMs?: number;
}

const controllers = new WeakMap<ThreadStore, Map<string, ComposerController>>();

/** One controller per composer opening, retained across virtualization and view changes. */
export function composerControllerFor(options: ComposerControllerOptions): ComposerController {
    const byKey = controllers.get(options.store) ?? new Map<string, ComposerController>();
    controllers.set(options.store, byKey);
    const existing = byKey.get(options.key);
    if (existing !== undefined) {
        return existing;
    }
    const created = createComposerController(options);
    byKey.set(options.key, created);
    return created;
}

/** A published draft can no longer be edited through the old composer. */
export function closePublishedComposers(store: ThreadStore, commentIds: readonly string[]): void {
    const keys = store.closePublishedComposers(new Set(commentIds));
    const byKey = controllers.get(store);
    for (const key of keys) {
        byKey?.get(key)?.close();
    }
}

/** Draft autosave: debounce ≤1s, the first save returns an id, then updates follow. */
export function createComposerController(options: ComposerControllerOptions): ComposerController {
    const debounceMs = options.debounceMs ?? 1000;
    const slowMs = options.slowMs ?? 500;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let slow: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let inFlight: Promise<boolean> | null = null;
    let drainPromise: Promise<boolean> | null = null;
    let queuedText: string | null = null;
    let closeQueued = false;
    let discardRequested = false;
    let reverting = false;
    let discardPromise: Promise<boolean> | null = null;
    let createdWhileDiscarding: { draft: CommentDraft; comment: Comment } | null = null;

    const forget = (): void => {
        const byKey = controllers.get(options.store);
        if (byKey?.get(options.key) === controller) {
            byKey.delete(options.key);
        }
    };

    const clearSlow = (): void => {
        if (slow !== null) {
            clearTimeout(slow);
            slow = null;
        }
    };

    const clearTimers = (): void => {
        if (debounce !== null) {
            clearTimeout(debounce);
            debounce = null;
        }
        clearSlow();
    };

    const state = () => options.store.getComposer(options.key);
    const ignoreRequestResult = (): boolean => discardRequested || reverting;

    const run = async (closeAfter: boolean, allowUncertain: boolean): Promise<boolean> => {
        const current = state();
        if (
            closed ||
            reverting ||
            current === null ||
            current.text.trim() === '' ||
            (current.saveUncertain && current.commentId === null && !allowUncertain)
        ) {
            return false;
        }
        clearTimers();
        const body = current.text;
        options.store.updateComposer(options.key, { status: 'saving', slow: false, confirmDiscard: false });
        slow = setTimeout(() => {
            options.store.updateComposer(options.key, { slow: true });
        }, slowMs);

        const request = (async () => {
            try {
                if (current.commentId === null) {
                    const draft: CommentDraft = { body, parentId: current.parentId, anchor: current.anchor };
                    const comment = await options.transport.save(draft);
                    if (discardRequested) {
                        createdWhileDiscarding = { draft, comment };
                    } else {
                        options.store.addDraft(draft, comment);
                        options.store.updateComposer(options.key, { commentId: comment.id, saveUncertain: false });
                    }
                } else {
                    await options.transport.update(current.commentId, body);
                    if (!ignoreRequestResult()) {
                        options.store.updateDraft(current.commentId, body);
                    }
                }
                if (!ignoreRequestResult() && state()?.text === body) {
                    options.store.updateComposer(options.key, { status: 'saved', slow: false, savedAt: Date.now() });
                }
                return true;
            } catch {
                if (!ignoreRequestResult()) {
                    options.store.updateComposer(options.key, {
                        status: 'error',
                        slow: false,
                        ...(current.commentId === null ? { saveUncertain: true } : {}),
                    });
                }
                return false;
            } finally {
                // Input during a request starts a new debounce. Completing the old save does not cancel it.
                clearSlow();
                inFlight = null;
            }
        })();
        inFlight = request;
        const ok = await request;

        if (ignoreRequestResult()) {
            queuedText = null;
            closeQueued = false;
            return ok;
        }

        const queued = queuedText;
        const shouldClose = closeAfter || closeQueued;
        queuedText = null;
        closeQueued = false;
        if (ok && queued !== null && queued !== body) {
            return run(shouldClose, allowUncertain);
        }
        if (ok && shouldClose && state()?.text === body) {
            options.store.closeComposer(options.key);
            closed = true;
            forget();
        }
        return ok;
    };

    const perform = (closeAfter: boolean, allowUncertain = false): Promise<boolean> => {
        const current = state();
        if (
            closed ||
            reverting ||
            current === null ||
            current.text.trim() === '' ||
            (current.saveUncertain && current.commentId === null && !allowUncertain)
        ) {
            return Promise.resolve(false);
        }
        clearTimers();
        if (drainPromise !== null) {
            queuedText = current.text;
            closeQueued ||= closeAfter;
            return drainPromise;
        }
        const drain = run(closeAfter, allowUncertain).finally(() => {
            if (drainPromise === drain) {
                drainPromise = null;
            }
        });
        drainPromise = drain;
        return drain;
    };

    const discard = (): Promise<boolean> => {
        if (discardPromise !== null) {
            return discardPromise;
        }
        clearTimers();
        closed = true;
        discardRequested = true;
        options.store.updateComposer(options.key, {
            status: 'discarding',
            slow: false,
            confirmDiscard: false,
        });
        const active = inFlight;

        discardPromise = (async () => {
            if (active !== null) {
                await active;
            }

            const current = state();
            const created = createdWhileDiscarding;
            const commentId = created?.comment.id ?? current?.commentId ?? null;
            if (
                commentId === null &&
                (active !== null || current?.saveUncertain === true)
            ) {
                // The first save response was lost: without an id, we cannot prove there is nothing to delete on the host.
                closed = false;
                discardRequested = false;
                options.store.updateComposer(options.key, { status: 'error', confirmDiscard: false });
                return false;
            }

            try {
                if (commentId !== null) {
                    await options.transport.delete(commentId);
                    if (created === null) {
                        options.store.deleteDraft(commentId);
                    }
                }
                options.store.closeComposer(options.key);
                createdWhileDiscarding = null;
                forget();
                return true;
            } catch {
                if (created !== null) {
                    options.store.addDraft(created.draft, created.comment);
                    options.store.updateComposer(options.key, { commentId: created.comment.id, saveUncertain: false });
                }
                closed = false;
                discardRequested = false;
                options.store.updateComposer(options.key, { status: 'error', confirmDiscard: true });
                return false;
            }
        })().finally(() => {
            discardPromise = null;
        });
        return discardPromise;
    };

    const schedule = (): void => {
        if (debounce !== null) {
            clearTimeout(debounce);
        }
        debounce = setTimeout(() => {
            debounce = null;
            void perform(false);
        }, debounceMs);
    };

    const restore = async (text: string): Promise<boolean> => {
        const commentId = state()?.commentId;
        if (closed || reverting || commentId === null || commentId === undefined) {
            return false;
        }
        clearTimers();
        reverting = true;
        queuedText = null;
        closeQueued = false;
        options.store.updateComposer(options.key, {
            text,
            status: 'saving',
            slow: false,
            confirmDiscard: false,
        });
        const active = drainPromise;
        if (active !== null) {
            await active;
        }
        try {
            await options.transport.update(commentId, text);
            options.store.updateDraft(commentId, text);
            options.store.closeComposer(options.key);
            closed = true;
            forget();
            return true;
        } catch {
            reverting = false;
            options.store.updateComposer(options.key, { status: 'error', slow: false });
            return false;
        }
    };

    const controller: ComposerController = {
        input: (text) => {
            if (closed || reverting) {
                return;
            }
            const current = state();
            options.store.updateComposer(options.key, {
                text,
                status: current?.saveUncertain === true ? 'error' : 'idle',
                slow: false,
                confirmDiscard: false,
            });
            if (text.trim() === '' || current?.saveUncertain === true) {
                if (debounce !== null) {
                    clearTimeout(debounce);
                    debounce = null;
                }
            } else {
                schedule();
            }
        },
        saveNow: (close = false) => perform(close),
        // The first save is not idempotent in the UI contract. The UI must show the risk of retrying.
        retry: () => perform(false, true),
        restore,
        escape: () => {
            const current = state();
            if (current === null) {
                return;
            }
            clearTimers();
            if (current.text.trim() === '') {
                void discard();
            } else {
                options.store.updateComposer(options.key, { confirmDiscard: true });
            }
        },
        confirmDiscard: discard,
        keepEditing: () => {
            options.store.updateComposer(options.key, { confirmDiscard: false });
        },
        close: () => {
            clearTimers();
            closed = true;
            forget();
        },
    };
    return controller;
}
