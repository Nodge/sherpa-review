import type {
    Comment,
    CommentDraft,
    FileContent,
    HostId,
    Iteration,
    Lens,
    PrDiff,
    PrMeta,
    PublishResult,
    ReviewHost,
    Thread,
    Verdict,
} from '@sherpa/protocol';
import { commentDraftSchema, IMAGE_BLOB_MAX_BYTES, verdictSchema } from '@sherpa/protocol';

import type { FixtureData, FixtureIteration, FixtureName } from './data/index.js';
import { fixtureData } from './data/index.js';
import { fileContentOf } from './file-content.js';
import { fixtureBlob } from './patch.js';

/**
 * `ReviewHost` implementation backed by deterministic fixtures. It supports
 * UI development without a live review host, the state gallery, contract tests and e2e.
 *
 * Rules:
 * - no `Date.now()`/`Math.random()`: mutation timestamps are computed from the fixture's `mutationEpoch`
 *   with a fixed step, and draft ids from the mutation counter.
 * - mutations live in memory until the process ends and are never persisted.
 * - callers receive copies, so they cannot corrupt host state through a returned object.
 */

/** Step between mutation timestamps: one minute, so draft order is readable at a glance. */
const MUTATION_STEP_MS = 60_000;

/** Draft id bases. Host sign convention: inline positive, PR-level negative. */
const INLINE_DRAFT_ID_BASE = 9_000_000;
const PR_LEVEL_DRAFT_ID_BASE = 70_000;

export interface FixtureHostOptions {
    /**
     * Comments that `publishBatch` will fail: a fixture hook for partial publication failure
     * tests, where the verdict must not be applied (`docs/design/SPEC-elements.md §4.5`).
     */
    readonly failPublishFor?: readonly HostId[];
    /**
     * Draft writes fail: a fixture hook for the draft buffer, where the host refuses
     * the write and the server keeps the text. Toggle on a running host through `setFailDraftWrites`.
     */
    readonly failDraftWrites?: boolean;
}

interface Located {
    thread: Thread;
    /** null means the comment is the thread root. */
    parent: Comment | null;
    comment: Comment;
}

function locateIn(thread: Thread, parent: Comment | null, comment: Comment, id: HostId): Located | null {
    if (comment.id === id) {
        return { thread, parent, comment };
    }
    for (const reply of comment.replies) {
        const found = locateIn(thread, comment, reply, id);
        if (found !== null) {
            return found;
        }
    }
    return null;
}

function locate(threads: readonly Thread[], id: HostId): Located | null {
    for (const thread of threads) {
        const found = locateIn(thread, null, thread.root, id);
        if (found !== null) {
            return found;
        }
    }
    return null;
}

function collectDrafts(comment: Comment, into: Comment[]): void {
    if (comment.draft) {
        into.push(comment);
    }
    for (const reply of comment.replies) {
        collectDrafts(reply, into);
    }
}

/**
 * Contract invariant: `Comment.issue`/`Comment.resolved` are `null` only for a host without
 * the corresponding capability. Fixture builders usually leave status unset, so the host
 * assigns its own on input.
 */
function normalizeIssues(threads: readonly Thread[], issues: boolean, resolves: boolean): void {
    const walk = (comment: Comment): void => {
        comment.issue = issues ? (comment.issue ?? false) : null;
        comment.resolved = resolves ? (comment.resolved ?? false) : null;
        for (const reply of comment.replies) {
            walk(reply);
        }
    };
    for (const thread of threads) {
        walk(thread.root);
    }
}

function eachComment(comment: Comment, visit: (found: Comment) => void): void {
    visit(comment);
    for (const reply of comment.replies) {
        eachComment(reply, visit);
    }
}

/**
 * Rule for a host with per-comment resolution: a thread is resolved if it has at least one issue
 * comment and all issue comments are resolved. A thread without issues is always open, with nothing to resolve.
 */
function resolvedByRule(thread: Thread): boolean {
    const issues: Comment[] = [];
    eachComment(thread.root, (comment) => {
        if (comment.issue === true) {
            issues.push(comment);
        }
    });
    return issues.length > 0 && issues.every((comment) => comment.resolved === true);
}

/**
 * Recompute `Thread.resolved` by the rule. `by` names the last user to change status. null keeps
 * the previous attribution (the fixture data supplies it).
 */
function applyResolveRule(thread: Thread, by: string | null): void {
    thread.resolved = resolvedByRule(thread);
    if (!thread.resolved) {
        thread.resolvedBy = null;
    } else if (by !== null) {
        thread.resolvedBy = by;
    }
}

/**
 * Normalize a thread declared in data to the rule: a thread marked resolved but without any
 * issue marks its root resolved. Otherwise the rule would reopen it, and the fixture would show
 * a different state from the one it was written for.
 */
function normalizeThreadResolve(thread: Thread): void {
    if (thread.resolved && !resolvedByRule(thread)) {
        thread.root.issue = true;
        thread.root.resolved = true;
    }
    applyResolveRule(thread, null);
}

/**
 * Status label after applying a verdict, in the wording shown by the host.
 * null means this verdict mode has no status and leaves it unchanged.
 */
const STATUS_LABELS: Readonly<Record<Verdict, string | null>> = {
    comment: null,
    ship: 'shipped',
    sticky_ship: 'shipped',
    request_changes: 'needs_work',
};

export class FixtureHost implements ReviewHost {
    /** Fixtures reproduce ownership zones. */
    readonly ownershipSource = 'CODEOWNERS';

    private readonly data: FixtureData;
    private readonly failPublishFor: ReadonlySet<HostId>;
    private readonly watchers = new Set<(threads: Thread[]) => void>();
    private readonly iterationWatchers = new Set<(iterations: Iteration[]) => void>();

    /** Active-iteration pointer. `advanceIteration` moves it forward by one. */
    private active = 0;

    /** Next mutation number, used for timestamps and ids of new drafts. */
    private mutations = 0;

    /** Last applied verdict, observable in tests and the state gallery. */
    private verdict: Verdict | null = null;

    /** Draft writes fail: development toggle for the draft buffer. */
    private failDraftWrites: boolean;

    /** Present only when the fixture host supports viewed marks (`capabilities.fileViewedSync`). */
    setFileViewed?: (fileId: HostId, viewed: boolean) => Promise<void>;

    /** Present only when the fixture host supports file content (`capabilities.fileContent`). */
    getFileContent?: (fileId: HostId) => Promise<FileContent | null>;

    /** Present only when the fixture host supports image bytes (`capabilities.blobs`). */
    getBlob?: (blobId: HostId) => Promise<Uint8Array | null>;

    /** Present only when the fixture host supports per-comment resolution (`capabilities.commentResolve`). */
    setCommentResolved?: (commentId: HostId, resolved: boolean) => Promise<void>;

    /** Present only when the fixture host supports editing published comments (`capabilities.editPublished`). */
    updateComment?: (commentId: HostId, body: string, issue?: boolean) => Promise<void>;

    deleteComment?: (commentId: HostId) => Promise<void>;

    constructor(name: FixtureName, options: FixtureHostOptions = {}) {
        this.data = fixtureData(name);
        this.failPublishFor = new Set(options.failPublishFor ?? []);
        this.failDraftWrites = options.failDraftWrites ?? false;
        // Fixture data usually leaves issue status unset. The contract invariant is enforced here so
        // every comment in every data file does not need manual annotation.
        const capabilities = this.data.pr.capabilities;
        for (const iteration of this.data.iterations) {
            normalizeIssues(iteration.threads, capabilities.commentIssues, capabilities.commentResolve);
            if (capabilities.commentResolve) {
                for (const thread of iteration.threads) {
                    normalizeThreadResolve(thread);
                }
            }
        }

        if (this.data.pr.capabilities.fileViewedSync) {
            this.setFileViewed = (fileId, viewed) => this.applyFileViewed(fileId, viewed);
        }
        if (this.data.pr.capabilities.fileContent) {
            this.getFileContent = (fileId) => this.loadFileContent(fileId);
        }
        if (this.data.pr.capabilities.blobs) {
            this.getBlob = (blobId) => this.loadBlob(blobId);
        }
        if (capabilities.commentResolve) {
            this.setCommentResolved = (commentId, resolved) => this.applyCommentResolved(commentId, resolved);
        }
        if (capabilities.editPublished) {
            this.updateComment = (commentId, body, issue) => this.applyUpdateComment(commentId, body, issue);
            this.deleteComment = (commentId) => this.applyDeleteComment(commentId);
        }
    }

    getPr(): Promise<PrMeta> {
        // "Me" in the fixture is both the draft author and the user viewing the PR.
        return Promise.resolve({ ...structuredClone(this.data.pr), viewer: structuredClone(this.data.currentUser) });
    }

    /** Iterations up to and including the active one. Iterations rewritten by force-push are never listed. */
    listIterations(): Promise<Iteration[]> {
        return Promise.resolve(this.iterationsSnapshot());
    }

    /**
     * The active iteration's diff, or with `slice`, a fixture-declared slice between two
     * listed iterations. Anything absent from the data is rejected with a clear error.
     * Silently returning the wrong iteration's diff is worse than refusing.
     */
    getDiff(slice?: { base: HostId; head: HostId }): Promise<PrDiff> {
        if (slice === undefined) {
            return Promise.resolve(structuredClone(this.activeData().diff));
        }
        if (!this.data.pr.capabilities.iterations) {
            return Promise.reject(new Error('host does not support slices between iterations (capabilities.iterations)'));
        }

        const listed = new Set(this.listed().map((iteration) => iteration.iteration.diffId));
        for (const diffId of [slice.base, slice.head]) {
            if (!listed.has(diffId)) {
                return Promise.reject(new Error(`iteration ${diffId} is unknown to the host`));
            }
        }

        const found = this.data.interdiffs.find(
            (interdiff) => interdiff.base === slice.base && interdiff.head === slice.head,
        );
        if (found === undefined) {
            return Promise.reject(new Error(`slice ${slice.base}→${slice.head} is absent from the fixture`));
        }
        return Promise.resolve(structuredClone(found.diff));
    }

    /** Subscribe to iterations: a snapshot immediately and after each `advanceIteration`. */
    watchIterations(onChange: (iterations: Iteration[]) => void): () => void {
        this.iterationWatchers.add(onChange);
        onChange(this.iterationsSnapshot());
        return () => {
            this.iterationWatchers.delete(onChange);
        };
    }

    /**
     * Fixture "push": the next declared iteration becomes active. Used by the server's development endpoint
     * and the second-pass gallery. At the last iteration there is nowhere further to go.
     */
    advanceIteration(): Iteration {
        if (this.active + 1 >= this.data.iterations.length) {
            throw new Error('no more iterations: end of fixture');
        }
        this.active += 1;
        for (const watcher of this.iterationWatchers) {
            watcher(this.iterationsSnapshot());
        }
        this.emit();
        return this.activeIteration();
    }

    /** Development toggle for draft write failures, used by buffer e2e to fail the host on a running server. */
    setFailDraftWrites(fail: boolean): void {
        this.failDraftWrites = fail;
    }

    getThreads(): Promise<Thread[]> {
        return Promise.resolve(this.threadsSnapshot());
    }

    watchThreads(onChange: (threads: Thread[]) => void): () => void {
        this.watchers.add(onChange);
        onChange(this.threadsSnapshot());
        return () => {
            this.watchers.delete(onChange);
        };
    }

    /**
     * The fixture ignores the idempotency key because duplicates are harmless here. The contract must accept
     * the parameter because draft-buffer write retries depend on it.
     */
    saveDraft(draft: CommentDraft, _options?: { idempotencyKey?: string }): Promise<Comment> {
        if (this.failDraftWrites) {
            return Promise.reject(new Error('fixture host refuses to accept drafts'));
        }
        const parsed = commentDraftSchema.parse(draft);
        const createdAt = this.nextTimestamp();

        if (parsed.parentId !== null) {
            const found = locate(this.activeData().threads, parsed.parentId);
            if (found === null) {
                return Promise.reject(new Error(`parent comment ${parsed.parentId} not found`));
            }
            const reply = this.makeDraftComment(parsed.body, createdAt, found.thread.anchor === null);
            this.applyIssueFlag(reply, parsed.issue);
            found.comment.replies.push(reply);
            this.reapplyResolveRule(found.thread);
            this.emit();
            return Promise.resolve(structuredClone(reply));
        }

        const root = this.makeDraftComment(parsed.body, createdAt, parsed.anchor === null);
        this.applyIssueFlag(root, parsed.issue);
        this.activeData().threads.push({
            id: root.id,
            anchor: parsed.anchor,
            // A new thread is open under both rules, since it cannot have resolved issues yet.
            resolved: false,
            resolvedBy: null,
            outdated: false,
            pinnedTo:
                parsed.anchor === null
                    ? null
                    : {
                          diffId: this.activeData().diff.diffId,
                          commit: this.activeData().diff.headCommit,
                      },
            root,
        });
        this.emit();
        return Promise.resolve(structuredClone(root));
    }

    updateDraft(commentId: HostId, body: string, issue?: boolean): Promise<void> {
        if (this.failDraftWrites) {
            return Promise.reject(new Error('fixture host refuses to accept drafts'));
        }
        const found = locate(this.activeData().threads, commentId);
        if (found === null) {
            return Promise.reject(new Error(`comment ${commentId} not found`));
        }
        if (!found.comment.draft) {
            return Promise.reject(new Error(`comment ${commentId} is already published and cannot be edited`));
        }
        found.comment.body = body;
        this.applyIssueFlag(found.comment, issue);
        found.comment.editedAt = this.nextTimestamp();
        this.reapplyResolveRule(found.thread);
        this.emit();
        return Promise.resolve();
    }

    /** Physically deletes the draft, matching the review host, instead of marking it deleted. */
    deleteDraft(commentId: HostId): Promise<void> {
        const found = locate(this.activeData().threads, commentId);
        if (found === null) {
            return Promise.reject(new Error(`comment ${commentId} not found`));
        }
        if (!found.comment.draft) {
            return Promise.reject(new Error(`comment ${commentId} is already published and cannot be deleted`));
        }
        if (found.comment.replies.length > 0) {
            // Removing the root would silently remove its subtree, so return an explicit error.
            return Promise.reject(new Error(`draft ${commentId} has replies: delete them first`));
        }

        if (found.parent === null) {
            const active = this.activeData();
            active.threads = active.threads.filter((thread) => thread !== found.thread);
        } else {
            found.parent.replies = found.parent.replies.filter((reply) => reply !== found.comment);
            this.reapplyResolveRule(found.thread);
        }
        this.emit();
        return Promise.resolve();
    }

    /**
     * Thread-level resolution. A host with per-comment resolution updates the
     * comment's status: it becomes an issue in the requested state, and the thread is recomputed
     * by the rule. An open issue in a reply keeps the thread open.
     */
    setThreadResolved(threadId: HostId, resolved: boolean): Promise<void> {
        const thread = this.activeData().threads.find((candidate) => candidate.id === threadId);
        if (thread === undefined) {
            return Promise.reject(new Error(`thread ${threadId} not found`));
        }
        if (this.data.pr.capabilities.commentResolve) {
            thread.root.issue = true;
            thread.root.resolved = resolved;
            applyResolveRule(thread, this.data.currentUser.login);
        } else {
            thread.resolved = resolved;
            thread.resolvedBy = resolved ? this.data.currentUser.login : null;
        }
        this.emit();
        return Promise.resolve();
    }

    /** Resolve one issue comment. Reject comments without an issue, since there is nothing to resolve. */
    private applyCommentResolved(commentId: HostId, resolved: boolean): Promise<void> {
        const found = locate(this.activeData().threads, commentId);
        if (found === null) {
            return Promise.reject(new Error(`comment ${commentId} not found`));
        }
        if (found.comment.issue !== true) {
            return Promise.reject(new Error(`comment ${commentId} does not open an issue: nothing to resolve`));
        }
        found.comment.resolved = resolved;
        applyResolveRule(found.thread, this.data.currentUser.login);
        this.emit();
        return Promise.resolve();
    }

    /** Edit your own published comment. Drafts go through `updateDraft`. */
    private applyUpdateComment(commentId: HostId, body: string, issue?: boolean): Promise<void> {
        const found = locate(this.activeData().threads, commentId);
        if (found === null) {
            return Promise.reject(new Error(`comment ${commentId} not found`));
        }
        if (found.comment.draft) {
            return Promise.reject(new Error(`comment ${commentId} is a draft: edit it through updateDraft`));
        }
        if (found.comment.author.login !== this.data.currentUser.login) {
            return Promise.reject(new Error(`comment ${commentId} belongs to someone else and cannot be edited`));
        }
        found.comment.body = body;
        this.applyIssueFlag(found.comment, issue);
        found.comment.editedAt = this.nextTimestamp();
        this.reapplyResolveRule(found.thread);
        this.emit();
        return Promise.resolve();
    }

    /** Delete your own published comment. The fixture physically removes it. */
    private applyDeleteComment(commentId: HostId): Promise<void> {
        const found = locate(this.activeData().threads, commentId);
        if (found === null) {
            return Promise.reject(new Error(`comment ${commentId} not found`));
        }
        if (found.comment.draft) {
            return Promise.reject(new Error(`comment ${commentId} is a draft: delete it through deleteDraft`));
        }
        if (found.comment.author.login !== this.data.currentUser.login) {
            return Promise.reject(new Error(`comment ${commentId} belongs to someone else and cannot be deleted`));
        }
        if (found.comment.replies.length > 0) {
            return Promise.reject(new Error(`comment ${commentId} has replies: delete them first`));
        }

        if (found.parent === null) {
            const active = this.activeData();
            active.threads = active.threads.filter((thread) => thread !== found.thread);
        } else {
            found.parent.replies = found.parent.replies.filter((reply) => reply !== found.comment);
            this.reapplyResolveRule(found.thread);
        }
        this.emit();
        return Promise.resolve();
    }

    /**
     * Publishes all accumulated drafts. Rejects verdicts outside `publishVerdicts`. With no drafts,
     * `comment` changes nothing. Applies the verdict only when all drafts were published
     * (`docs/design/SPEC-elements.md §4.5`). Failed comments remain drafts, and the review stays unfinished.
     */
    publishBatch(verdict: Verdict): Promise<PublishResult> {
        const parsed = verdictSchema.parse(verdict);
        if (!this.data.pr.capabilities.publishVerdicts.includes(parsed)) {
            return Promise.reject(new Error(`verdict ${parsed} is unavailable on this PR (capabilities.publishVerdicts)`));
        }

        const drafts: Comment[] = [];
        for (const thread of this.activeData().threads) {
            collectDrafts(thread.root, drafts);
        }
        // Nothing to publish or apply: the host does not change at all.
        if (parsed === 'comment' && drafts.length === 0) {
            return Promise.resolve({ publishedCommentIds: [], failed: [], verdictApplied: true });
        }

        const publishedCommentIds: HostId[] = [];
        const failed: { commentId: HostId; message: string }[] = [];
        for (const draft of drafts) {
            if (this.failPublishFor.has(draft.id)) {
                failed.push({ commentId: draft.id, message: 'fixture: publishing this comment is configured to fail' });
                continue;
            }
            draft.draft = false;
            publishedCommentIds.push(draft.id);
        }

        const verdictApplied = failed.length === 0;
        if (verdictApplied) {
            this.verdict = parsed;
            this.data.pr.statusLabel = STATUS_LABELS[parsed] ?? this.data.pr.statusLabel;
            this.data.pr.updatedAt = this.nextTimestamp();
        }

        this.emit();
        return Promise.resolve({ publishedCommentIds, failed, verdictApplied });
    }

    ownershipLens(): Promise<Lens | null> {
        return Promise.resolve(this.data.ownership === null ? null : structuredClone(this.data.ownership));
    }

    extraLenses(): Promise<Lens[]> {
        return Promise.resolve(structuredClone(this.data.extraLenses));
    }

    /** Fixture inspection: the last applied verdict (null if none). */
    appliedVerdict(): Verdict | null {
        return this.verdict;
    }

    /** Comment issue status. `undefined` means the host has no such comment. */
    issueOf(commentId: HostId): boolean | null | undefined {
        return locate(this.activeData().threads, commentId)?.comment.issue;
    }

    /** Active iteration data. The pointer is always within the array, since fixtures are never empty. */
    private activeData(): FixtureIteration {
        const iteration = this.data.iterations[this.active];
        if (iteration === undefined) {
            throw new Error(`iteration pointer ${String(this.active)} is outside the fixture`);
        }
        return iteration;
    }

    /**
     * Iterations the host currently lists: all up to and including the active one, except
     * those rewritten by a force-push. The host no longer sees them, and the server sets `gone`.
     */
    private listed(): FixtureIteration[] {
        const seen = this.data.iterations.slice(0, this.active + 1);
        const replaced = new Set(seen.map((iteration) => iteration.replaces).filter((id) => id !== null));
        return seen.filter((iteration) => !replaced.has(iteration.iteration.diffId));
    }

    private iterationsSnapshot(): Iteration[] {
        const activeId = this.activeData().iteration.diffId;
        return this.listed().map((iteration) => ({
            ...structuredClone(iteration.iteration),
            status: iteration.iteration.diffId === activeId ? ('active' as const) : ('previous' as const),
        }));
    }

    private activeIteration(): Iteration {
        const activeId = this.activeData().iteration.diffId;
        const found = this.iterationsSnapshot().find((iteration) => iteration.diffId === activeId);
        if (found === undefined) {
            throw new Error('active iteration is missing from the list, which should never happen');
        }
        return found;
    }

    /** An unknown file is a host error. A known file without content (binary, image) returns null. */
    private loadFileContent(fileId: HostId): Promise<FileContent | null> {
        const file = this.activeData().diff.files.find((candidate) => candidate.fileId === fileId);
        if (file === undefined) {
            return Promise.reject(new Error(`file ${fileId} not found in the diff`));
        }
        return Promise.resolve(file.image === null ? fileContentOf(file) : null);
    }

    /**
     * Image side bytes. Blobs are content-addressed and live outside iterations: an id from a slice or
     * a previous iteration works just like one from the active iteration. An oversized side returns `null`,
     * as it does on a real host (contract limit).
     */
    private loadBlob(blobId: HostId): Promise<Uint8Array | null> {
        const bytes = fixtureBlob(blobId);
        if (bytes === null || bytes.length > IMAGE_BLOB_MAX_BYTES) {
            return Promise.resolve(null);
        }
        return Promise.resolve(bytes.slice());
    }

    private applyFileViewed(fileId: HostId, viewed: boolean): Promise<void> {
        const file = this.activeData().diff.files.find((candidate) => candidate.fileId === fileId);
        if (file === undefined) {
            return Promise.reject(new Error(`file ${fileId} not found in the diff`));
        }
        file.viewed = viewed;
        return Promise.resolve();
    }

    private makeDraftComment(body: string, createdAt: string, prLevel: boolean): Comment {
        const suffix = this.mutations;
        const id = prLevel ? -(PR_LEVEL_DRAFT_ID_BASE + suffix) : INLINE_DRAFT_ID_BASE + suffix;
        return {
            id: String(id),
            author: structuredClone(this.data.currentUser),
            body,
            draft: true,
            issue: this.issueOfNewComment(),
            resolved: this.data.pr.capabilities.commentResolve ? false : null,
            createdAt,
            editedAt: null,
            replies: [],
        };
    }

    /**
     * Toggles a comment's issue flag. A host without `commentIssues` ignores it silently.
     * Clearing issue also clears `resolved`: a comment without an issue has nothing to resolve.
     */
    private applyIssueFlag(comment: Comment, issue: boolean | undefined): void {
        if (!this.data.pr.capabilities.commentIssues || issue === undefined) {
            return;
        }
        comment.issue = issue;
        if (!issue && comment.resolved !== null) {
            comment.resolved = false;
        }
    }

    /** Recalculates the thread by the rule, only for a host with comment-level resolution. */
    private reapplyResolveRule(thread: Thread): void {
        if (this.data.pr.capabilities.commentResolve) {
            applyResolveRule(thread, null);
        }
    }

    /** Initial comment issue status: `null` means the fixture host does not distinguish issues at all. */
    private issueOfNewComment(): boolean | null {
        return this.data.pr.capabilities.commentIssues ? false : null;
    }

    private nextTimestamp(): string {
        this.mutations += 1;
        const epoch = new Date(this.data.mutationEpoch).getTime();
        return new Date(epoch + this.mutations * MUTATION_STEP_MS).toISOString();
    }

    private threadsSnapshot(): Thread[] {
        return structuredClone(this.activeData().threads);
    }

    private emit(): void {
        for (const watcher of this.watchers) {
            watcher(this.threadsSnapshot());
        }
    }
}

export function makeFixtureHost(name: FixtureName, options: FixtureHostOptions = {}): FixtureHost {
    return new FixtureHost(name, options);
}
