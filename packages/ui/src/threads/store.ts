import type { Comment, CommentDraft, FileAnchor, Thread } from '@sherpa/protocol';

import { groupThreads } from './model.js';

export type ComposerStatus = 'idle' | 'saving' | 'saved' | 'discarding' | 'error';

export interface ComposerSnapshot {
    readonly key: string;
    readonly threadId: string | null;
    readonly parentId: string | null;
    readonly anchor: FileAnchor | null;
    /** undefined means replies, editing an existing draft, or a host without commentIssues. */
    readonly issue?: boolean;
    readonly text: string;
    /** Original text when editing an existing draft, needed for cancellation after remounting. */
    readonly originalText?: string;
    readonly commentId: string | null;
    readonly status: ComposerStatus;
    /** Time of the last confirmed save, for the status under the field. */
    readonly savedAt?: number | null;
    /** The first save may have reached the host, but the UI received no commentId. */
    readonly saveUncertain: boolean;
    readonly slow: boolean;
    readonly confirmDiscard: boolean;
    readonly resolvedAtOpen: boolean;
}

interface OptimisticDraft {
    readonly draft: CommentDraft;
    readonly comment: Comment;
}

export interface ThreadUndo {
    readonly resolved: boolean;
    readonly generation: number;
}

export interface ThreadStoreSnapshot {
    readonly threads: readonly Thread[];
    readonly byFile: ReadonlyMap<string, readonly Thread[]>;
    readonly outside: readonly Thread[];
    /** Threads with an active undo window stay visible despite the resolved filter. */
    readonly keptVisible: ReadonlySet<string>;
    readonly undo: ReadonlyMap<string, ThreadUndo>;
    /** The same marks grouped by file, with stable sets for card memoization. */
    readonly keptByFile: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ComposerLayoutSnapshot {
    /** Only anchored composers for new comments. Text is intentionally not published here. */
    readonly byFile: ReadonlyMap<string, readonly ComposerSnapshot[]>;
}

export interface ComposerGuardSnapshot {
    /** There is unsaved text, a save, or a confirmed deletion in flight. */
    readonly pending: boolean;
}

export interface ThreadStore {
    /** Thread changes: server snapshot, draft, resolve and kept-in-view. */
    readonly subscribe: (listener: () => void) => () => void;
    readonly getSnapshot: () => ThreadStoreSnapshot;
    /** A line-anchored composer appearing or disappearing, excluding text input. */
    readonly subscribeComposers: (listener: () => void) => () => void;
    readonly getComposersSnapshot: () => ComposerLayoutSnapshot;
    /** The publication guard tracks only transitions between "all saved" ↔ "unsaved work exists". */
    readonly subscribeComposerGuard: (listener: () => void) => () => void;
    readonly getComposerGuardSnapshot: () => ComposerGuardSnapshot;
    /** Local subscription to one composer: typing does not notify the card list. */
    readonly subscribeComposer: (key: string, listener: () => void) => () => void;
    readonly getComposer: (key: string) => ComposerSnapshot | null;
    readonly setServerThreads: (threads: readonly Thread[]) => void;
    readonly addDraft: (draft: CommentDraft, comment: Comment) => void;
    /** `issue` is set only if the edit changed it. Otherwise, the comment status stays as it is. */
    readonly updateDraft: (commentId: string, body: string, issue?: boolean) => void;
    readonly deleteDraft: (commentId: string) => void;
    /** Keeps the publication guard active until a confirmed draft deletion completes. */
    readonly beginDraftDeletion: (commentId: string) => void;
    readonly endDraftDeletion: (commentId: string) => void;
    readonly setResolved: (threadId: string, resolved: boolean) => void;
    /** Accepts a request rollback until the next server snapshot, when the server becomes the source of truth again. */
    readonly restoreResolved: (threadId: string, resolved: boolean) => void;
    readonly clearResolved: (threadId: string) => void;
    readonly hasResolvedOverride: (threadId: string) => boolean;
    readonly getServerResolved: (threadId: string) => boolean | null;
    /** Starts a five-second undo window and returns the action generation. */
    readonly startUndo: (threadId: string, resolved: boolean) => number;
    readonly clearUndo: (threadId: string, generation?: number) => void;
    readonly keepVisible: (threadId: string) => void;
    readonly releaseVisible: (threadId: string) => void;
    readonly openComposer: (composer: ComposerSnapshot) => void;
    readonly updateComposer: (key: string, patch: Partial<Omit<ComposerSnapshot, 'key'>>) => void;
    readonly closeComposer: (key: string) => void;
    /** Closes composers for the given comments and returns their keys to the controllers. */
    readonly closeComposersForComments: (commentIds: ReadonlySet<string>) => readonly string[];
}

export function createThreadStore(initial: readonly Thread[], fileIds: ReadonlySet<string>): ThreadStore {
    const listeners = new Set<() => void>();
    const composerListeners = new Set<() => void>();
    const composerGuardListeners = new Set<() => void>();
    const listenersByComposer = new Map<string, Set<() => void>>();
    let serverThreads = [...initial];
    const drafts = new Map<string, OptimisticDraft>();
    const resolved = new Map<string, boolean>();
    const reconcileResolved = new Set<string>();
    const keptVisible = new Set<string>();
    const undo = new Map<string, ThreadUndo>();
    const undoTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let undoGeneration = 0;
    const composers = new Map<string, ComposerSnapshot>();
    const draftDeletions = new Map<string, number>();
    let snapshot = buildSnapshot(null);
    let composersSnapshot: ComposerLayoutSnapshot = { byFile: new Map() };
    let composerGuardSnapshot: ComposerGuardSnapshot = { pending: false };

    function buildSnapshot(previous: ThreadStoreSnapshot | null): ThreadStoreSnapshot {
        const threads = mergeThreads(serverThreads, drafts, resolved);
        const grouped = groupThreads(threads, fileIds);
        const byFile = stableGroups(previous?.byFile ?? null, grouped.byFile);
        return {
            threads,
            byFile,
            outside: sameItems(previous?.outside ?? null, grouped.outside) ? (previous?.outside ?? grouped.outside) : grouped.outside,
            keptVisible: new Set(keptVisible),
            undo: new Map(undo),
            keptByFile: stableKeptByFile(previous?.keptByFile ?? null, byFile, keptVisible),
        };
    }

    const publish = (): void => {
        snapshot = buildSnapshot(snapshot);
        for (const listener of [...listeners]) {
            listener();
        }
    };

    const notifyComposer = (key: string): void => {
        for (const listener of [...(listenersByComposer.get(key) ?? [])]) {
            listener();
        }
    };

    const publishComposerGuard = (): void => {
        const pending =
            draftDeletions.size > 0 ||
            [...composers.values()].some(
                (composer) =>
                    composer.status === 'saving' ||
                    composer.status === 'discarding' ||
                    composer.saveUncertain ||
                    (composer.commentId === null ? composer.text.trim() !== '' : composer.status !== 'saved'),
            );
        if (pending === composerGuardSnapshot.pending) {
            return;
        }
        composerGuardSnapshot = { pending };
        for (const listener of [...composerGuardListeners]) {
            listener();
        }
    };

    const publishComposerLayout = (fileId: string | null): void => {
        if (fileId === null) {
            return;
        }
        const byFile = new Map(composersSnapshot.byFile);
        const next = [...composers.values()].filter(
            (composer) => composer.anchor?.fileId === fileId && composer.anchor.position !== null,
        );
        if (next.length === 0) {
            byFile.delete(fileId);
        } else {
            byFile.set(fileId, next);
        }
        composersSnapshot = { byFile };
        for (const listener of [...composerListeners]) {
            listener();
        }
    };

    const closeComposer = (key: string): boolean => {
        const current = composers.get(key);
        if (current === undefined || !composers.delete(key)) {
            return false;
        }
        publishComposerLayout(current.anchor?.fileId ?? null);
        publishComposerGuard();
        notifyComposer(key);
        return true;
    };

    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => snapshot,
        subscribeComposers: (listener) => {
            composerListeners.add(listener);
            return () => {
                composerListeners.delete(listener);
            };
        },
        getComposersSnapshot: () => composersSnapshot,
        subscribeComposerGuard: (listener) => {
            composerGuardListeners.add(listener);
            return () => {
                composerGuardListeners.delete(listener);
            };
        },
        getComposerGuardSnapshot: () => composerGuardSnapshot,
        subscribeComposer: (key, listener) => {
            const bucket = listenersByComposer.get(key) ?? new Set<() => void>();
            bucket.add(listener);
            listenersByComposer.set(key, bucket);
            return () => {
                bucket.delete(listener);
                if (bucket.size === 0) {
                    listenersByComposer.delete(key);
                }
            };
        },
        getComposer: (key) => composers.get(key) ?? null,
        setServerThreads: (threads) => {
            serverThreads = [...threads];
            const serverIds = commentIds(serverThreads);
            for (const id of drafts.keys()) {
                if (serverIds.has(id)) {
                    drafts.delete(id);
                }
            }
            for (const [threadId, value] of resolved) {
                if (
                    reconcileResolved.delete(threadId) ||
                    serverThreads.find((thread) => thread.id === threadId)?.resolved === value
                ) {
                    resolved.delete(threadId);
                }
            }
            publish();
        },
        addDraft: (draft, comment) => {
            drafts.set(comment.id, { draft, comment });
            publish();
        },
        updateDraft: (commentId, body, issue) => {
            const patch = { body, ...(issue === undefined ? {} : { issue }) };
            const optimistic = drafts.get(commentId);
            if (optimistic !== undefined) {
                drafts.set(commentId, { ...optimistic, comment: { ...optimistic.comment, ...patch } });
            } else {
                serverThreads = mapComments(serverThreads, commentId, (comment) => ({ ...comment, ...patch }));
            }
            publish();
        },
        deleteDraft: (commentId) => {
            drafts.delete(commentId);
            serverThreads = removeComment(serverThreads, commentId);
            publish();
        },
        beginDraftDeletion: (commentId) => {
            draftDeletions.set(commentId, (draftDeletions.get(commentId) ?? 0) + 1);
            publishComposerGuard();
        },
        endDraftDeletion: (commentId) => {
            const count = draftDeletions.get(commentId);
            if (count === undefined) {
                return;
            }
            if (count === 1) {
                draftDeletions.delete(commentId);
            } else {
                draftDeletions.set(commentId, count - 1);
            }
            publishComposerGuard();
        },
        setResolved: (threadId, value) => {
            reconcileResolved.delete(threadId);
            resolved.set(threadId, value);
            publish();
        },
        restoreResolved: (threadId, value) => {
            resolved.set(threadId, value);
            reconcileResolved.add(threadId);
            publish();
        },
        clearResolved: (threadId) => {
            reconcileResolved.delete(threadId);
            if (resolved.delete(threadId)) {
                publish();
            }
        },
        hasResolvedOverride: (threadId) => resolved.has(threadId),
        getServerResolved: (threadId) => serverThreads.find((thread) => thread.id === threadId)?.resolved ?? null,
        startUndo: (threadId, value) => {
            const generation = (undoGeneration += 1);
            const previousTimer = undoTimers.get(threadId);
            if (previousTimer !== undefined) {
                clearTimeout(previousTimer);
            }
            undo.set(threadId, { resolved: value, generation });
            keptVisible.add(threadId);
            const timer = setTimeout(() => {
                const current = undo.get(threadId);
                if (current?.generation === generation) {
                    undo.delete(threadId);
                    keptVisible.delete(threadId);
                    undoTimers.delete(threadId);
                    publish();
                }
            }, 5000);
            undoTimers.set(threadId, timer);
            publish();
            return generation;
        },
        clearUndo: (threadId, generation) => {
            const current = undo.get(threadId);
            if (current === undefined || (generation !== undefined && current.generation !== generation)) {
                return;
            }
            const timer = undoTimers.get(threadId);
            if (timer !== undefined) {
                clearTimeout(timer);
                undoTimers.delete(threadId);
            }
            undo.delete(threadId);
            keptVisible.delete(threadId);
            publish();
        },
        keepVisible: (threadId) => {
            if (!keptVisible.has(threadId)) {
                keptVisible.add(threadId);
                publish();
            }
        },
        releaseVisible: (threadId) => {
            if (keptVisible.delete(threadId)) {
                publish();
            }
        },
        openComposer: (composer) => {
            const previous = composers.get(composer.key);
            const previousFileId = previous?.anchor?.fileId ?? null;
            const nextFileId = composer.anchor?.fileId ?? null;
            composers.set(composer.key, composer);
            if (previousFileId !== null && previousFileId !== nextFileId) {
                publishComposerLayout(previousFileId);
            }
            publishComposerLayout(nextFileId);
            publishComposerGuard();
            notifyComposer(composer.key);
        },
        updateComposer: (key, patch) => {
            const current = composers.get(key);
            if (current !== undefined) {
                composers.set(key, { ...current, ...patch });
                publishComposerGuard();
                notifyComposer(key);
            }
        },
        closeComposer: (key) => {
            closeComposer(key);
        },
        closeComposersForComments: (commentIds) => {
            const keys = [...composers.values()]
                .filter((composer) => composer.commentId !== null && commentIds.has(composer.commentId))
                .map((composer) => composer.key);
            for (const key of keys) {
                closeComposer(key);
            }
            return keys;
        },
    };
}

function mergeThreads(
    server: readonly Thread[],
    drafts: ReadonlyMap<string, OptimisticDraft>,
    resolved: ReadonlyMap<string, boolean>,
): Thread[] {
    let threads = server.map((thread) => {
        const value = resolved.get(thread.id);
        return value === undefined || value === thread.resolved ? thread : { ...thread, resolved: value };
    });

    const known = commentIds(threads);
    for (const { draft, comment } of drafts.values()) {
        if (known.has(comment.id)) {
            continue;
        }
        if (draft.parentId === null) {
            threads = [
                ...threads,
                {
                    id: comment.id,
                    anchor: draft.anchor,
                    resolved: false,
                    resolvedBy: null,
                    outdated: false,
                    // The thread pin arrives from the host on the next read in M4-T3.
                    pinnedTo: null,
                    root: comment,
                },
            ];
            continue;
        }
        threads = mapComments(threads, draft.parentId, (parent) => ({
            ...parent,
            replies: [...parent.replies, comment],
        }));
    }
    return threads;
}

function mapComments(threads: readonly Thread[], id: string, map: (comment: Comment) => Comment): Thread[] {
    const visit = (comment: Comment): Comment => {
        if (comment.id === id) {
            return map(comment);
        }
        const replies = comment.replies.map(visit);
        return replies.some((reply, index) => reply !== comment.replies[index]) ? { ...comment, replies } : comment;
    };
    return threads.map((thread) => {
        const root = visit(thread.root);
        return root === thread.root ? thread : { ...thread, root };
    });
}

function removeComment(threads: readonly Thread[], id: string): Thread[] {
    const visit = (comment: Comment): Comment => {
        const kept = comment.replies.filter((reply) => reply.id !== id);
        const replies = kept.map(visit);
        const changed = kept.length !== comment.replies.length || replies.some((reply, index) => reply !== kept[index]);
        return changed ? { ...comment, replies } : comment;
    };
    return threads
        .filter((thread) => thread.root.id !== id)
        .map((thread) => {
            const root = visit(thread.root);
            return root === thread.root ? thread : { ...thread, root };
        });
}

function commentIds(threads: readonly Thread[]): Set<string> {
    const ids = new Set<string>();
    const visit = (comment: Comment): void => {
        ids.add(comment.id);
        comment.replies.forEach(visit);
    };
    for (const thread of threads) {
        visit(thread.root);
    }
    return ids;
}

function stableGroups(
    previous: ReadonlyMap<string, readonly Thread[]> | null,
    next: ReadonlyMap<string, readonly Thread[]>,
): ReadonlyMap<string, readonly Thread[]> {
    if (previous === null) {
        return next;
    }
    const stable = new Map<string, readonly Thread[]>();
    for (const [fileId, threads] of next) {
        const before = previous.get(fileId) ?? null;
        stable.set(fileId, sameItems(before, threads) ? (before ?? threads) : threads);
    }
    return stable;
}

function stableKeptByFile(
    previous: ReadonlyMap<string, ReadonlySet<string>> | null,
    byFile: ReadonlyMap<string, readonly Thread[]>,
    kept: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlySet<string>> {
    const next = new Map<string, ReadonlySet<string>>();
    for (const [fileId, threads] of byFile) {
        const ids = new Set(threads.filter((thread) => kept.has(thread.id)).map((thread) => thread.id));
        if (ids.size === 0) {
            continue;
        }
        const before = previous?.get(fileId) ?? null;
        next.set(fileId, before !== null && sameSet(before, ids) ? before : ids);
    }
    return next;
}

function sameItems<T>(left: readonly T[] | null, right: readonly T[]): boolean {
    return left !== null && left.length === right.length && left.every((item, index) => item === right[index]);
}

function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
    return left.size === right.size && [...left].every((item) => right.has(item));
}
