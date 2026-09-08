import type { Comment, FileDiff, HostId, Thread } from '@sherpa/protocol';

import type { FileReadState } from './read-state.js';

export interface ReviewProgressSummary {
    readonly filesSeen: number;
    readonly filesTotal: number;
    readonly linesSeen: number;
    readonly linesTotal: number;
    readonly percentSeen: number;
}

/**
 * Shared panel and Review complete counts use the same read-state model as the tree.
 * Conflict files (docs/design/SPEC-elements.md §4.1) are excluded from both numerator and denominator. They are resolved
 * in the review host, so requiring them to be read before ship would be unfair.
 */
export function reviewProgressSummary(
    files: readonly FileDiff[],
    readState: ReadonlyMap<string, FileReadState>,
): ReviewProgressSummary {
    let filesSeen = 0;
    let filesTotal = 0;
    let linesSeen = 0;
    let linesTotal = 0;
    for (const file of files) {
        if (file.changeType === 'conflict') {
            continue;
        }
        filesTotal += 1;
        const state = readState.get(file.fileId);
        if (state?.state === 'read') {
            filesSeen += 1;
        }
        linesSeen += state?.seen ?? 0;
        linesTotal += file.additions + file.deletions;
    }
    return {
        filesSeen,
        filesTotal,
        linesSeen,
        linesTotal,
        percentSeen: linesTotal === 0 ? 100 : Math.floor((linesSeen / linesTotal) * 100),
    };
}

/** All my unpublished comments, including replies at any depth. */
export function countDraftComments(threads: readonly Thread[]): number {
    let count = 0;
    visitComments(threads, (comment) => {
        if (comment.draft) {
            count += 1;
        }
    });
    return count;
}

/**
 * Drafts in threads pinned outside the active iteration (docs/design/SPEC-elements.md §4.5) were written before a push.
 * They will be sent to a commit that is no longer at the PR head.
 */
export function countPinnedDraftComments(threads: readonly Thread[], activeDiffId: string | null): number {
    if (activeDiffId === null) {
        return 0;
    }
    const pinned = threads.filter((thread) => thread.pinnedTo !== null && thread.pinnedTo.diffId !== activeDiffId);
    return countDraftComments(pinned);
}

/** How many published ids were replies rather than thread roots. */
export function countPublishedReplies(threads: readonly Thread[], publishedIds: readonly HostId[]): number {
    const published = new Set(publishedIds);
    let replies = 0;
    for (const thread of threads) {
        visitComment(thread.root, 0, (comment, depth) => {
            if (depth > 0 && published.has(comment.id)) {
                replies += 1;
            }
        });
    }
    return replies;
}

/** Comment text by id, so the error panel can show more than opaque identifiers. */
export function commentBodies(threads: readonly Thread[]): ReadonlyMap<HostId, string> {
    const bodies = new Map<HostId, string>();
    visitComments(threads, (comment) => {
        bodies.set(comment.id, comment.body);
    });
    return bodies;
}

function visitComments(threads: readonly Thread[], visit: (comment: Comment) => void): void {
    for (const thread of threads) {
        visitComment(thread.root, 0, (comment) => {
            visit(comment);
        });
    }
}

function visitComment(comment: Comment, depth: number, visit: (comment: Comment, depth: number) => void): void {
    visit(comment, depth);
    for (const reply of comment.replies) {
        visitComment(reply, depth + 1, visit);
    }
}
