import type { Comment, CommentDraft } from '@sherpa/protocol';

import type { ThreadStore } from './store.js';

export interface ComposerTransport {
    readonly save: (draft: CommentDraft) => Promise<Comment>;
    readonly update: (commentId: string, body: string, issue?: boolean) => Promise<void>;
    readonly delete: (commentId: string) => Promise<void>;
}

export interface ComposerController {
    readonly input: (text: string) => void;
    readonly setIssue: (issue: boolean) => void;
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

/** Closes composers for comments that can no longer be edited. */
export function closeCommentComposers(store: ThreadStore, commentIds: readonly string[]): void {
    const keys = store.closeComposersForComments(new Set(commentIds));
    const byKey = controllers.get(store);
    for (const key of keys) {
        byKey?.get(key)?.close();
    }
}

/** A published draft can no longer be edited through the old composer. */
export function closePublishedComposers(store: ThreadStore, commentIds: readonly string[]): void {
    closeCommentComposers(store, commentIds);
}

/** Saves drafts explicitly: the first save returns an id, subsequent saves use update. */
export function createComposerController(options: ComposerControllerOptions): ComposerController {
    const slowMs = options.slowMs ?? 500;
    let slow: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let inFlight: Promise<boolean> | null = null;
    let drainPromise: Promise<boolean> | null = null;
    let queuedDraft: { text: string; issue: boolean | undefined } | null = null;
    let closeQueued = false;
    let discardRequested = false;
    let reverting = false;
    let discardPromise: Promise<boolean> | null = null;
    let createdWhileDiscarding: { draft: CommentDraft; comment: Comment } | null = null;
    let lastWrittenIssue: boolean | undefined;

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
        const issue = current.issue;
        options.store.updateComposer(options.key, { status: 'saving', slow: false, confirmDiscard: false });
        slow = setTimeout(() => {
            options.store.updateComposer(options.key, { slow: true });
        }, slowMs);

        const request = (async () => {
            try {
                if (current.commentId === null) {
                    const draft: CommentDraft = {
                        body,
                        parentId: current.parentId,
                        anchor: current.anchor,
                        ...(issue === undefined ? {} : { issue }),
                    };
                    const comment = await options.transport.save(draft);
                    lastWrittenIssue = issue;
                    if (discardRequested) {
                        createdWhileDiscarding = { draft, comment };
                    } else {
                        options.store.addDraft(draft, comment);
                        options.store.updateComposer(options.key, {
                            commentId: comment.id,
                            originalText: body,
                            saveUncertain: false,
                        });
                    }
                } else {
                    const issueUpdate = issue === lastWrittenIssue ? undefined : issue;
                    if (issueUpdate === undefined) {
                        await options.transport.update(current.commentId, body);
                    } else {
                        await options.transport.update(current.commentId, body, issueUpdate);
                        lastWrittenIssue = issueUpdate;
                    }
                    if (!ignoreRequestResult()) {
                        options.store.updateDraft(current.commentId, body);
                        options.store.updateComposer(options.key, { originalText: body });
                    }
                }
                if (!ignoreRequestResult()) {
                    const latest = state();
                    if (latest?.text === body && latest.issue === issue) {
                        options.store.updateComposer(options.key, { status: 'saved', slow: false, savedAt: Date.now() });
                    } else if (latest?.status === 'saving') {
                        options.store.updateComposer(options.key, {
                            status: latest.saveUncertain ? 'error' : 'idle',
                            slow: false,
                        });
                    }
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
                clearSlow();
                inFlight = null;
            }
        })();
        inFlight = request;
        const ok = await request;

        if (ignoreRequestResult()) {
            queuedDraft = null;
            closeQueued = false;
            return ok;
        }

        const queued = queuedDraft;
        const shouldClose = closeAfter || closeQueued;
        queuedDraft = null;
        closeQueued = false;
        if (ok && queued !== null && (queued.text !== body || queued.issue !== issue)) {
            return run(shouldClose, allowUncertain);
        }
        if (ok && shouldClose && state()?.text === body && state()?.issue === issue) {
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
            queuedDraft = { text: current.text, issue: current.issue };
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
        const current = state();
        if (current?.commentId !== null && current?.commentId !== undefined && current.originalText !== undefined) {
            return restore(current.originalText);
        }
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

    const restore = async (text: string): Promise<boolean> => {
        const current = state();
        if (closed || reverting || current?.commentId == null) {
            return false;
        }
        const commentId = current.commentId;
        if (current.text === text && current.status === 'saved') {
            options.store.closeComposer(options.key);
            closed = true;
            forget();
            return true;
        }
        clearTimers();
        reverting = true;
        queuedDraft = null;
        closeQueued = false;
        options.store.updateComposer(options.key, {
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
            const saving = current?.status === 'saving';
            options.store.updateComposer(options.key, {
                text,
                status: saving ? 'saving' : current?.saveUncertain === true ? 'error' : 'idle',
                slow: saving ? current.slow : false,
                confirmDiscard: false,
            });
        },
        setIssue: (issue) => {
            if (closed || reverting) {
                return;
            }
            const current = state();
            if (current?.issue === undefined || current.issue === issue) {
                return;
            }
            // Changing issue only marks the composer as unsaved. The write happens on the next
            // explicit save (perform compares issue with lastWrittenIssue).
            options.store.updateComposer(options.key, {
                issue,
                status: current.saveUncertain ? 'error' : 'idle',
                slow: false,
                confirmDiscard: false,
            });
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
            if (current.commentId !== null && current.originalText !== undefined) {
                if (current.text === current.originalText) {
                    void restore(current.originalText);
                } else {
                    options.store.updateComposer(options.key, { confirmDiscard: true });
                }
            } else if (current.text.trim() === '') {
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
