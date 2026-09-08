import type { Comment, CommentDraft, UiSaveDraftResponse, UiUpdateDraftResponse } from '@sherpa/protocol';

import type { ComposerSnapshot, ThreadStore } from './store.js';

/**
 * `clientKey` identifies a logical write in the server buffer. Each write keeps its key until
 * it succeeds, so retries are safe and cannot create a copy.
 */
export interface ComposerTransport {
    readonly save: (draft: CommentDraft, clientKey: string) => Promise<UiSaveDraftResponse>;
    readonly update: (
        commentId: string,
        body: string,
        issue: boolean | undefined,
        clientKey: string,
    ) => Promise<UiUpdateDraftResponse>;
    readonly delete: (commentId: string) => Promise<void>;
    /** Discards a buffered entry: the reviewer no longer needs the text, so there is nothing to deliver. */
    readonly discardBuffered?: (id: string) => Promise<void>;
    /** Retries a buffered write without a composer, from the list in the comments modal. */
    readonly retryBuffered?: (id: string) => Promise<void>;
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
    /** Supplies `clientKey`. Replaced in tests to get a predictable value. */
    readonly newClientKey?: () => string;
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

/** Closes the named composers and forgets their controllers (buffer reconciliation). */
export function closeComposersByKey(store: ThreadStore, keys: readonly string[]): void {
    const byKey = controllers.get(store);
    for (const key of keys) {
        byKey?.get(key)?.close();
        store.closeComposer(key);
    }
}

/** A published draft can no longer be edited through the old composer. */
export function closePublishedComposers(store: ThreadStore, commentIds: readonly string[]): void {
    closeCommentComposers(store, commentIds);
}

/**
 * Explicit draft saving: the first save returns an id, followed by update calls.
 *
 * A `buffered` response is not an error: the server accepted the text, but the host has not yet. The composer
 * stays open and editable, and keeps `clientKey` until the write succeeds, so a retry
 * upserts the same buffer entry without creating a duplicate.
 */
export function createComposerController(options: ComposerControllerOptions): ComposerController {
    const slowMs = options.slowMs ?? 500;
    const newClientKey = options.newClientKey ?? ((): string => crypto.randomUUID());
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
    const opened = options.store.getComposer(options.key);
    // An existing draft opens for editing with the host's issue status, which is already written.
    // Without tracking it, the first save would send the host the value it already has.
    // A composer restored from the buffer has an issue value that has not been written yet. It will
    // reach the host on the next save.
    let lastWrittenIssue: boolean | undefined = opened?.status === 'buffered' ? undefined : opened?.issue;
    /**
     * This composer's buffer entry is updated on every server response, even when
     * there is no one left to show the result to (discarding is in progress). `undefined` means no responses
     * have arrived yet, so the composer snapshot is the source of truth.
     */
    let bufferedEntryId: string | null | undefined;

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
    const bufferedId = (): string | null =>
        bufferedEntryId === undefined ? (state()?.bufferEntry?.id ?? null) : bufferedEntryId;
    const ignoreRequestResult = (): boolean => discardRequested || reverting;

    /** Logical write key: created on the first save and kept until it succeeds. */
    const clientKeyOf = (current: Pick<ComposerSnapshot, 'clientKey'>): string => {
        const existing = current.clientKey;
        if (existing !== undefined) {
            return existing;
        }
        const created = newClientKey();
        options.store.updateComposer(options.key, { clientKey: created });
        return created;
    };

    const run = async (closeAfter: boolean): Promise<boolean> => {
        const current = state();
        if (closed || reverting || current === null || current.text.trim() === '') {
            return false;
        }
        clearTimers();
        const body = current.text;
        const issue = current.issue;
        const clientKey = clientKeyOf(current);
        options.store.updateComposer(options.key, { status: 'saving', slow: false, confirmDiscard: false });
        slow = setTimeout(() => {
            options.store.updateComposer(options.key, { slow: true });
        }, slowMs);

        const request = (async () => {
            try {
                /** The write reached the server buffer. The composer stays open and waits for delivery. */
                let buffered = false;
                if (current.commentId === null) {
                    const draft: CommentDraft = {
                        body,
                        parentId: current.parentId,
                        anchor: current.anchor,
                        ...(issue === undefined ? {} : { issue }),
                    };
                    const response = await options.transport.save(draft, clientKey);
                    if (response.outcome === 'buffered') {
                        bufferedEntryId = response.entry.id;
                        buffered = true;
                        if (!ignoreRequestResult()) {
                            options.store.updateComposer(options.key, {
                                status: 'buffered',
                                bufferEntry: response.entry,
                                slow: false,
                            });
                        }
                    } else {
                        bufferedEntryId = null;
                        // Issue is tracked only after a successful write. Failure leaves it
                        // unwritten, so the next attempt must send it again.
                        lastWrittenIssue = issue;
                        if (discardRequested) {
                            createdWhileDiscarding = { draft, comment: response.comment };
                        } else {
                            options.store.addDraft(draft, response.comment);
                            options.store.updateComposer(options.key, {
                                commentId: response.comment.id,
                                originalText: body,
                                clientKey: undefined,
                                bufferEntry: null,
                            });
                        }
                    }
                } else {
                    const issueUpdate = issue === lastWrittenIssue ? undefined : issue;
                    const response = await options.transport.update(current.commentId, body, issueUpdate, clientKey);
                    if (response.outcome === 'buffered') {
                        bufferedEntryId = response.entry.id;
                        buffered = true;
                        if (!ignoreRequestResult()) {
                            options.store.updateComposer(options.key, {
                                status: 'buffered',
                                bufferEntry: response.entry,
                                slow: false,
                            });
                        }
                    } else {
                        bufferedEntryId = null;
                        if (issueUpdate !== undefined) {
                            lastWrittenIssue = issueUpdate;
                        }
                        if (!ignoreRequestResult()) {
                            options.store.updateDraft(current.commentId, body, issueUpdate);
                            options.store.updateComposer(options.key, {
                                originalText: body,
                                clientKey: undefined,
                                bufferEntry: null,
                            });
                        }
                    }
                }
                if (!buffered && !ignoreRequestResult()) {
                    const latest = state();
                    if (latest?.text === body && latest.issue === issue) {
                        options.store.updateComposer(options.key, { status: 'saved', slow: false, savedAt: Date.now() });
                    } else if (latest?.status === 'saving') {
                        options.store.updateComposer(options.key, { status: 'idle', slow: false });
                    }
                }
                return !buffered;
            } catch {
                if (!ignoreRequestResult()) {
                    options.store.updateComposer(options.key, { status: 'error', slow: false });
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
            return run(shouldClose);
        }
        if (ok && shouldClose && state()?.text === body && state()?.issue === issue) {
            options.store.closeComposer(options.key);
            closed = true;
            forget();
        }
        return ok;
    };

    const perform = (closeAfter: boolean): Promise<boolean> => {
        const current = state();
        if (closed || reverting || current === null || current.text.trim() === '') {
            return Promise.resolve(false);
        }
        clearTimers();
        if (drainPromise !== null) {
            queuedDraft = { text: current.text, issue: current.issue };
            closeQueued ||= closeAfter;
            return drainPromise;
        }
        const drain = run(closeAfter).finally(() => {
            if (drainPromise === drain) {
                drainPromise = null;
            }
        });
        drainPromise = drain;
        return drain;
    };

    const discard = (): Promise<boolean> => {
        const current = state();
        if (
            bufferedId() === null &&
            current?.commentId !== null &&
            current?.commentId !== undefined &&
            current.originalText !== undefined
        ) {
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
            // The entry is still in the server buffer: creation on the host never happened, and an edit has not
            // reached it. There is nothing to delete, so remove the entry itself. For an edit, this is the rollback:
            // the host still has the text from before the edit.
            const buffered = created === null ? bufferedId() : null;
            if (buffered !== null) {
                try {
                    await options.transport.discardBuffered?.(buffered);
                } catch {
                    closed = false;
                    discardRequested = false;
                    options.store.updateComposer(options.key, { status: 'error', confirmDiscard: true });
                    return false;
                }
                bufferedEntryId = null;
                options.store.closeComposer(options.key);
                forget();
                return true;
            }
            if (commentId === null && active !== null) {
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
                    options.store.updateComposer(options.key, {
                        commentId: created.comment.id,
                        clientKey: undefined,
                        bufferEntry: null,
                    });
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
        const buffered = bufferedId();
        if (buffered !== null && text === current.originalText) {
            // The edit did not reach the host, which still has `originalText`. Rolling back means
            // removing the buffer entry without another write to the host that is already unresponsive.
            try {
                await options.transport.discardBuffered?.(buffered);
            } catch {
                options.store.updateComposer(options.key, { status: 'error', slow: false });
                return false;
            }
            bufferedEntryId = null;
            options.store.closeComposer(options.key);
            closed = true;
            forget();
            return true;
        }
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
            const response = await options.transport.update(commentId, text, undefined, clientKeyOf(current));
            if (response.outcome === 'buffered') {
                // The rollback was buffered too. Keep the composer open with the restored
                // text, or the entry would be stuck in the buffer with no way to remove it.
                bufferedEntryId = response.entry.id;
                reverting = false;
                options.store.updateComposer(options.key, {
                    text,
                    status: 'buffered',
                    bufferEntry: response.entry,
                    slow: false,
                });
                return false;
            }
            bufferedEntryId = null;
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
            // Buffered status survives editing: the server entry still exists, and
            // the next save uses the same `clientKey` for the same buffer entry.
            options.store.updateComposer(options.key, {
                text,
                status: saving ? 'saving' : current?.status === 'buffered' ? 'buffered' : 'idle',
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
                status: current.status === 'buffered' ? 'buffered' : 'idle',
                slow: false,
                confirmDiscard: false,
            });
        },
        saveNow: (close = false) => perform(close),
        // Retrying is safe: `clientKey` stays until success, and the server upserts the same entry.
        retry: () => perform(false),
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
