import path from 'node:path';

import type {
    AnchorPosition,
    Comment,
    CommentDraft,
    FileContent,
    HostCapabilities,
    HostId,
    Iteration,
    Lens,
    PrDiff,
    PrMeta,
    PublishResult,
    ReviewerVerdict,
    ReviewHost,
    ReviewUser,
    Thread,
    Verdict,
} from '@sherpa/protocol';
import { commentDraftSchema, verdictSchema } from '@sherpa/protocol';

import { RpcFailure } from '../../errors.js';
import type { PatchLine } from '../../route/diff-index.js';
import { walkPatch } from '../../route/diff-index.js';
import type {
    FeedbackComment,
    FeedbackHost,
    FeedbackReply,
    FeedbackRound,
    FeedbackRoundContext,
    FeedbackThread,
} from '../select.js';

import { localInterdiff } from './interdiff.js';
import type { LocalIterationRecord, LocalIterationsStore } from './iterations-store.js';
import { appendToHistory } from './iterations-store.js';
import type { LocalRepo, LocalSnapshot } from './snapshot.js';
import { buildLocalSnapshot, openLocalRepo, probeLocal, readSideBytes } from './snapshot.js';
import type { LocalComment, LocalReviewData, LocalThread, LocalThreadsStore } from './threads-store.js';
import type { LocalVcs } from './vcs.js';

/**
 * Host adapter for a local git checkout: reviews the project directory working tree against
 * a base commit. One iteration is the current tree state. A new one appears when the diff
 * actually changes (`diffId` is its content fingerprint, also used as `headCommit`).
 *
 * Design decisions:
 * - the adapter stores past iterations: their file lists and new-side content live in history
 *   (`iterations-store.ts`), which also supplies the slice between two iterations.
 * - thread staleness is checked against its file, not the whole diff: an edit in another file
 *   advances the iteration but does not detach the thread from its lines.
 * - comments have no remote host: they live beside the PR state, and `publishBatch`
 *   clears the draft flag, saves the verdict and opens a round. The orchestrator uses it to queue
 *   an agent task (`feedback-orchestrator.ts`).
 * - CODEOWNERS review rules are not reproduced locally: `generated: false`, and the reviewer owns the whole diff.
 * - the checkout branch is part of the review key: when it changes, the host fails instead of silently reviewing something else.
 */

/** Working-tree polling interval. No debounce: an edit appears on the next tick. */
const POLL_INTERVAL_MS = 30_000;

/**
 * Publish modes. By default, nobody acts on a verdict: comments go to the agent, which addresses
 * each one. With `--verdicts`, Ship and Request changes work as in a PR: the agent awaits the verdict
 * to perform the action the user requested on approval, while remarks go through Request changes.
 */
const COMMENT_ONLY: readonly Verdict[] = ['comment'];
const WITH_VERDICTS: readonly Verdict[] = ['request_changes', 'ship'];

const CAPABILITIES: Omit<HostCapabilities, 'publishVerdicts'> = {
    fileViewedSync: false,
    fileContent: true,
    commentIssues: false,
    // No local issues to resolve on individual comments. Resolution belongs to the thread.
    commentResolve: false,
    editPublished: true,
    iterations: true,
    blobs: true,
};

export interface LocalHostOptions {
    /** Review key, also `PrMeta.id`. */
    readonly prKey: string;
    readonly vcs: LocalVcs;
    /** Project directory inside the checkout. Outgoing paths are relative to it. */
    readonly projectDir: string;
    /** Comparison base. Null means merge-base with the default base branch on each poll. */
    readonly base: string | null;
    /** Branch used to build the review key. If null, the first snapshot fixes it. */
    readonly branch: string | null;
    /**
     * User instruction for the review outcome (`--verdicts`): enables Ship and Request changes instead of
     * Comment. Without it, only Comment is available.
     */
    readonly verdicts?: string | null;
    readonly threads: LocalThreadsStore;
    /** Iteration history: past working-tree iterations exist nowhere else. */
    readonly iterations: LocalIterationsStore;
    readonly pollIntervalMs?: number;
    readonly now?: () => Date;
    /** The first snapshot fixed the branch. Save it alongside the directory and base. */
    readonly onBranchResolved?: (branch: string) => void;
    /** The instruction changed on the running server. Save it for restart. */
    readonly onVerdictsChanged?: (verdicts: string | null) => void;
    /** Where to log iteration history failures. Defaults to stderr. */
    readonly log?: (message: string) => void;
}

/** Patch context lines around the anchor sent to the agent as an excerpt. */
const EXCERPT_CONTEXT_LINES = 3;

export class LocalHost implements ReviewHost, FeedbackHost {
    /** The reviewer owns the entire working-tree diff. */
    readonly ownershipSource: string;

    private readonly options: LocalHostOptions;
    private readonly pollIntervalMs: number;
    private readonly now: () => Date;
    private readonly log: (message: string) => void;

    private readonly threadWatchers = new Set<(threads: Thread[]) => void>();
    private readonly iterationWatchers = new Set<(iterations: Iteration[]) => void>();
    private timer: NodeJS.Timeout | null = null;

    private repoPromise: Promise<LocalRepo> | null = null;
    private snapshotPromise: Promise<LocalSnapshot> | null = null;
    private current: LocalSnapshot | null = null;
    /** The checkout left this review (branch changed). The host rejects requests until the branch returns. */
    private failure: Error | null = null;
    private expectedBranch: string | null;
    private verdicts: string | null;

    /** In-memory iteration history. Null means it has not yet been read from disk. */
    private historyValue: LocalIterationRecord[] | null = null;
    private historyPromise: Promise<LocalIterationRecord[]> | null = null;

    private dataPromise: Promise<LocalReviewData> | null = null;
    /** Thread mutation queue tail: each edit waits for the previous write to finish. */
    private mutations: Promise<void> = Promise.resolve();

    /** Image side bytes outlive the snapshot because blobs are content-addressed. */
    private readonly blobs = new Map<string, Uint8Array>();

    constructor(options: LocalHostOptions) {
        this.options = options;
        this.ownershipSource = `${options.vcs.kind} diff`;
        this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
        this.now = options.now ?? ((): Date => new Date());
        this.log =
            options.log ??
            ((message: string): void => {
                process.stderr.write(`sherpa-server: ${message}\n`);
            });
        this.expectedBranch = options.branch;
        this.verdicts = options.verdicts ?? null;
    }

    /** Login from the last snapshot. Null if no snapshot has been taken. */
    currentUser(): string | null {
        return this.current?.login ?? null;
    }

    /**
     * Running server instruction, supplied by each `up --local`. Null disables the mode. Returns true
     * if the mode switched on or off, so PR metadata with the new `publishVerdicts` needs rereading.
     */
    setVerdicts(verdicts: string | null): boolean {
        if (verdicts === this.verdicts) {
            return false;
        }
        // Write first: if it fails, the in-memory instruction stays unchanged and the next `up` retries it.
        this.options.onVerdictsChanged?.(verdicts);
        const toggled = (verdicts === null) !== (this.verdicts === null);
        this.verdicts = verdicts;
        return toggled;
    }

    /** Forces a working-tree poll, bypassing the timer interval and the cheap check. */
    async refresh(): Promise<void> {
        await this.rebuild(true);
    }

    async getPr(): Promise<PrMeta> {
        const snapshot = await this.snapshot();
        const data = await this.reviewData();
        const verdict = data.verdict;

        return {
            id: this.options.prKey,
            url: `file://${this.options.projectDir}`,
            title: snapshot.branch,
            author: this.userOf(snapshot.login),
            fromBranch: snapshot.branch,
            toBranch: snapshot.baseRef,
            state: 'open',
            statusLabel: 'local',
            checks: null,
            updatedAt: snapshot.createdAt,
            capabilities: { ...CAPABILITIES, publishVerdicts: [...this.publishVerdicts()] },
            // A verdict belongs to an iteration: a new diff makes the review unfinished again.
            verdicts: verdict?.diffId === snapshot.diffId ? this.verdictsOf(verdict.verdict, snapshot.login) : [],
            // A local review is read by the owner of the tree.
            viewer: this.userOf(snapshot.login),
        };
    }

    /** Full working-tree history. The last entry is the active iteration. */
    async listIterations(): Promise<Iteration[]> {
        await this.snapshot();
        await this.history();
        return this.iterationList();
    }

    async getDiff(slice?: { base: HostId; head: HostId }): Promise<PrDiff> {
        if (slice !== undefined) {
            return this.sliceOf(slice.base, slice.head);
        }

        const snapshot = await this.snapshot();
        return {
            diffId: snapshot.diffId,
            baseCommit: snapshot.baseCommit,
            headCommit: snapshot.headCommit,
            files: snapshot.files.map((file) => structuredClone(file)),
        };
    }

    watchIterations(onChange: (iterations: Iteration[]) => void): () => void {
        this.iterationWatchers.add(onChange);
        this.startPolling();
        void this.listIterations()
            .then((iterations) => {
                if (this.iterationWatchers.has(onChange)) {
                    onChange(iterations);
                }
            })
            .catch(() => {
                // The first snapshot failed: keep the subscription silent. The diff endpoint shows the error to the user.
            });

        return () => {
            this.iterationWatchers.delete(onChange);
            this.stopPollingIfIdle();
        };
    }

    async getThreads(): Promise<Thread[]> {
        return threadsOf(await this.snapshot(), await this.reviewData());
    }

    watchThreads(onChange: (threads: Thread[]) => void): () => void {
        this.threadWatchers.add(onChange);
        this.startPolling();
        void this.getThreads()
            .then((threads) => {
                if (this.threadWatchers.has(onChange)) {
                    onChange(threads);
                }
            })
            .catch(() => {
                // As with iterations, keep the subscription silent instead of crashing the server.
            });

        return () => {
            this.threadWatchers.delete(onChange);
            this.stopPollingIfIdle();
        };
    }

    /**
     * Stores the draft locally. Retrying with the same `idempotencyKey` returns the comment
     * already created: the draft buffer retries writes after a host failure.
     */
    async saveDraft(draft: CommentDraft, options?: { idempotencyKey?: string }): Promise<Comment> {
        const parsed = commentDraftSchema.parse(draft);
        const key = options?.idempotencyKey;

        return this.mutate((data, snapshot) => {
            const repeated = key === undefined ? null : findByKey(data.threads, key);
            if (repeated !== null) {
                return commentOf(repeated);
            }

            const comment: LocalComment = {
                id: String(data.nextId),
                author: this.userOf(snapshot.login),
                body: parsed.body,
                draft: true,
                createdAt: this.now().toISOString(),
                editedAt: null,
                idempotencyKey: key ?? null,
                replies: [],
            };
            data.nextId += 1;

            if (parsed.parentId !== null) {
                const parent = locate(data.threads, parsed.parentId);
                if (parent === null) {
                    throw new Error(`parent comment ${parsed.parentId} is not found`);
                }
                parent.comment.replies.push(comment);
                return commentOf(comment);
            }

            data.threads.push({
                id: comment.id,
                anchor:
                    parsed.anchor === null
                        ? null
                        : { path: parsed.anchor.path, position: parsed.anchor.position },
                fileId: parsed.anchor?.fileId ?? null,
                fileHash:
                    parsed.anchor === null
                        ? null
                        : (snapshot.fileHashByPath.get(parsed.anchor.path) ?? null),
                resolved: false,
                resolvedBy: null,
                // The pin is the iteration where the thread was written. PR-level discussions have no iteration.
                pinnedTo:
                    parsed.anchor === null
                        ? null
                        : { diffId: snapshot.diffId, commit: snapshot.headCommit },
                root: comment,
            });
            return commentOf(comment);
        });
    }

    async updateDraft(commentId: HostId, body: string, _issue?: boolean): Promise<void> {
        await this.mutate((data) => {
            const found = locate(data.threads, commentId);
            if (found === null) {
                throw new Error(`comment ${commentId} is not found`);
            }
            if (!found.comment.draft) {
                throw new Error(`comment ${commentId} is published and cannot be edited`);
            }
            found.comment.body = body;
            found.comment.editedAt = this.now().toISOString();
        });
    }

    async deleteDraft(commentId: HostId): Promise<void> {
        await this.mutate((data) => {
            const found = locate(data.threads, commentId);
            if (found === null) {
                throw new Error(`comment ${commentId} is not found`);
            }
            if (!found.comment.draft) {
                throw new Error(`comment ${commentId} is published and cannot be deleted`);
            }
            if (found.comment.replies.length > 0) {
                throw new Error(`draft ${commentId} has replies: delete them first`);
            }

            if (found.parent === null) {
                data.threads = data.threads.filter((thread) => thread !== found.thread);
            } else {
                found.parent.replies = found.parent.replies.filter((reply) => reply !== found.comment);
            }
        });
    }

    /**
     * Edits a published comment by the current user. Comments by others (agent replies) cannot be edited:
     * local review has one human author, with no identity to use for replacing another author's text.
     */
    async updateComment(commentId: HostId, body: string, _issue?: boolean): Promise<void> {
        await this.mutate((data, snapshot) => {
            const found = this.requirePublishedOwn(data, snapshot, commentId);
            found.comment.body = body;
            found.comment.editedAt = this.now().toISOString();
        });
    }

    /** Deletes a published comment by the current user. Local deletion is physical, with no reason to hide it. */
    async deleteComment(commentId: HostId): Promise<void> {
        await this.mutate((data, snapshot) => {
            const found = this.requirePublishedOwn(data, snapshot, commentId);
            if (found.comment.replies.length > 0) {
                throw new Error(`comment ${commentId} has replies: delete them first`);
            }

            if (found.parent === null) {
                data.threads = data.threads.filter((thread) => thread !== found.thread);
            } else {
                found.parent.replies = found.parent.replies.filter((reply) => reply !== found.comment);
            }
        });
    }

    async setThreadResolved(threadId: HostId, resolved: boolean): Promise<void> {
        await this.mutate((data, snapshot) => {
            const thread = data.threads.find((candidate) => candidate.id === threadId);
            if (thread === undefined) {
                throw new Error(`thread ${threadId} is not found`);
            }
            thread.resolved = resolved;
            thread.resolvedBy = resolved ? snapshot.login : null;
        });
    }

    /**
     * Publishes a local review: clears draft flags, saves the mode together with the iteration,
     * and opens a round for an agent task. `comment` without comments opens no round because
     * the agent has nothing to do. A verdict opens one even empty: the session must learn what the reviewer decided.
     */
    async publishBatch(verdict: Verdict): Promise<PublishResult> {
        const parsed = verdictSchema.parse(verdict);
        if (!this.publishVerdicts().includes(parsed)) {
            throw new RpcFailure(
                'bad_request',
                this.verdicts !== null
                    ? 'This local review ends with a verdict: submit findings through Request changes.'
                    : 'Local review only publishes comments: there is no one here to approve or request changes.',
            );
        }

        const drafts = (await this.reviewData()).threads.some((thread) =>
            flatten(thread.root).some((comment) => comment.draft),
        );
        if (!drafts && parsed === 'comment') {
            return { publishedCommentIds: [], failed: [], verdictApplied: true };
        }

        return this.mutate((data, snapshot) => {
            const publishedCommentIds: HostId[] = [];
            const threadIds: string[] = [];
            for (const thread of data.threads) {
                let touched = false;
                for (const comment of flatten(thread.root)) {
                    if (comment.draft) {
                        comment.draft = false;
                        publishedCommentIds.push(comment.id);
                        touched = true;
                    }
                }
                if (touched) {
                    threadIds.push(thread.id);
                }
            }
            data.verdict = { verdict: parsed, diffId: snapshot.diffId };
            // Drafts may have gone while publishing waited in the queue: the agent needs no empty round without a verdict.
            if (publishedCommentIds.length === 0 && parsed === 'comment') {
                return { publishedCommentIds, failed: [], verdictApplied: true };
            }
            data.rounds.push({
                id: String(data.nextId),
                verdict: parsed,
                diffId: snapshot.diffId,
                headCommit: snapshot.headCommit,
                createdAt: this.now().toISOString(),
                threadIds,
                status: 'pending',
                summary: null,
            });
            data.nextId += 1;
            return { publishedCommentIds, failed: [], verdictApplied: true };
        });
    }

    /** Rounds the agent has not seen yet, in publication order. */
    async pendingRounds(): Promise<FeedbackRound[]> {
        const data = await this.reviewData();
        return data.rounds
            .filter((round) => round.status === 'pending')
            .map((round) => ({
                id: round.id,
                verdict: round.verdict,
                createdAt: round.createdAt,
                threadIds: [...round.threadIds],
            }));
    }

    /** Round context for the agent: checkout paths, anchors, patch excerpts and thread conversations. */
    async roundContext(roundId: string): Promise<FeedbackRoundContext> {
        const snapshot = await this.snapshot();
        const data = await this.reviewData();
        const round = data.rounds.find((candidate) => candidate.id === roundId);
        if (round === undefined) {
            throw new Error(`review round ${roundId} is not found`);
        }

        const threads = round.threadIds.map((threadId) =>
            this.feedbackThread(snapshot, data.threads.find((thread) => thread.id === threadId) ?? null, threadId),
        );
        return {
            roundId,
            verdict: round.verdict,
            // Use the current instruction: the round does not store it.
            instruction: this.verdicts,
            projectDir: this.options.projectDir,
            threads,
        };
    }

    /**
     * Agent replies go to the round's threads, and the round summary goes to a PR discussion. These are published comments,
     * not drafts: the reviewer sees them immediately. Reread the working tree immediately so the agent's changes
     * become an iteration without waiting for a polling tick.
     */
    async completeRound(
        roundId: string,
        result: { readonly replies: readonly FeedbackReply[]; readonly summary: string },
        author: ReviewUser,
    ): Promise<void> {
        await this.mutate((data) => {
            const round = data.rounds.find((candidate) => candidate.id === roundId);
            if (round === undefined) {
                throw new Error(`review round ${roundId} is not found`);
            }

            // Validate everything before writing: failing halfway would leave some replies in memory.
            const targets = result.replies.map((reply) => {
                if (!round.threadIds.includes(reply.threadId)) {
                    throw new Error(`thread ${reply.threadId} is not in review round ${roundId}`);
                }
                const thread = data.threads.find((candidate) => candidate.id === reply.threadId);
                if (thread === undefined) {
                    throw new Error(`thread ${reply.threadId} is not found`);
                }
                return { thread, body: reply.body };
            });

            const createdAt = this.now().toISOString();
            const nextComment = (body: string): LocalComment => {
                const comment: LocalComment = {
                    id: String(data.nextId),
                    author,
                    body,
                    draft: false,
                    createdAt,
                    editedAt: null,
                    idempotencyKey: null,
                    replies: [],
                };
                data.nextId += 1;
                return comment;
            };

            for (const target of targets) {
                target.thread.root.replies.push(nextComment(target.body));
            }
            // The reviewer reads the round summary alongside the rest of the PR discussion.
            const summary = nextComment(result.summary);
            data.threads.push({
                id: summary.id,
                anchor: null,
                fileId: null,
                fileHash: null,
                resolved: false,
                resolvedBy: null,
                pinnedTo: null,
                root: summary,
            });

            round.status = 'done';
            round.summary = result.summary;
        });

        // Polling will catch up with the tree anyway: a failed recalculation does not cancel the round.
        await this.rebuild(true).then(
            () => undefined,
            () => undefined,
        );
    }

    /**
     * Full file contents on both sides. null means the file has no text (binary or larger than
     * `MAX_FILE_BYTES`). Sides are read now, not stored in the snapshot, so bring the snapshot
     * up to date first: otherwise line numbers would diverge from the iteration patch referenced by `fileId`.
     */
    async getFileContent(fileId: HostId): Promise<FileContent | null> {
        const snapshot = await this.rebuild(false);
        const entry = snapshot.entries.get(fileId);
        if (entry === undefined) {
            throw new Error(
                fileId.startsWith(`${snapshot.diffId}:`)
                    ? `file ${fileId} is not in the diff`
                    : `file ${fileId} belongs to an older diff: the working tree has changed since`,
            );
        }
        if (entry.file.binary) {
            return null;
        }

        const repo = await this.repo();
        const [oldSide, newSide] = await Promise.all([
            readSideBytes(repo, snapshot.baseCommit, entry, 'old'),
            readSideBytes(repo, snapshot.baseCommit, entry, 'new'),
        ]);
        if (oldSide.kind === 'oversized' || newSide.kind === 'oversized') {
            return null;
        }
        return {
            oldText: oldSide.kind === 'bytes' ? oldSide.bytes.toString('utf8') : null,
            newText: newSide.kind === 'bytes' ? newSide.bytes.toString('utf8') : null,
        };
    }

    async getBlob(blobId: HostId): Promise<Uint8Array | null> {
        await this.snapshot();
        const bytes = this.blobs.get(blobId);
        return bytes === undefined ? null : bytes.slice();
    }

    /**
     * All diff files belong to the reviewer's ownership zone: there are no local ownership rules, and the reviewer reads
     * all changes in their working tree.
     */
    async ownershipLens(): Promise<Lens> {
        const diff = await this.getDiff();
        return {
            id: 'mine',
            label: 'My files',
            paths: diff.files.map((file) => file.path),
            available: true,
            note: null,
            zones: null,
        };
    }

    extraLenses(): Promise<Lens[]> {
        return Promise.resolve([]);
    }

    private userOf(login: string): ReviewUser {
        return { login, displayName: null, bot: false };
    }

    private publishVerdicts(): readonly Verdict[] {
        return this.verdicts === null ? COMMENT_ONLY : WITH_VERDICTS;
    }

    /** Map the saved publishing mode to header verdicts. `comment` is not a verdict. */
    private verdictsOf(verdict: Verdict, login: string): ReviewerVerdict[] {
        switch (verdict) {
            case 'comment':
                return [];
            case 'ship':
            case 'sticky_ship':
            case 'request_changes':
                return [{ user: this.userOf(login), verdict }];
            default:
                return unreachableVerdict(verdict);
        }
    }

    /** The viewer's own published comment. Reject anything else with a reason. */
    private requirePublishedOwn(data: LocalReviewData, snapshot: LocalSnapshot, commentId: HostId): Located {
        const found = locate(data.threads, commentId);
        if (found === null) {
            throw new Error(`comment ${commentId} is not found`);
        }
        if (found.comment.draft) {
            throw new Error(`comment ${commentId} is a draft: use the draft handles`);
        }
        if (found.comment.author.login !== snapshot.login) {
            throw new Error(`comment ${commentId} belongs to ${found.comment.author.login} and cannot be changed`);
        }
        return found;
    }

    /** One round thread for the agent. If storage has no thread, return an explicit notice instead of context. */
    private feedbackThread(
        snapshot: LocalSnapshot,
        thread: LocalThread | null,
        threadId: string,
    ): FeedbackThread {
        if (thread === null) {
            return {
                threadId,
                path: null,
                file: null,
                position: null,
                excerpt: null,
                note: 'this thread is gone from the local review state',
                resolved: false,
                comments: [],
            };
        }

        const root = feedbackCommentOf(thread.root);
        if (root === null) {
            return {
                threadId,
                path: null,
                file: null,
                position: null,
                excerpt: null,
                note: 'this thread has no published comments yet',
                resolved: thread.resolved,
                comments: [],
            };
        }

        const anchor = thread.anchor;
        const comments = [root];
        if (anchor === null) {
            return {
                threadId,
                path: null,
                file: null,
                position: null,
                excerpt: null,
                note: null,
                resolved: thread.resolved,
                comments,
            };
        }

        const file = snapshot.files.find((candidate) => candidate.path === anchor.path) ?? null;
        const outdated = thread.fileHash === null || snapshot.fileHashByPath.get(anchor.path) !== thread.fileHash;
        const excerpt =
            file === null || outdated || anchor.position === null
                ? null
                : patchExcerpt(file.patch, anchor.position);
        return {
            threadId,
            path: anchor.path,
            file: path.join(this.options.projectDir, anchor.path),
            position: anchor.position,
            excerpt,
            note: excerptNote(file === null, outdated, anchor.position, excerpt),
            resolved: thread.resolved,
            comments,
        };
    }

    /**
     * Storage mutation: write to disk and send a fresh snapshot to subscribers in one step. Mutations run
     * in a queue: thread state is shared, and concurrent read-modify-write operations would leave
     * memory and disk out of sync.
     */
    private mutate<T>(change: (data: LocalReviewData, snapshot: LocalSnapshot) => T): Promise<T> {
        const next = this.mutations.then(async () => {
            const snapshot = await this.snapshot();
            const data = await this.reviewData();

            const result = change(data, snapshot);
            await this.options.threads.write(data);
            this.emitThreads(snapshot, data);
            return result;
        });
        // A failed mutation must not break later ones: the queue only preserves their order.
        this.mutations = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    }

    private emitThreads(snapshot: LocalSnapshot, data: LocalReviewData): void {
        for (const watcher of this.threadWatchers) {
            watcher(threadsOf(snapshot, data));
        }
    }

    private emitIterations(): void {
        for (const watcher of this.iterationWatchers) {
            watcher(this.iterationList());
        }
    }

    /** Iterations from history: the last is active, the rest are previous iterations. */
    private iterationList(): Iteration[] {
        const history = this.historyValue ?? [];
        return history.map((record, index) => ({
            diffId: record.diffId,
            baseCommit: record.baseCommit,
            headCommit: record.headCommit,
            createdAt: record.createdAt,
            status: index === history.length - 1 ? 'active' : 'previous',
        }));
    }

    /**
     * A slice between two recorded iterations. The host will never know an iteration missing
     * from history, so reject it permanently (`bad_request`) instead of retrying.
     */
    private async sliceOf(base: HostId, head: HostId): Promise<PrDiff> {
        await this.snapshot();
        const history = await this.history();
        const find = (diffId: HostId): LocalIterationRecord => {
            const found = history.find((record) => record.diffId === diffId);
            if (found === undefined) {
                throw new RpcFailure('bad_request', `iteration ${diffId} is unknown to the local host`);
            }
            return found;
        };
        return localInterdiff(this.options.iterations, find(base), find(head));
    }

    /** Iteration history: read once from disk, then maintained by the adapter. */
    private history(): Promise<LocalIterationRecord[]> {
        const known = this.historyValue;
        if (known !== null) {
            return Promise.resolve(known);
        }
        this.historyPromise ??= this.options.iterations
            .read()
            .then((records) => {
                this.historyValue ??= records;
                return this.historyValue;
            })
            .catch((error: unknown) => {
                this.historyPromise = null;
                throw error;
            });
        return this.historyPromise;
    }

    /**
     * Record a snapshot in history: the same diff as the last record means the same iteration (restored
     * on server restart), otherwise create a new record. Return the iteration's creation time: an iteration restored
     * from history keeps its own time, not today's.
     *
     * History is derived data: losing it costs progress carryover, but the review screen
     * still works. On storage failure, log it and use the history left in memory,
     * without failing `getPr`, `getDiff`, `listIterations` and the snapshot together.
     */
    private async recordIteration(snapshot: LocalSnapshot): Promise<string> {
        const record: LocalIterationRecord = {
            diffId: snapshot.diffId,
            baseCommit: snapshot.baseCommit,
            headCommit: snapshot.headCommit,
            createdAt: snapshot.createdAt,
            files: snapshot.iterationFiles,
        };

        let known: LocalIterationRecord[];
        try {
            known = await this.history();
        } catch (error) {
            // The host does not know previous iterations: slices for them get the same permanent rejection
            // as an iteration that never existed.
            this.log(`could not read iteration history: ${messageOf(error)}`);
            known = [];
        }

        const last = known.at(-1);
        if (last?.diffId === snapshot.diffId) {
            return last.createdAt;
        }

        try {
            this.historyValue = await this.options.iterations.append(record, snapshot.textBlobs);
        } catch (error) {
            this.log(`could not record iteration ${record.diffId} in history: ${messageOf(error)}`);
            // The iteration stays in memory only: storage has no blobs for it, so the slice shows
            // files without patches. Progress will not carry over, but review works. The next write
            // tries storage again, so disk recovery takes effect automatically.
            this.historyValue = appendToHistory(known, record);
            this.historyPromise = null;
        }
        return record.createdAt;
    }

    private reviewData(): Promise<LocalReviewData> {
        this.dataPromise ??= this.options.threads.read().catch((error: unknown) => {
            this.dataPromise = null;
            throw error;
        });
        return this.dataPromise;
    }

    private repo(): Promise<LocalRepo> {
        this.repoPromise ??= openLocalRepo(this.options.vcs, this.options.projectDir).catch(
            (error: unknown) => {
                this.repoPromise = null;
                throw error;
            },
        );
        return this.repoPromise;
    }

    /**
     * Working-tree snapshot. Compute the first one lazily on first access: server startup
     * does not wait for it (`docs/architecture.md §6`).
     */
    private async snapshot(): Promise<LocalSnapshot> {
        if (this.failure !== null) {
            throw this.failure;
        }
        const current = this.current;
        if (current !== null) {
            return current;
        }
        return this.rebuild(true);
    }

    /**
     * Recalculate the snapshot. Concurrent calls share one pass. A forced call does not share
     * that pass, but queues behind it: the current recalculation started before the change that prompted `force`.
     */
    private rebuild(force: boolean): Promise<LocalSnapshot> {
        const running = this.snapshotPromise;
        if (running !== null && !force) {
            return running;
        }

        const started =
            running === null
                ? this.recompute(force)
                : running.then(
                      () => this.recompute(force),
                      () => this.recompute(force),
                  );
        const tracked: Promise<LocalSnapshot> = started.finally(() => {
            // The queue tail may have advanced: only the last pass clears it.
            if (this.snapshotPromise === tracked) {
                this.snapshotPromise = null;
            }
        });
        this.snapshotPromise = tracked;
        return tracked;
    }

    private async recompute(force: boolean): Promise<LocalSnapshot> {
        const repo = await this.repo();
        const probe = await probeLocal(repo, this.options.base);
        this.checkBranch(probe.info.branch);

        const known = this.current;
        if (known !== null && !force && known.stamp === probe.stamp) {
            // The cheap check matches: the tree has not changed, so there is no need to read the diff.
            return known;
        }

        const built = await buildLocalSnapshot(repo, probe, this.now().toISOString());
        for (const [blobId, bytes] of built.blobs) {
            this.blobs.set(blobId, bytes);
        }

        const previous = this.current;
        if (previous !== null && previous.diffId === built.diffId) {
            // The diff is unchanged, so the iteration stays the same. Only refresh the polling fingerprint.
            this.current = { ...previous, stamp: built.stamp };
            return this.current;
        }

        // Use the creation time from history: server restart restores the iteration instead of creating a new one.
        const createdAt = await this.recordIteration(built);
        const snapshot = createdAt === built.createdAt ? built : { ...built, createdAt };
        this.current = snapshot;
        if (previous !== null) {
            this.emitIterations();
            this.emitThreads(snapshot, await this.reviewData());
        }
        return snapshot;
    }

    /**
     * A review key identifies a directory and branch: another branch means another review, so never serve its diff
     * under the old key. When the branch returns, the next poll clears the rejection.
     */
    private checkBranch(branch: string): void {
        if (this.expectedBranch === null) {
            this.expectedBranch = branch;
            this.options.onBranchResolved?.(branch);
        }
        if (this.expectedBranch !== branch) {
            this.failure = new Error(
                `checkout switched to branch ${branch}; run \`sherpa up --local ${this.options.projectDir}\` again`,
            );
            throw this.failure;
        }
        this.failure = null;
    }

    private startPolling(): void {
        if (this.timer !== null) {
            return;
        }
        this.timer = setInterval(() => {
            void this.rebuild(false).catch(() => {
                // A polling tick must not break subscriptions: the next endpoint call will show the reason.
            });
        }, this.pollIntervalMs);
        this.timer.unref();
    }

    private stopPollingIfIdle(): void {
        if (this.timer === null || this.threadWatchers.size > 0 || this.iterationWatchers.size > 0) {
            return;
        }
        clearInterval(this.timer);
        this.timer = null;
    }
}

/**
 * Threads for callers: fresh copies with anchors moved to the active iteration by file path.
 * Outdated status is computed per file, not for the whole diff: while the thread's file is byte-for-byte unchanged,
 * the thread is pinned to the active iteration and keeps its lines. If the file changes
 * or leaves the diff, the thread becomes outdated and stays pinned to the iteration where it was written.
 */
function threadsOf(snapshot: LocalSnapshot, data: LocalReviewData): Thread[] {
    return data.threads.map((thread) => {
        const anchor = thread.anchor;
        const unchanged =
            thread.fileHash !== null &&
            anchor !== null &&
            snapshot.fileHashByPath.get(anchor.path) === thread.fileHash;

        return {
            id: thread.id,
            anchor:
                anchor === null
                    ? null
                    : {
                          fileId:
                              snapshot.fileIdByPath.get(anchor.path) ??
                              thread.fileId ??
                              `${snapshot.diffId}:${anchor.path}`,
                          path: anchor.path,
                          position: anchor.position,
                      },
            resolved: thread.resolved,
            resolvedBy: thread.resolvedBy,
            outdated: anchor !== null && !unchanged,
            pinnedTo:
                anchor === null
                    ? null
                    : unchanged
                      ? { diffId: snapshot.diffId, commit: snapshot.headCommit }
                      : thread.pinnedTo,
            root: commentOf(thread.root),
        };
    });
}

/**
 * Comment for callers. The local host supports neither issues nor per-comment resolution
 * (`capabilities.commentIssues`, `capabilities.commentResolve`).
 */
function commentOf(comment: LocalComment): Comment {
    return {
        id: comment.id,
        author: comment.author,
        body: comment.body,
        draft: comment.draft,
        issue: null,
        resolved: null,
        createdAt: comment.createdAt,
        editedAt: comment.editedAt,
        replies: comment.replies.map(commentOf),
    };
}

/**
 * Thread comment for the agent. null means a draft. Round context is read when the task is queued,
 * not when it is published, so a draft written in between must not leave the host.
 */
function feedbackCommentOf(comment: LocalComment): FeedbackComment | null {
    if (comment.draft) {
        return null;
    }
    return {
        author: comment.author,
        createdAt: comment.createdAt,
        body: comment.body,
        replies: comment.replies.flatMap((reply) => {
            const published = feedbackCommentOf(reply);
            return published === null ? [] : [published];
        }),
    };
}

/** Why the patch excerpt is missing. null means the excerpt is available. */
function excerptNote(
    missingFile: boolean,
    outdated: boolean,
    position: AnchorPosition | null,
    excerpt: string | null,
): string | null {
    if (missingFile) {
        return 'the file is no longer in the diff of the working tree';
    }
    if (outdated) {
        return 'the thread is outdated: the file changed after the comment was written';
    }
    if (position === null) {
        return 'the comment is on the whole file, not on a line';
    }
    return excerpt === null ? 'the anchored lines are outside the patch of this file' : null;
}

/**
 * Patch excerpt around the anchor: anchor lines plus `EXCERPT_CONTEXT_LINES` on each side,
 * with the same `old new | line` gutter as chat context. null means the anchor is outside the patch.
 */
function patchExcerpt(patch: string | null, position: AnchorPosition): string | null {
    if (patch === null) {
        return null;
    }

    const lines = [...walkPatch(patch)].filter((line) => line.old !== null || line.new !== null);
    const end = position.line + position.size - 1;
    const first = lines.findIndex((line) => inAnchor(line, position.side, position.line, end));
    if (first === -1) {
        return null;
    }
    let last = first;
    for (let index = lines.length - 1; index >= first; index -= 1) {
        const line = lines[index];
        if (line !== undefined && inAnchor(line, position.side, position.line, end)) {
            last = index;
            break;
        }
    }

    return lines
        .slice(Math.max(0, first - EXCERPT_CONTEXT_LINES), last + 1 + EXCERPT_CONTEXT_LINES)
        .map(formatExcerptLine)
        .join('\n');
}

function inAnchor(line: PatchLine, side: 'old' | 'new', start: number, end: number): boolean {
    const number = line[side];
    return number !== null && number >= start && number <= end;
}

function formatExcerptLine(line: PatchLine): string {
    return `${gutterCell(line.old)} ${gutterCell(line.new)} | ${line.raw}`;
}

function gutterCell(value: number | null): string {
    return (value === null ? '.' : String(value)).padStart(5, ' ');
}

interface Located {
    readonly thread: LocalThread;
    /** null means the comment is the thread root. */
    readonly parent: LocalComment | null;
    readonly comment: LocalComment;
}

function locate(threads: readonly LocalThread[], id: string): Located | null {
    for (const thread of threads) {
        const found = locateIn(thread, null, thread.root, id);
        if (found !== null) {
            return found;
        }
    }
    return null;
}

function locateIn(
    thread: LocalThread,
    parent: LocalComment | null,
    comment: LocalComment,
    id: string,
): Located | null {
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

function findByKey(threads: readonly LocalThread[], key: string): LocalComment | null {
    for (const thread of threads) {
        for (const comment of flatten(thread.root)) {
            if (comment.idempotencyKey === key) {
                return comment;
            }
        }
    }
    return null;
}

function flatten(comment: LocalComment): LocalComment[] {
    return [comment, ...comment.replies.flatMap(flatten)];
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function unreachableVerdict(verdict: never): never {
    throw new Error(`unknown verdict ${String(verdict)}`);
}
