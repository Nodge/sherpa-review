import type { AnchorPosition, Comment, FileAnchor, ReviewUser, Thread, ThreadPin } from '@sherpa/protocol';

import { parseReviewBody } from './drafts.js';
import type { GithubActor, GithubIssueComment, GithubReview, GithubReviewThread, GithubThreadComment } from './schemas.js';

/**
 * Build contract threads from GitHub GraphQL responses.
 *
 * Three sources, 3 thread kinds. `reviewThreads` are diff line discussions. Reviews with nonempty
 * bodies and issue comments are PR discussions. A diff thread has a root and a single level of replies:
 * replies can target only the root ("Replies to replies are not supported", REST
 * `POST …/comments/{comment_id}/replies`), while `addPullRequestReviewThreadReply` writes to the whole
 * thread. Issue comments have no replies at all.
 *
 * Sherpa splits review bodies into paragraphs (`drafts.ts`). GitHub treats this as one comment, but a PR
 * draft has nowhere else to live. The first paragraph becomes the thread root, the others become replies.
 */

/** ID prefixes let edits and deletions choose the mutation to call. */
export const THREAD_PREFIX = 'th:';
export const REVIEW_COMMENT_PREFIX = 'rc:';
export const ISSUE_COMMENT_PREFIX = 'ic:';
export const REVIEW_BODY_PREFIX = 'rv:';
export const REVIEW_PARAGRAPH_PREFIX = 'rvb:';

/** A comment identified by its ID prefix. */
export type ParsedCommentId =
    | { readonly kind: 'review-comment'; readonly nodeId: string }
    | { readonly kind: 'issue-comment'; readonly nodeId: string }
    | { readonly kind: 'review-body'; readonly nodeId: string }
    | { readonly kind: 'review-paragraph'; readonly nodeId: string; readonly n: number };

export function parseCommentId(id: string): ParsedCommentId | null {
    if (id.startsWith(REVIEW_PARAGRAPH_PREFIX)) {
        const rest = id.slice(REVIEW_PARAGRAPH_PREFIX.length);
        const separator = rest.lastIndexOf(':');
        const n = Number(rest.slice(separator + 1));
        if (separator <= 0 || !Number.isInteger(n) || n < 0) {
            return null;
        }
        return { kind: 'review-paragraph', nodeId: rest.slice(0, separator), n };
    }
    if (id.startsWith(REVIEW_COMMENT_PREFIX)) {
        return { kind: 'review-comment', nodeId: id.slice(REVIEW_COMMENT_PREFIX.length) };
    }
    if (id.startsWith(ISSUE_COMMENT_PREFIX)) {
        return { kind: 'issue-comment', nodeId: id.slice(ISSUE_COMMENT_PREFIX.length) };
    }
    if (id.startsWith(REVIEW_BODY_PREFIX)) {
        return { kind: 'review-body', nodeId: id.slice(REVIEW_BODY_PREFIX.length) };
    }
    return null;
}

/** A diff thread node ID from a contract ID. null means this is not a diff thread. */
export function parseThreadId(id: string): string | null {
    return id.startsWith(THREAD_PREFIX) ? id.slice(THREAD_PREFIX.length) : null;
}

export function reviewCommentId(nodeId: string): string {
    return `${REVIEW_COMMENT_PREFIX}${nodeId}`;
}

export function reviewParagraphId(reviewId: string, n: number): string {
    return `${REVIEW_PARAGRAPH_PREFIX}${reviewId}:${String(n)}`;
}

/** Is the comment a body paragraph of this specific review? */
export function isReviewParagraphOf(commentId: string, reviewId: string): boolean {
    const parsed = parseCommentId(commentId);
    return parsed?.kind === 'review-paragraph' && parsed.nodeId === reviewId;
}

export interface BuildThreadsInput {
    readonly threads: readonly GithubReviewThread[];
    readonly reviews: readonly GithubReview[];
    readonly comments: readonly GithubIssueComment[];
    /** The token owner's login. null means whoami failed. GitHub never returns other users' pending reviews anyway. */
    readonly viewer: string | null;
}

/**
 * Thread order: diff line discussions first, then reviews, then issue comments.
 * Within each group, keep GitHub's chronological order.
 */
export function buildThreads(input: BuildThreadsInput): Thread[] {
    const diffThreads = input.threads.map(toDiffThread);
    const reviewThreads = input.reviews
        .map((review) => toReviewThread(review, input.viewer))
        .filter((thread): thread is Thread => thread !== null);
    const issueThreads = input.comments.map(toIssueThread);
    return [...diffThreads, ...reviewThreads, ...issueThreads];
}

function toDiffThread(thread: GithubReviewThread): Thread {
    const comments = compactNodes(thread.comments.nodes).map(toDiffComment);
    const root = comments[0] ?? placeholderComment(thread);

    return {
        id: `${THREAD_PREFIX}${thread.id}`,
        anchor: anchorOf(thread),
        resolved: thread.isResolved,
        resolvedBy: thread.resolvedBy?.login ?? null,
        outdated: thread.isOutdated,
        pinnedTo: pinOf(compactNodes(thread.comments.nodes)[0]),
        root: { ...root, replies: comments.slice(1) },
    };
}

/**
 * A PR thread from a review's body paragraphs. A review without a body creates no thread, since its comments
 * live in their own diff threads. A pending review belongs to the token owner, and its paragraphs are drafts.
 */
function toReviewThread(review: GithubReview, viewer: string | null): Thread | null {
    const draft = review.state === 'PENDING';
    if (draft && viewer !== null && review.author?.login !== viewer) {
        return null;
    }

    const parsed = parseReviewBody(review.body);
    if (parsed.paragraphs.length === 0) {
        return null;
    }

    const author = userOf(review.author);
    const createdAt = isoTime(review.createdAt);
    const editedAt = review.lastEditedAt === null ? null : isoTime(review.lastEditedAt);
    const comments: Comment[] = parsed.paragraphs.map((paragraph) => ({
        // A pending review body is a draft paragraph even without a marker (written on GitHub's website). It gets
        // a marker on the first rewrite, and must be edited and deleted like a regular paragraph.
        // `rv:` stays reserved for a published review body, which GitHub cannot delete.
        id:
            parsed.marked || draft
                ? reviewParagraphId(review.id, paragraph.n)
                : `${REVIEW_BODY_PREFIX}${review.id}`,
        author,
        body: paragraph.body,
        draft,
        issue: null,
        resolved: null,
        createdAt,
        editedAt,
        replies: [],
    }));

    const root = comments[0];
    if (root === undefined) {
        return null;
    }
    return {
        id: root.id,
        anchor: null,
        resolved: false,
        resolvedBy: null,
        outdated: false,
        pinnedTo: null,
        root: { ...root, replies: comments.slice(1) },
    };
}

function toIssueThread(comment: GithubIssueComment): Thread {
    const root: Comment = {
        id: `${ISSUE_COMMENT_PREFIX}${comment.id}`,
        author: userOf(comment.author),
        body: comment.body,
        draft: false,
        issue: null,
        resolved: null,
        createdAt: isoTime(comment.createdAt),
        editedAt: comment.lastEditedAt === null ? null : isoTime(comment.lastEditedAt),
        replies: [],
    };
    return {
        id: root.id,
        anchor: null,
        resolved: false,
        resolvedBy: null,
        outdated: false,
        pinnedTo: null,
        root,
    };
}

export function toDiffComment(comment: GithubThreadComment): Comment {
    return {
        id: reviewCommentId(comment.id),
        author: userOf(comment.author),
        body: comment.body,
        // GitHub never shows other users' pending reviews. PENDING here is always my draft.
        draft: comment.pullRequestReview?.state === 'PENDING',
        issue: null,
        resolved: null,
        createdAt: isoTime(comment.createdAt),
        editedAt: comment.lastEditedAt === null ? null : isoTime(comment.lastEditedAt),
        replies: [],
    };
}

/**
 * GitHub never returns a thread without comments, but the connection can arrive as an empty page.
 * An empty root is better than dropping the thread, since its anchor and status are real.
 */
function placeholderComment(thread: GithubReviewThread): Comment {
    const now = new Date(0).toISOString();
    return {
        id: `${THREAD_PREFIX}${thread.id}`,
        author: { login: 'ghost', displayName: null, bot: false },
        body: '',
        draft: false,
        issue: null,
        resolved: null,
        createdAt: now,
        editedAt: null,
        replies: [],
    };
}

/**
 * Thread anchor. An outdated thread has a null `line`, so use its original coordinates
 * (`originalLine`). `subjectType: FILE` means a comment on the whole file.
 */
function anchorOf(thread: GithubReviewThread): FileAnchor {
    return { fileId: thread.path, path: thread.path, position: positionOf(thread) };
}

function positionOf(thread: GithubReviewThread): AnchorPosition | null {
    if (thread.subjectType === 'FILE') {
        return null;
    }

    const usesOriginal = thread.line === null;
    const last = usesOriginal ? thread.originalLine : thread.line;
    const first = (usesOriginal ? thread.originalStartLine : thread.startLine) ?? last;
    if (last === null || last < 1 || first === null || first < 1) {
        return null;
    }

    const start = Math.min(first, last);
    return { side: thread.diffSide === 'LEFT' ? 'old' : 'new', line: start, size: last - start + 1 };
}

/**
 * Pin a thread to the commit where it was written. On GitHub, this comes from the first comment's review.
 * The host has one iteration, so the pin's `diffId` is the same commit.
 */
function pinOf(first: GithubThreadComment | undefined): ThreadPin | null {
    const oid = first?.pullRequestReview?.commit?.oid;
    return oid === undefined ? null : { diffId: oid, commit: oid };
}

export function userOf(actor: GithubActor | null): ReviewUser {
    if (actor === null) {
        // A deleted account. GitHub returns `author: null` and displays the comment as ghost.
        return { login: 'ghost', displayName: null, bot: false };
    }
    return {
        login: actor.login,
        displayName: actor.name ?? null,
        bot: actor.__typename === 'Bot' || actor.login.endsWith('[bot]'),
    };
}

function compactNodes<T>(nodes: readonly (T | null)[] | null): T[] {
    return (nodes ?? []).filter((node): node is T => node !== null);
}

/** GitHub times are already ISO, but the UI contract promises one form. Normalize through `Date`. */
export function isoTime(raw: string): string {
    const time = new Date(raw);
    if (Number.isNaN(time.getTime())) {
        throw new Error(`GitHub sent an unreadable time: ${JSON.stringify(raw)}`);
    }
    return time.toISOString();
}
