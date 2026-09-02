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
import { commentDraftSchema, verdictSchema } from '@sherpa/protocol';

import type { FixtureData, FixtureName } from './data/index.js';
import { fixtureData } from './data/index.js';
import { fileContentOf } from './file-content.js';

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

    /** Next mutation number, used for timestamps and ids of new drafts. */
    private mutations = 0;

    /** Last applied verdict, observable in tests and the state gallery. */
    private verdict: Verdict | null = null;

    /** Present only when the fixture host supports viewed marks (`capabilities.fileViewedSync`). */
    setFileViewed?: (fileId: HostId, viewed: boolean) => Promise<void>;

    /** Present only when the fixture host supports file content (`capabilities.fileContent`). */
    getFileContent?: (fileId: HostId) => Promise<FileContent | null>;

    constructor(name: FixtureName, options: FixtureHostOptions = {}) {
        this.data = fixtureData(name);
        this.failPublishFor = new Set(options.failPublishFor ?? []);
        // Fixture data usually leaves issue status unset. The contract invariant is enforced here so
        // every comment in every data file does not need manual annotation.
        normalizeIssues(this.data.threads, this.issueOfNewComment());

        if (this.data.pr.capabilities.fileViewedSync) {
            this.setFileViewed = (fileId, viewed) => this.applyFileViewed(fileId, viewed);
        }
        if (this.data.pr.capabilities.fileContent) {
            this.getFileContent = (fileId) => this.loadFileContent(fileId);
        }
    }

    getPr(): Promise<PrMeta> {
        return Promise.resolve(structuredClone(this.data.pr));
    }

    /** Multiple fixture iterations are added in M4-T2. */
    listIterations(): Promise<Iteration[]> {
        return Promise.resolve([this.activeIteration()]);
    }

    /**
     * The fixture holds one iteration, so it rejects a slice with an explicit error, as the
     * contract allows for an adapter that cannot provide a slice.
     */
    getDiff(slice?: { base: HostId; head: HostId }): Promise<PrDiff> {
        if (slice !== undefined) {
            return Promise.reject(new Error('the fixture host holds one iteration: slices are not supported'));
        }
        return Promise.resolve(structuredClone(this.data.diff));
    }

    /** Fixture iteration changes are added in M4-T2. For now the list is fixed, so the subscriber receives it once. */
    watchIterations(onChange: (iterations: Iteration[]) => void): () => void {
        onChange([this.activeIteration()]);
        return () => {
            // Nothing to unsubscribe from: the fixture does not change iterations.
        };
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

    saveDraft(draft: CommentDraft): Promise<Comment> {
        const parsed = commentDraftSchema.parse(draft);
        const createdAt = this.nextTimestamp();

        if (parsed.parentId !== null) {
            const found = locate(this.data.threads, parsed.parentId);
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
        this.data.threads.push({
            id: root.id,
            anchor: parsed.anchor,
            resolved: false,
            resolvedBy: null,
            outdated: false,
            pinnedTo:
                parsed.anchor === null
                    ? null
                    : { diffId: this.data.diff.diffId, commit: this.data.diff.headCommit },
            root,
        });
        this.emit();
        return Promise.resolve(structuredClone(root));
    }

    updateDraft(commentId: HostId, body: string, issue?: boolean): Promise<void> {
        const found = locate(this.data.threads, commentId);
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
        const found = locate(this.data.threads, commentId);
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
            this.data.threads = this.data.threads.filter((thread) => thread !== found.thread);
        } else {
            found.parent.replies = found.parent.replies.filter((reply) => reply !== found.comment);
        }
        this.emit();
        return Promise.resolve();
    }

    setThreadResolved(threadId: HostId, resolved: boolean): Promise<void> {
        const thread = this.data.threads.find((candidate) => candidate.id === threadId);
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
        for (const thread of this.data.threads) {
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
        return locate(this.data.threads, commentId)?.comment.issue;
    }

    private activeIteration(): Iteration {
        return {
            diffId: this.data.diff.diffId,
            baseCommit: this.data.diff.baseCommit,
            headCommit: this.data.diff.headCommit,
            createdAt: this.data.pr.updatedAt,
            status: 'active',
        };
    }

    /** An unknown file is a host error. A known file without content (binary) returns null. */
    private loadFileContent(fileId: HostId): Promise<FileContent | null> {
        const file = this.data.diff.files.find((candidate) => candidate.fileId === fileId);
        if (file === undefined) {
            return Promise.reject(new Error(`file ${fileId} not found in the diff`));
        }
        return Promise.resolve(fileContentOf(file));
    }

    private applyFileViewed(fileId: HostId, viewed: boolean): Promise<void> {
        const file = this.data.diff.files.find((candidate) => candidate.fileId === fileId);
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
        return structuredClone(this.data.threads);
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
