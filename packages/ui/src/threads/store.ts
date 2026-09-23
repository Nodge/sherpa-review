import type { Comment, CommentDraft, DraftBufferEntry, FileAnchor, Thread } from '@sherpa/protocol';

import { groupThreads, threadHasDraft, threadResolvedByIssues } from './model.js';
import type { IterationLayout } from './model.js';

/**
 * `buffered` means the server accepted the text, but the host has not yet: the entry is in the server
 * buffer and will be sent automatically. The reviewer sees this as "saved, but not fully", rather than an error: the text
 * survives a tab reload, but ship stays blocked until it is sent (docs/design/SPEC-elements.md §4.5).
 */
export type ComposerStatus = 'idle' | 'saving' | 'saved' | 'discarding' | 'error' | 'buffered';

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
    /** The composer edits an already published comment, so it has no "draft" chip or buffer. */
    readonly published?: boolean;
    /**
     * The message where the reviewer clicked "Reply": the composer stays there in the thread card
     * (docs/design/SPEC-changes-2026-09-20.md §4). The position lives beside the text, outside the component:
     * the modal can be closed and reopened, and the reply will stay beneath its message.
     */
    readonly replyUnder?: string | null;
    readonly commentId: string | null;
    readonly status: ComposerStatus;
    /** Time of the last confirmed save, for the status under the field. */
    readonly savedAt?: number | null;
    /**
     * Logical write key for the server: kept from the first save until success, so
     * a retry cannot create a duplicate. `undefined` means no write has happened yet.
     */
    readonly clientKey?: string | undefined;
    /** Server buffer entry when `status: 'buffered'`, otherwise `null`. */
    readonly bufferEntry?: DraftBufferEntry | null;
    readonly slow: boolean;
    readonly confirmDiscard: boolean;
    readonly resolvedAtOpen: boolean;
}

interface OptimisticDraft {
    readonly draft: CommentDraft;
    readonly comment: Comment;
}

export interface ThreadStoreSnapshot {
    readonly threads: readonly Thread[];
    readonly byFile: ReadonlyMap<string, readonly Thread[]>;
    readonly outside: readonly Thread[];
    /**
     * The iteration of the rendered diff, when it is not the active PR iteration: the layout
     * uses it to find the thread file by `path` and decide whether the thread sits at its lines.
     */
    readonly iterationLayout: IterationLayout | null;
    /** Threads kept visible despite the author lens. */
    readonly keptVisible: ReadonlySet<string>;
    /** The same marks grouped by file, with stable sets for card memoization. */
    readonly keptByFile: ReadonlyMap<string, ReadonlySet<string>>;
    /**
     * Threads expanded beside the code. Stored in tab memory, never written to disk or the URL
     * (`docs/decisions.md`, "Threads, issue and composer"). The decision is made once, when
     * the thread first appears in the store. Only the reviewer changes it afterward, so neither a new
     * host reply nor the reviewer clicking Resolve collapses the thread.
     */
    readonly openThreads: ReadonlySet<string>;
    /**
     * Reviewer login from `PrMeta.viewer` (set by `setViewer`): used to show edit and delete actions on their own published
     * comments. `null` means the host does not know the identity.
     */
    readonly viewerLogin: string | null;
}

export interface ComposerLayoutSnapshot {
    /**
     * Composers anchored to a file, with or without a line (an image comment is placed
     * under the header by the card). Text is deliberately not published here.
     */
    readonly byFile: ReadonlyMap<string, readonly ComposerSnapshot[]>;
    /**
     * Threads with an open reply or draft edit composer. These composers have no anchor,
     * so they do not affect line layout, but their file is in use and must stay in the DOM.
     */
    readonly openThreadIds: ReadonlySet<string>;
}

export interface ComposerGuardSnapshot {
    /** There is unsaved text, a save, or a confirmed deletion in flight. */
    readonly pending: boolean;
}

export interface ThreadStore {
    /**
     * The iteration stays the same, but its role changes: a push turns the active iteration into a previous one, and
     * the layout switches from `fileId` to `path`. The store lives on, along with
     * open composers and their unsaved text.
     */
    readonly setIterationLayout: (layout: IterationLayout | null) => void;
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
    /** All open composers, used to reconcile the draft buffer. */
    readonly listComposers: () => readonly ComposerSnapshot[];
    readonly setServerThreads: (threads: readonly Thread[]) => void;
    /** Reviewer identity from the UI snapshot. `null` means the host does not know it. */
    readonly setViewer: (login: string | null) => void;
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
    /** Resolves one issue comment on a host with `commentResolve`. The rule recomputes the thread. */
    readonly setCommentResolved: (commentId: string, resolved: boolean) => void;
    readonly restoreCommentResolved: (commentId: string, resolved: boolean) => void;
    readonly hasCommentResolvedOverride: (commentId: string) => boolean;
    readonly getCommentResolved: (commentId: string) => boolean;
    readonly getServerCommentResolved: (commentId: string) => boolean | null;
    /** Thread expansion beside the code. `setThreadsOpen` collapses or expands all in one update. */
    readonly toggleThreadOpen: (threadId: string) => void;
    readonly setThreadsOpen: (threadIds: readonly string[], open: boolean) => void;
    readonly isThreadOpen: (threadId: string) => boolean;
    readonly keepVisible: (threadId: string) => void;
    readonly releaseVisible: (threadId: string) => void;
    readonly openComposer: (composer: ComposerSnapshot) => void;
    readonly updateComposer: (key: string, patch: Partial<Omit<ComposerSnapshot, 'key'>>) => void;
    readonly closeComposer: (key: string) => void;
    /** Closes composers for the given comments and returns their keys to the controllers. */
    readonly closeComposersForComments: (commentIds: ReadonlySet<string>) => readonly string[];
}

export function createThreadStore(
    initial: readonly Thread[],
    fileIds: ReadonlySet<string>,
    initialIterationLayout: IterationLayout | null = null,
): ThreadStore {
    let iterationLayout = initialIterationLayout;
    const listeners = new Set<() => void>();
    const composerListeners = new Set<() => void>();
    const composerGuardListeners = new Set<() => void>();
    const listenersByComposer = new Map<string, Set<() => void>>();
    let serverThreads = [...initial];
    const drafts = new Map<string, OptimisticDraft>();
    const resolved = new Map<string, boolean>();
    const reconcileResolved = new Set<string>();
    const commentResolved = new Map<string, boolean>();
    const reconcileCommentResolved = new Set<string>();
    const threadOpen = new Map<string, boolean>();
    const keptVisible = new Set<string>();
    const composers = new Map<string, ComposerSnapshot>();
    const draftDeletions = new Map<string, number>();
    let viewerLogin: string | null = null;
    let snapshot = buildSnapshot(null);
    let composersSnapshot: ComposerLayoutSnapshot = { byFile: new Map(), openThreadIds: new Set() };
    let composerGuardSnapshot: ComposerGuardSnapshot = { pending: false };

    function buildSnapshot(previous: ThreadStoreSnapshot | null): ThreadStoreSnapshot {
        const threads = mergeThreads(serverThreads, drafts, resolved, commentResolved);
        const grouped = groupThreads(threads, fileIds, iterationLayout);
        const byFile = stableGroups(previous?.byFile ?? null, grouped.byFile);
        const openThreads = reconcileOpenThreads(threadOpen, threads);
        return {
            threads,
            byFile,
            outside: sameItems(previous?.outside ?? null, grouped.outside) ? (previous?.outside ?? grouped.outside) : grouped.outside,
            iterationLayout,
            keptVisible: new Set(keptVisible),
            keptByFile: stableKeptByFile(previous?.keptByFile ?? null, byFile, keptVisible),
            openThreads:
                previous !== null && sameSet(previous.openThreads, openThreads) ? previous.openThreads : openThreads,
            viewerLogin,
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
                    // Buffered text is already on the server, so leaving is safe. A separate reason blocks ship
                    // until it is delivered (`publishDisabledReason`). Text added after
                    // a failure is different: it is not on the server yet, and leaving would lose it.
                    (composer.status === 'buffered'
                        ? composer.text !== composer.bufferEntry?.draft.body
                        : composer.commentId === null
                          ? composer.text.trim() !== ''
                          : composer.status !== 'saved'),
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
        const openThreadIds = new Set<string>();
        for (const composer of composers.values()) {
            if (composer.threadId !== null) {
                openThreadIds.add(composer.threadId);
            }
        }
        if (fileId === null) {
            // A composer without an anchor does not affect line layout. Notify subscribers only when
            // the set of threads with open composers changes, and leave `byFile` unchanged.
            if (sameSet(composersSnapshot.openThreadIds, openThreadIds)) {
                return;
            }
            composersSnapshot = { byFile: composersSnapshot.byFile, openThreadIds };
        } else {
            const byFile = new Map(composersSnapshot.byFile);
            const next = [...composers.values()].filter((composer) => composer.anchor?.fileId === fileId);
            if (next.length === 0) {
                byFile.delete(fileId);
            } else {
                byFile.set(fileId, next);
            }
            composersSnapshot = { byFile, openThreadIds };
        }
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
        setIterationLayout: (next) => {
            // An iteration diff is immutable, so `diffId` fully determines the layout. There is no reason to rebuild
            // the snapshot for each new object representing the same iteration.
            if ((iterationLayout?.diffId ?? null) === (next?.diffId ?? null)) {
                return;
            }
            iterationLayout = next;
            publish();
        },
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
        listComposers: () => [...composers.values()],
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
            for (const [commentId, value] of commentResolved) {
                if (
                    reconcileCommentResolved.delete(commentId) ||
                    findComment(serverThreads, commentId)?.resolved === value
                ) {
                    commentResolved.delete(commentId);
                }
            }
            publish();
        },
        setViewer: (login) => {
            if (login === viewerLogin) {
                return;
            }
            viewerLogin = login;
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
        setCommentResolved: (commentId, value) => {
            reconcileCommentResolved.delete(commentId);
            commentResolved.set(commentId, value);
            publish();
        },
        restoreCommentResolved: (commentId, value) => {
            commentResolved.set(commentId, value);
            reconcileCommentResolved.add(commentId);
            publish();
        },
        hasCommentResolvedOverride: (commentId) => commentResolved.has(commentId),
        getCommentResolved: (commentId) =>
            commentResolved.get(commentId) ?? findComment(serverThreads, commentId)?.resolved ?? false,
        getServerCommentResolved: (commentId) => findComment(serverThreads, commentId)?.resolved ?? null,
        toggleThreadOpen: (threadId) => {
            threadOpen.set(threadId, !(threadOpen.get(threadId) ?? false));
            publish();
        },
        setThreadsOpen: (threadIds, open) => {
            let changed = false;
            for (const threadId of threadIds) {
                if (threadOpen.get(threadId) !== open) {
                    threadOpen.set(threadId, open);
                    changed = true;
                }
            }
            if (changed) {
                publish();
            }
        },
        isThreadOpen: (threadId) => threadOpen.get(threadId) ?? false,
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
    commentResolved: ReadonlyMap<string, boolean>,
): Thread[] {
    let threads = server.map((thread) => {
        const value = resolved.get(thread.id);
        return value === undefined || value === thread.resolved ? thread : { ...thread, resolved: value };
    });

    // Optimistic per-comment resolve frame: recompute the thread too, or the edge and marker
    // would show the old state until the host responds.
    for (const [commentId, value] of commentResolved) {
        threads = mapComments(threads, commentId, (comment) =>
            comment.resolved === value ? comment : { ...comment, resolved: value },
        );
    }
    if (commentResolved.size > 0) {
        threads = threads.map((thread) => {
            const byIssues = threadResolvedByIssues(thread);
            return byIssues === null || byIssues === thread.resolved ? thread : { ...thread, resolved: byIssues };
        });
    }

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
                    // The next host read supplies the thread pin.
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

function findComment(threads: readonly Thread[], id: string): Comment | null {
    const visit = (comment: Comment): Comment | null => {
        if (comment.id === id) {
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
        const found = visit(thread.root);
        if (found !== null) {
            return found;
        }
    }
    return null;
}

/**
 * Expansion state for threads beside code. A new thread gets its default once. Only
 * resolved threads without my draft start collapsed (`docs/decisions.md`, "Threads, issues and the composer").
 * Threads that leave the snapshot are forgotten.
 */
function reconcileOpenThreads(state: Map<string, boolean>, threads: readonly Thread[]): Set<string> {
    const open = new Set<string>();
    const alive = new Set<string>();
    for (const thread of threads) {
        alive.add(thread.id);
        const known = state.get(thread.id);
        const value = known ?? !(thread.resolved && !threadHasDraft(thread));
        if (known === undefined) {
            state.set(thread.id, value);
        }
        if (value) {
            open.add(thread.id);
        }
    }
    for (const id of state.keys()) {
        if (!alive.has(id)) {
            state.delete(id);
        }
    }
    return open;
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
