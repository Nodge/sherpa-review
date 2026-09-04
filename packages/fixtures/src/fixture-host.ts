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
 * Third `ReviewHost` implementation (requirements §1/C4), with deterministic fixtures. Used for
 * UI development without a remote review host, the state gallery, contract tests and e2e F5.
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
     * in which case the verdict is not applied (SPEC §4.5).
     */
    readonly failPublishFor?: readonly HostId[];
    /**
     * Draft writes fail: fixture hook for the draft buffer (M5-T15), where the host rejects
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
 * Contract invariant: `Comment.issue === null` occurs only for hosts without `commentIssues`.
 * Fixture constructors omit status by default. The host sets its own on input.
 */
function normalizeIssues(threads: readonly Thread[], fallback: boolean | null): void {
    const walk = (comment: Comment): void => {
        comment.issue = fallback === null ? null : (comment.issue ?? false);
        for (const reply of comment.replies) {
            walk(reply);
        }
    };
    for (const thread of threads) {
        walk(thread.root);
    }
}

/** Status label after an applied verdict, in the host's words as displayed by the review host. */
function statusLabelFor(verdict: Verdict): string {
    return verdict === 'request_changes' ? 'needs_work' : 'shipped';
}

export class FixtureHost implements ReviewHost {
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

    /** Draft writes fail: development toggle for the draft buffer (M5-T15). */
    private failDraftWrites: boolean;

    /** Present only when the fixture host supports viewed marks (`capabilities.fileViewedSync`). */
    setFileViewed?: (fileId: HostId, viewed: boolean) => Promise<void>;

    /** Present only when the fixture host supports file content (`capabilities.fileContent`). */
    getFileContent?: (fileId: HostId) => Promise<FileContent | null>;

    /** Present only when the fixture host supports image bytes (`capabilities.blobs`). */
    getBlob?: (blobId: HostId) => Promise<Uint8Array | null>;

    constructor(name: FixtureName, options: FixtureHostOptions = {}) {
        this.data = fixtureData(name);
        this.failPublishFor = new Set(options.failPublishFor ?? []);
        this.failDraftWrites = options.failDraftWrites ?? false;
        // Fixture data usually leaves issue status unset. The contract invariant is enforced here so
        // every comment in every data file does not need manual annotation.
        for (const iteration of this.data.iterations) {
            normalizeIssues(iteration.threads, this.issueOfNewComment());
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
    }

    getPr(): Promise<PrMeta> {
        return Promise.resolve(structuredClone(this.data.pr));
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
     * the parameter, because retries from the draft buffer depend on it (M5-T15).
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
            found.comment.replies.push(reply);
            this.emit();
            return Promise.resolve(structuredClone(reply));
        }

        const root = this.makeDraftComment(parsed.body, createdAt, parsed.anchor === null);
        if (this.data.pr.capabilities.commentIssues && parsed.issue !== undefined) {
            root.issue = parsed.issue;
        }
        this.activeData().threads.push({
            id: root.id,
            anchor: parsed.anchor,
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
        if (this.data.pr.capabilities.commentIssues && issue !== undefined) {
            found.comment.issue = issue;
        }
        found.comment.editedAt = this.nextTimestamp();
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
        }
        this.emit();
        return Promise.resolve();
    }

    setThreadResolved(threadId: HostId, resolved: boolean): Promise<void> {
        const thread = this.activeData().threads.find((candidate) => candidate.id === threadId);
        if (thread === undefined) {
            return Promise.reject(new Error(`thread ${threadId} not found`));
        }
        thread.resolved = resolved;
        thread.resolvedBy = resolved ? this.data.currentUser.login : null;
        this.emit();
        return Promise.resolve();
    }

    /**
     * Publishes all accumulated drafts. The verdict applies only if every draft is published
     * (SPEC §4.5). Failed comments remain drafts, and the review is not complete.
     */
    publishBatch(verdict: Verdict): Promise<PublishResult> {
        const parsed = verdictSchema.parse(verdict);
        if (parsed === 'sticky_ship' && !this.data.pr.capabilities.stickyShip) {
            return Promise.reject(new Error('host does not support sticky ship (capabilities.stickyShip)'));
        }

        const drafts: Comment[] = [];
        for (const thread of this.activeData().threads) {
            collectDrafts(thread.root, drafts);
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
            this.data.pr.statusLabel = statusLabelFor(parsed);
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
            createdAt,
            editedAt: null,
            replies: [],
        };
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
