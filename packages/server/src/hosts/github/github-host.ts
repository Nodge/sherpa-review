import { createHash } from 'node:crypto';

import type {
    AnchorPosition,
    Comment,
    CommentDraft,
    FileAnchor,
    FileContent,
    FileDiff,
    FileImage,
    HostCapabilities,
    HostId,
    ImageSide,
    Iteration,
    Lens,
    LensZone,
    PrChecks,
    PrDiff,
    PrMeta,
    PublishResult,
    ReviewHost,
    ReviewUser,
    ReviewerVerdict,
    Thread,
    Verdict,
} from '@sherpa/protocol';
import {
    commentDraftSchema,
    IMAGE_BLOB_MAX_BYTES,
    imageMimeOf,
    verdictSchema,
} from '@sherpa/protocol';

import { RpcFailure } from '../../errors.js';

import type { FetchLike, GithubClientOptions } from './client.js';
import { GithubClient } from './client.js';
import type { CodeownersRule } from './codeowners.js';
import { ownersOf, parseCodeowners, zonePathOf } from './codeowners.js';
import {
    appendParagraph,
    BODY_PLACEHOLDER,
    parseReviewBody,
    removeParagraph,
    renderReviewBody,
    replaceParagraph,
} from './drafts.js';
import type { IdempotencyStore } from './idempotency-store.js';
import { memoryIdempotencyStore } from './idempotency-store.js';
import {
    ADD_REVIEW_THREAD_MUTATION,
    ADD_REVIEW_THREAD_REPLY_MUTATION,
    CODEOWNERS_QUERY,
    CREATE_REVIEW_MUTATION,
    DELETE_ISSUE_COMMENT_MUTATION,
    DELETE_REVIEW_COMMENT_MUTATION,
    FILE_CONTENT_QUERY,
    FILES_QUERY,
    MARK_FILE_VIEWED_MUTATION,
    PR_QUERY,
    RESOLVE_THREAD_MUTATION,
    REVIEW_BODY_QUERY,
    SUBMIT_REVIEW_MUTATION,
    THREAD_COMMENTS_QUERY,
    THREADS_PAGE_QUERY,
    TICK_QUERY,
    UNMARK_FILE_VIEWED_MUTATION,
    UNRESOLVE_THREAD_MUTATION,
    UPDATE_ISSUE_COMMENT_MUTATION,
    UPDATE_REVIEW_BODY_MUTATION,
    UPDATE_REVIEW_COMMENT_MUTATION,
    VERDICT_REVIEW_MUTATION,
    VIEWER_QUERY,
    blobBinaryQuery,
    blobSizesQuery,
    orgTeamsQuery,
} from './queries.js';
import type {
    GithubFilesResponse,
    GithubOrgTeams,
    GithubPrMeta,
    GithubRestFile,
    GithubReview,
    GithubReviewThread,
} from './schemas.js';
import {
    addReviewThreadMutationSchema,
    addReviewThreadReplyMutationSchema,
    blobAliasesResponseSchema,
    codeownersResponseSchema,
    commentMutationSchema,
    compact,
    compareSchema,
    orgTeamsResponseSchema,
    fileContentResponseSchema,
    filesResponseSchema,
    prResponseSchema,
    resolveThreadMutationSchema,
    restFilesSchema,
    reviewBodyResponseSchema,
    submitReviewMutationSchema,
    threadCommentsResponseSchema,
    threadsPageResponseSchema,
    tickResponseSchema,
    unresolveThreadMutationSchema,
    updateReviewBodyMutationSchema,
    reviewMutationSchema,
    verdictMutationSchema,
    viewedMutationSchema,
    viewerResponseSchema,
} from './schemas.js';
import type { ParsedCommentId } from './threads.js';
import {
    avatarOf,
    buildThreads,
    isoTime,
    isReviewParagraphOf,
    parseCommentId,
    parseThreadId,
    reviewParagraphId,
    toDiffComment,
    userOf,
} from './threads.js';

/**
 * github.com host adapter: PR reads and writes through GraphQL, with 3 REST endpoints for what
 * GraphQL does not provide (`docs/research/github-api.md`).
 *
 * Design decisions (`docs/decisions.md`, "Host adapters"):
 * - one iteration: GitHub has no diffsets. Reviews compare the current branch head against
 *   merge-base, so `capabilities.iterations: false` and the host does not build slices.
 * - drafts live in a GitHub pending review. Line comments are created directly in it, and
 *   PR comment drafts become paragraphs in the review body (`drafts.ts`), since GitHub has
 *   no other place for unpublished text.
 * - publication uses one `submitPullRequestReview`. GitHub has no partial success.
 * - own published comments can be edited and deleted (`capabilities.editPublished`), through a separate pair
 *   of endpoints. `updateDraft`/`deleteDraft` remain for drafts. A line discussion root
 *   with replies cannot be deleted, since GitHub would remove the entire discussion.
 * - no reactive updates: one poller per host, one GraphQL request for metadata and threads per tick.
 */

/** Shared poller interval. Each tick costs GraphQL points, so polling more often is not worthwhile. */
const POLL_INTERVAL_MS = 15_000;

const WEB_BASE_URL = 'https://github.com';

/** GitHub returns no more than this many files in the list. Beyond that, the diff would be silently truncated. */
const MAX_PR_FILES = 3000;

/**
 * Content limit for "Expand context". Expanding files this large is pointless,
 * since the UI already collapses diffs longer than 2000 lines.
 */
const MAX_CONTENT_BYTES = 2_000_000;

/** GitHub checks 3 CODEOWNERS locations and uses the first found (`docs/research/github-api.md`). */
const CODEOWNERS_PATHS = {
    githubDir: '.github/CODEOWNERS',
    root: 'CODEOWNERS',
    docsDir: 'docs/CODEOWNERS',
} as const;

/** Team list page limit. At 100 per page, this is well above how many teams a person can have. */
const MAX_TEAM_PAGES = 10;

/** Text appended to a lens `note` when the reviewer teams remain unknown. */
const TEAMS_UNKNOWN_NOTE =
    'GitHub did not tell which teams you are in (read:org scope?): ownership by team is not counted.';

const CAPABILITIES: Omit<HostCapabilities, 'publishVerdicts'> = {
    fileViewedSync: true,
    fileContent: true,
    // GitHub has no separate "comment requires a reply" status, only thread resolution.
    commentIssues: false,
    // Resolves the entire thread. GitHub cannot resolve individual comments.
    commentResolve: false,
    // The flag depends on reviewer identity. The header is never returned without `viewer` (`viewerUser`).
    editPublished: true,
    iterations: false,
    blobs: true,
};

const CHANGE_TYPES: Readonly<Record<string, FileDiff['changeType']>> = {
    added: 'add',
    removed: 'delete',
    renamed: 'move',
    copied: 'copy',
    modified: 'modify',
    changed: 'modify',
    unchanged: 'modify',
};

export interface GithubHostOptions {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
    readonly client?: GithubClient;
    readonly fetch?: FetchLike;
    readonly token?: () => Promise<string>;
    readonly baseUrl?: string;
    readonly pollIntervalMs?: number;
    /** Draft retry map, stored in process memory by default. */
    readonly idempotency?: IdempotencyStore;
    /** Client retries and delays. Tests need zero delays. */
    readonly transport?: Omit<GithubClientOptions, 'token' | 'fetch' | 'baseUrl'>;
}

/** Data that lives for exactly one iteration. A new branch head clears the entire cache. */
interface IterationCache {
    readonly headRefOid: string;
    mergeBase?: Promise<string>;
    diff?: Promise<PrDiff>;
    ownership?: OwnershipCache;
}

/** The ownership lens was read at this head/base pair. The base can move without a push. */
interface OwnershipCache {
    readonly baseRefOid: string;
    readonly lens: Promise<Lens>;
}

/** Parsed CODEOWNERS at the base commit. `null` in `rules` means the file is absent. */
interface CodeownersCache {
    readonly baseRefOid: string;
    readonly rules: Promise<readonly CodeownersRule[] | null>;
}

/** A value marked as incomplete. Returned externally, but never cached. */
interface Degradable<T> {
    readonly value: T;
    readonly degraded: boolean;
}

/** Header cache entry. `headRefOid` is known after the response. */
interface MetaCache {
    readonly promise: Promise<GithubPrMeta>;
    headRefOid: string | null;
    confirmedAt: number;
}

/** The comment being written: its parsed id and the comment itself from a fresh snapshot. */
interface CommentTarget {
    readonly parsed: ParsedCommentId;
    readonly comment: Comment;
}

/** Tick result returned by one polling GraphQL request. */
interface TickSnapshot {
    readonly meta: GithubPrMeta;
    readonly reviews: readonly GithubReview[];
    readonly threads: Thread[];
}

type PollHandler = (tick: TickSnapshot | null, alive: () => boolean) => Promise<void>;

interface PollSubscription {
    readonly handler: PollHandler;
    stopped: boolean;
    /** The initial tick for this subscription has already completed. */
    served: boolean;
}

export class GithubHost implements ReviewHost {
    readonly ownershipSource = 'CODEOWNERS';

    private readonly owner: string;
    private readonly repo: string;
    private readonly number: number;
    private readonly client: GithubClient;
    private readonly idempotency: IdempotencyStore;
    private readonly pollIntervalMs: number;

    private readonly pollSubscriptions = new Set<PollSubscription>();
    private pollTimer: NodeJS.Timeout | null = null;
    private polling = false;
    private tickRequested = false;

    private metaCache: MetaCache | null = null;
    private cache: IterationCache | null = null;
    private codeowners: CodeownersCache | null = null;
    /** Reviewer teams by organization list (keyed by the sorted list). */
    private readonly teams = new Map<string, Promise<Degradable<ReadonlySet<string>>>>();
    /** Token owner. A null promise means it has not been requested yet. */
    private viewer: Promise<ReviewUser> | null = null;

    /**
     * Pending review write queue. The review body is shared. Appending a paragraph requires
     * reading, editing and writing the entire body, so overlapping cycles would overwrite each other.
     * Creating the pending review uses this queue too, otherwise concurrent drafts would create it twice.
     */
    private reviewWrites: Promise<unknown> = Promise.resolve();

    /** Image side sizes by `ImageSide.blobId`, used to enforce the `getBlob` limit. */
    private readonly imageBlobs = new Map<string, number>();

    constructor(options: GithubHostOptions) {
        this.owner = options.owner;
        this.repo = options.repo;
        this.number = options.number;
        this.idempotency = options.idempotency ?? memoryIdempotencyStore();
        this.client =
            options.client ??
            new GithubClient({
                token: options.token ?? (() => Promise.reject(new Error('GitHub token is not set'))),
                ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
                ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
                ...options.transport,
            });
        this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    }

    /** Token owner login. null means `viewer` did not respond. */
    currentUser(): Promise<string | null> {
        return this.viewerLogin();
    }

    async getPr(): Promise<PrMeta> {
        const [meta, viewer] = await Promise.all([this.meta(), this.viewerUser()]);
        return this.toPrMeta(meta, viewer);
    }

    /**
     * GitHub has one iteration, comparing the branch head against merge-base with the base branch.
     * The host has no diffsets to list and compare (`capabilities.iterations: false`).
     */
    async listIterations(): Promise<Iteration[]> {
        const meta = await this.meta();
        return [
            {
                diffId: meta.headRefOid,
                baseCommit: await this.mergeBase(meta),
                headCommit: meta.headRefOid,
                createdAt: isoTime(meta.updatedAt),
                status: 'active',
            },
        ];
    }

    async getDiff(slice?: { base: HostId; head: HostId }): Promise<PrDiff> {
        if (slice !== undefined) {
            throw new RpcFailure(
                'bad_request',
                'GitHub: this PR has one iteration, so there are no iterations to build a slice between.',
            );
        }
        return this.cachedDiff(await this.meta());
    }

    watchIterations(onChange: (iterations: Iteration[]) => void): () => void {
        let started = false;
        let lastHead: string | null = null;

        return this.subscribePoll(async (tick, alive) => {
            if (tick === null || (started && tick.meta.headRefOid === lastHead)) {
                return;
            }

            const iterations = await this.listIterations();
            started = true;
            lastHead = tick.meta.headRefOid;
            if (alive()) {
                onChange(iterations);
            }
        });
    }

    async getThreads(): Promise<Thread[]> {
        return (await this.loadTick()).threads;
    }

    /**
     * Polls instead of subscribing: one GraphQL request every `pollIntervalMs` for all subscribers.
     * Emits a snapshot only when it changes. A tick error does not terminate the subscription.
     */
    watchThreads(onChange: (threads: Thread[]) => void): () => void {
        let started = false;
        let last: string | null = null;

        return this.subscribePoll((tick, alive) => {
            if (tick === null) {
                return Promise.resolve();
            }
            const snapshot = JSON.stringify(tick.threads);
            if (started && snapshot === last) {
                return Promise.resolve();
            }
            started = true;
            last = snapshot;
            if (alive()) {
                onChange(tick.threads);
            }
            return Promise.resolve();
        });
    }

    /**
     * Review status changes use a host-specific subscription on the same tick, prompting the server
     * to reread metadata and discover that someone has already approved the PR.
     */
    watchStatus(onChange: () => void): () => void {
        let started = false;
        let last: string | null = null;

        return this.subscribePoll((tick, alive) => {
            if (tick === null) {
                return Promise.resolve();
            }
            const stamp = statusStampOf(tick.meta);
            if (started && stamp !== last && alive()) {
                onChange();
            }
            last = stamp;
            started = true;
            return Promise.resolve();
        });
    }

    /**
     * A draft goes straight into the GitHub pending review (two-stage model, `docs/product.md §3`).
     * The contract has 3 cases: an anchor creates a pending review thread, `parentId` replies to another thread,
     * neither appends a paragraph to the review body.
     *
     * GitHub does not support idempotency keys, so the adapter maintains the key-to-comment mapping
     * itself. Retrying a buffered draft returns the existing comment instead of creating a duplicate.
     */
    async saveDraft(draft: CommentDraft, options?: { idempotencyKey?: string }): Promise<Comment> {
        const parsed = commentDraftSchema.parse(draft);
        const key = options?.idempotencyKey;

        if (key !== undefined) {
            const known = this.idempotency.get(key);
            if (known !== null) {
                const existing = await this.findComment(known);
                if (existing !== null) {
                    return existing;
                }
            }
        }

        const created =
            parsed.parentId !== null
                ? await this.createReply(parsed.parentId, parsed.body)
                : parsed.anchor !== null
                  ? await this.createThreadDraft(parsed.anchor, parsed.body)
                  : await this.createBodyDraft(parsed.body);

        if (key !== undefined) {
            this.idempotency.set(key, created.id);
        }
        this.refreshSoon();
        return created;
    }

    /** Edits an own draft, either a pending review comment or a body paragraph. */
    async updateDraft(commentId: HostId, body: string): Promise<void> {
        const { parsed } = await this.parseForWrite(commentId, true);
        await this.writeComment(parsed, body);
        this.refreshSoon();
    }

    async deleteDraft(commentId: HostId): Promise<void> {
        await this.eraseComment(await this.parseForWrite(commentId, true));
        this.refreshSoon();
    }

    /**
     * Edits an own published comment. Editing a published review paragraph rewrites
     * the entire body, keeping Sherpa markers so paragraphs retain their numbers.
     * Ignores `issue`, since GitHub has no "requires a reply" status (`capabilities.commentIssues`).
     */
    async updateComment(commentId: HostId, body: string, _issue?: boolean): Promise<void> {
        const { parsed } = await this.parseForWrite(commentId, false);
        await this.writeComment(parsed, body);
        this.refreshSoon();
    }

    async deleteComment(commentId: HostId): Promise<void> {
        await this.eraseComment(await this.parseForWrite(commentId, false));
        this.refreshSoon();
    }

    /**
     * Comment id for a write, parsed and checked against state. The snapshot distinguishes a draft from
     * a published comment, rather than the id format. Both thread comments (`rc:`) and review body paragraphs (`rvb:`)
     * can be either. Returns the comment from the snapshot alongside the parsed id, since deletion
     * needs to know about replies.
     */
    private async parseForWrite(commentId: HostId, draft: boolean): Promise<CommentTarget> {
        const parsed = parseCommentId(commentId);
        if (parsed === null) {
            throw new RpcFailure('bad_request', `GitHub: unrecognized comment id ${commentId}.`);
        }

        const found = await this.findComment(commentId);
        if (found === null) {
            throw new RpcFailure('bad_request', `GitHub: comment ${commentId} is not in this PR's discussions.`);
        }
        if (found.draft !== draft) {
            throw new RpcFailure(
                'bad_request',
                draft
                    ? `GitHub: comment ${commentId} is already published. Edit and delete it as a published comment.`
                    : `GitHub: comment ${commentId} is still a draft. Edit and delete it as a draft.`,
            );
        }
        return { parsed, comment: found };
    }

    /** New comment text. The id kind determines the mutation. */
    private async writeComment(parsed: ParsedCommentId, body: string): Promise<void> {
        switch (parsed.kind) {
            case 'review-comment':
                await this.client.graphql(
                    UPDATE_REVIEW_COMMENT_MUTATION,
                    { commentId: parsed.nodeId, body },
                    commentMutationSchema,
                );
                return;
            case 'issue-comment':
                await this.client.graphql(
                    UPDATE_ISSUE_COMMENT_MUTATION,
                    { commentId: parsed.nodeId, body },
                    commentMutationSchema,
                );
                return;
            case 'review-body':
                await this.withReviewLock(() => this.writeReviewBody(parsed.nodeId, body));
                return;
            case 'review-paragraph':
                await this.rewriteParagraph(parsed.nodeId, parsed.n, body);
                return;
        }
    }

    private async eraseComment({ parsed, comment }: CommentTarget): Promise<void> {
        switch (parsed.kind) {
            case 'review-comment':
                // GitHub deletes a discussion root together with its thread, which would also remove other users' replies.
                if (comment.replies.length > 0) {
                    throw new RpcFailure(
                        'bad_request',
                        'GitHub deletes the entire line discussion. This comment starts the discussion, and deleting it would also remove the replies. Delete the replies first.',
                    );
                }
                await this.client.graphql(
                    DELETE_REVIEW_COMMENT_MUTATION,
                    { commentId: parsed.nodeId },
                    commentMutationSchema,
                );
                return;
            case 'issue-comment':
                await this.client.graphql(
                    DELETE_ISSUE_COMMENT_MUTATION,
                    { commentId: parsed.nodeId },
                    commentMutationSchema,
                );
                return;
            case 'review-body':
                throw new RpcFailure(
                    'bad_request',
                    'GitHub cannot delete review text. It can only be rewritten.',
                );
            case 'review-paragraph':
                await this.rewriteParagraph(parsed.nodeId, parsed.n, null);
                return;
        }
    }

    /** GitHub resolves only discussions on diff lines, not review bodies or PR comments. */
    async setThreadResolved(threadId: HostId, resolved: boolean): Promise<void> {
        const nodeId = parseThreadId(threadId);
        if (nodeId === null) {
            throw new RpcFailure(
                'bad_request',
                'GitHub resolves only discussions on diff lines. A PR discussion cannot be closed this way.',
            );
        }

        if (resolved) {
            await this.client.graphql(RESOLVE_THREAD_MUTATION, { threadId: nodeId }, resolveThreadMutationSchema);
        } else {
            await this.client.graphql(UNRESOLVE_THREAD_MUTATION, { threadId: nodeId }, unresolveThreadMutationSchema);
        }
        this.refreshSoon();
    }

    /**
     * Batch publication uses one `submitPullRequestReview`. All pending review drafts go out
     * with the verdict, with no partial success on GitHub. If submission fails, all drafts go into `failed`,
     * the verdict remains unapplied, and the pending review stays available for retry.
     */
    async publishBatch(verdict: Verdict): Promise<PublishResult> {
        const parsed = verdictSchema.parse(verdict);
        if (parsed === 'sticky_ship') {
            throw new RpcFailure('bad_request', 'GitHub has no sticky ship. Approval lasts until the next push.');
        }
        const [meta, viewer] = await Promise.all([this.meta(), this.viewerUser()]);
        if (!publishVerdictsOf(meta, viewer.login).includes(parsed)) {
            throw new RpcFailure(
                'bad_request',
                'GitHub does not allow approving or requesting changes on your own PR. You can only publish comments.',
            );
        }
        const event = REVIEW_EVENTS[parsed];

        // Shares the body edit queue. Submitting while a paragraph is being written would lose its text.
        const result = await this.withReviewLock(() => this.submitVerdict(event));
        this.refreshSoon();
        return result;
    }

    private async submitVerdict(event: ReviewEvent): Promise<PublishResult> {
        const tick = await this.loadTick();
        const pending = await this.pendingReviewOf(tick.reviews);
        const drafts = pending === null ? [] : draftIdsOf(tick.threads);
        // Without drafts there is nothing to publish. Leave a pending review with only a body placeholder as it is.
        if (event === 'COMMENT' && drafts.length === 0) {
            return { publishedCommentIds: [], failed: [], verdictApplied: true };
        }
        if (pending === null) {
            const meta = await this.meta();
            await this.client.graphql(
                VERDICT_REVIEW_MUTATION,
                { pullRequestId: meta.id, commitOID: meta.headRefOid, event },
                verdictMutationSchema,
            );
            return { publishedCommentIds: [], failed: [], verdictApplied: true };
        }

        try {
            await this.client.graphql(
                SUBMIT_REVIEW_MUTATION,
                { reviewId: pending.id, event, body: publishedBodyOf(pending.body) },
                submitReviewMutationSchema,
                1,
            );
        } catch (error) {
            const message = messageOf(error);
            return {
                publishedCommentIds: [],
                failed: drafts.map((commentId) => ({ commentId, message })),
                verdictApplied: false,
            };
        }

        return { publishedCommentIds: drafts, failed: [], verdictApplied: true };
    }

    /**
     * Synchronizes viewed marks with GitHub. After success, updates only the affected part of the cached diff,
     * since the host state is known exactly and rereading the file list for one flag is expensive.
     */
    async setFileViewed(fileId: HostId, viewed: boolean): Promise<void> {
        const meta = await this.meta();
        await this.client.graphql(
            viewed ? MARK_FILE_VIEWED_MUTATION : UNMARK_FILE_VIEWED_MUTATION,
            { pullRequestId: meta.id, path: fileId },
            viewedMutationSchema,
        );
        await this.rememberViewed(meta.headRefOid, fileId, viewed);
    }

    /**
     * File content on both sides for "Expand context" (`docs/design/SPEC-elements.md §2.13`).
     * Reads both sides in one request at `<commit>:<path>`, the old side at merge-base,
     * the new side at the branch head.
     *
     * `null` describes the file itself (`getFileContent` contract): binary, an image or
     * too large. A failed call raises an error instead of returning null.
     */
    async getFileContent(fileId: HostId): Promise<FileContent | null> {
        const meta = await this.meta();
        const diff = await this.cachedDiff(meta);
        const file = diff.files.find((candidate) => candidate.fileId === fileId);
        if (file === undefined) {
            throw new RpcFailure('bad_request', `GitHub: file ${fileId} is not in this PR's diff.`);
        }
        // An image has no text context to expand. Even svg is displayed as a card.
        if (file.binary || file.image !== null) {
            return null;
        }

        const mergeBase = await this.mergeBase(meta);
        const response = await this.client.graphql(
            FILE_CONTENT_QUERY,
            {
                owner: this.owner,
                repo: this.repo,
                oldExpression: blobExpression(mergeBase, file.oldPath ?? file.path),
                newExpression: blobExpression(meta.headRefOid, file.path),
            },
            fileContentResponseSchema,
        );

        const repository = response.repository;
        if (repository === null) {
            return null;
        }
        const oldText = sideTextOf(repository.old);
        const newText = sideTextOf(repository.new);
        if (oldText === undefined || newText === undefined) {
            return null;
        }
        return { oldText, newText };
    }

    /**
     * Image-side bytes. `blobId` is a `<commit>:<path>` address, with the size known from the diff:
     * a side beyond the contract limit is never read, nor is an unknown address.
     */
    async getBlob(blobId: HostId): Promise<Uint8Array | null> {
        const parsed = parseBlobId(blobId);
        if (parsed === null) {
            return null;
        }

        let size = this.imageBlobs.get(blobId);
        if (size === undefined) {
            // The blob may come from a diff this process has not read yet.
            await this.cachedDiff(await this.meta());
            size = this.imageBlobs.get(blobId);
        }
        if (size === undefined || size > IMAGE_BLOB_MAX_BYTES) {
            return null;
        }

        return this.client.restBytes(`/repos/${this.owner}/${this.repo}/contents/${encodePath(parsed.path)}`, {
            query: { ref: parsed.sha },
            headers: { accept: 'application/vnd.github.raw+json' },
        });
    }

    /**
     * The "My files" lens uses CODEOWNERS from the base branch. The last matching
     * rule names the file owners. PR zones are the static boundaries of these rules. A file without a rule or
     * with a rule that clears ownership stays outside the zones.
     *
     * The cache uses the branch head (a push changes the diff files) and the base commit. If the base advances,
     * another CODEOWNERS file may have changed the owners while the head stayed still. An incomplete
     * response (CODEOWNERS could not be read or teams could not be listed) does not stay in the cache.
     * The next call tries again.
     */
    async ownershipLens(): Promise<Lens | null> {
        const meta = await this.meta();
        const cache = this.iteration(meta.headRefOid);
        const known = cache.ownership;
        if (known?.baseRefOid === meta.baseRefOid) {
            return known.lens;
        }

        const entry: OwnershipCache = {
            baseRefOid: meta.baseRefOid,
            lens: this.loadOwnership(meta).then(
                (result) => {
                    if (result.degraded) {
                        this.forgetOwnership(cache, entry);
                    }
                    return result.value;
                },
                (error: unknown) => {
                    this.forgetOwnership(cache, entry);
                    throw error;
                },
            ),
        };
        cache.ownership = entry;
        return entry.lens;
    }

    /** Remove this exact entry from the iteration cache. Another call may have replaced it during the request. */
    private forgetOwnership(cache: IterationCache, entry: OwnershipCache): void {
        if (cache.ownership === entry) {
            delete cache.ownership;
        }
    }

    extraLenses(): Promise<Lens[]> {
        return Promise.resolve([]);
    }

    private async loadOwnership(meta: GithubPrMeta): Promise<Degradable<Lens>> {
        let rules: readonly CodeownersRule[] | null;
        try {
            rules = await this.codeownersRules(meta.baseRefOid);
        } catch (error) {
            // The reviewer gets a message about the file. The cause (query name, response code) goes to server.log.
            process.stderr.write(`sherpa-review-server: GitHub did not return CODEOWNERS: ${messageOf(error)}\n`);
            return degraded(mineLens([], 'GitHub could not read the CODEOWNERS file of this repository.', null));
        }
        // GitHub has ownership even without the file. The lens is disabled with an explanation instead of disappearing.
        if (rules === null) {
            return settled(mineLens([], 'This repository has no CODEOWNERS file.', null));
        }
        if (rules.length === 0) {
            return settled(mineLens([], 'CODEOWNERS has no rules.', null));
        }

        const [diff, viewer] = await Promise.all([this.cachedDiff(meta), this.viewerUser()]);
        const owned = diff.files.map((file) => ({ path: file.path, rule: ownersOf(rules, file.path) }));
        const teams = await this.myTeams(viewer.login, orgsOf(owned));

        const mine = (rule: CodeownersRule): boolean => isMine(rule, viewer.login, teams.value);
        const paths = owned.filter((entry) => entry.rule !== null && mine(entry.rule)).map((entry) => entry.path);
        // Other owners' zones stay even with none of my files, so the reviewer can see who owns the PR.
        const value = mineLens(paths, ownershipNote(paths.length === 0, teams.degraded), ownershipZones(owned, mine));
        return teams.degraded ? degraded(value) : settled(value);
    }

    /**
     * CODEOWNERS rules from the base branch. `null` means the file is absent from all 3 locations.
     * The cache uses the base commit, which determines the file used to resolve owners.
     */
    private codeownersRules(baseRefOid: string): Promise<readonly CodeownersRule[] | null> {
        const cached = this.codeowners;
        if (cached !== null && cached.baseRefOid === baseRefOid) {
            return cached.rules;
        }

        const entry: CodeownersCache = { baseRefOid, rules: this.loadCodeowners(baseRefOid) };
        this.codeowners = entry;
        entry.rules.catch(() => {
            // Do not cache a failed read. The lens loses functionality for this call only.
            if (this.codeowners === entry) {
                this.codeowners = null;
            }
        });
        return entry.rules;
    }

    private async loadCodeowners(baseRefOid: string): Promise<readonly CodeownersRule[] | null> {
        const response = await this.client.graphql(
            CODEOWNERS_QUERY,
            {
                owner: this.owner,
                repo: this.repo,
                githubDir: blobExpression(baseRefOid, CODEOWNERS_PATHS.githubDir),
                root: blobExpression(baseRefOid, CODEOWNERS_PATHS.root),
                docsDir: blobExpression(baseRefOid, CODEOWNERS_PATHS.docsDir),
            },
            codeownersResponseSchema,
        );
        const repository = response.repository;
        if (repository === null) {
            throw this.prNotFound();
        }

        // Locations follow GitHub's order. The first file found wins.
        const text = repository.githubDir?.text ?? repository.root?.text ?? repository.docsDir?.text ?? null;
        return text === null ? null : parseCodeowners(text);
    }

    /**
     * The reviewer's teams in owner organizations, as a set of lowercase `org/slug` values.
     * The cache lasts for the host's lifetime, with one PR and one reviewer. An incomplete response (missing `read:org` scope,
     * an inaccessible organization) is not cached.
     */
    private myTeams(viewer: string, orgs: readonly string[]): Promise<Degradable<ReadonlySet<string>>> {
        if (orgs.length === 0) {
            return Promise.resolve(settled<ReadonlySet<string>>(new Set()));
        }

        const key = [...orgs].sort().join(',');
        const cached = this.teams.get(key);
        if (cached !== undefined) {
            return cached;
        }

        const pending = this.loadMyTeams(viewer, orgs);
        this.teams.set(key, pending);
        void pending.then(
            (result) => {
                if (result.degraded) {
                    this.teams.delete(key);
                }
            },
            () => {
                this.teams.delete(key);
            },
        );
        return pending;
    }

    /**
     * Teams from all organizations in one aliased query. Further pages use the same query
     * for the remaining organizations. Failure reduces functionality instead of raising an error. The lens uses logins.
     */
    private async loadMyTeams(viewer: string, orgs: readonly string[]): Promise<Degradable<ReadonlySet<string>>> {
        const teams = new Set<string>();
        let pending = orgs.map((org, index) => ({ alias: `o${String(index)}`, org, after: null as string | null }));
        let degradedAnswer = false;

        for (let page = 0; pending.length > 0 && page < MAX_TEAM_PAGES; page += 1) {
            const aliases = pending.map((entry) => entry.alias);
            const variables: Record<string, unknown> = { viewer };
            for (const entry of pending) {
                variables[entry.alias] = entry.org;
                variables[`${entry.alias}After`] = entry.after;
            }

            let response: Record<string, GithubOrgTeams>;
            try {
                response = await this.client.graphql(
                    orgTeamsQuery(aliases),
                    variables,
                    orgTeamsResponseSchema(aliases),
                );
            } catch (error) {
                process.stderr.write(
                    `sherpa-review-server: GitHub did not list the reviewer's teams: ${messageOf(error)}. Ownership is resolved by login\n`,
                );
                return degraded(teams);
            }

            const next: typeof pending = [];
            for (const entry of pending) {
                const node = response[entry.alias] ?? null;
                if (node === null) {
                    // The token cannot see the organization, so its teams do not count as mine.
                    degradedAnswer = true;
                    continue;
                }
                for (const team of compact(node.teams.nodes)) {
                    teams.add(`${entry.org}/${team.slug}`.toLowerCase());
                }
                if (node.teams.pageInfo.hasNextPage) {
                    next.push({ ...entry, after: node.teams.pageInfo.endCursor });
                }
            }
            pending = next;
        }

        return pending.length > 0 || degradedAnswer ? degraded(teams) : settled(teams);
    }

    private toPrMeta(meta: GithubPrMeta, viewer: ReviewUser): PrMeta {
        const headOwner = meta.headRepositoryOwner?.login ?? null;
        return {
            id: String(meta.number),
            url: meta.url,
            title: meta.title,
            author: userOf(meta.author),
            // A fork branch includes its owner. In the same repository, this would only add noise.
            fromBranch:
                headOwner === null || headOwner === this.owner ? meta.headRefName : `${headOwner}:${meta.headRefName}`,
            toBranch: meta.baseRefName,
            state: meta.merged ? 'merged' : meta.state === 'OPEN' ? 'open' : 'closed',
            // GitHub's own status wording. The UI shows it unchanged (`statusLabel` contract).
            statusLabel: meta.isDraft ? 'draft' : meta.state.toLowerCase(),
            checks: checksOf(meta),
            updatedAt: isoTime(meta.updatedAt),
            capabilities: { ...CAPABILITIES, publishVerdicts: publishVerdictsOf(meta, viewer.login) },
            verdicts: verdictsOf(meta),
            viewer,
        };
    }

    /**
     * Cached PR header. An entry lives while polling ticks confirm it. There is no cache without polling.
     * The contract promises that after a push, `getDiff` returns the new head even without subscriptions.
     */
    private meta(): Promise<GithubPrMeta> {
        const cached = this.metaCache;
        if (cached !== null && this.pollTimer !== null && Date.now() - cached.confirmedAt < this.pollIntervalMs) {
            return cached.promise;
        }

        const entry: MetaCache = { promise: this.fetchMeta(), headRefOid: null, confirmedAt: Date.now() };
        this.metaCache = entry;
        entry.promise.then(
            (meta) => {
                entry.headRefOid = meta.headRefOid;
            },
            () => {
                if (this.metaCache === entry) {
                    this.metaCache = null;
                }
            },
        );
        return entry.promise;
    }

    private async fetchMeta(): Promise<GithubPrMeta> {
        const response = await this.client.graphql(
            PR_QUERY,
            { owner: this.owner, repo: this.repo, number: this.number },
            prResponseSchema,
        );
        const pr = response.repository?.pullRequest ?? null;
        if (pr === null) {
            throw this.prNotFound();
        }
        return pr;
    }

    /** A polling tick refreshes the header, so no separate request is needed afterwards. */
    private rememberMeta(meta: GithubPrMeta): void {
        this.metaCache = { promise: Promise.resolve(meta), headRefOid: meta.headRefOid, confirmedAt: Date.now() };
    }

    /**
     * The full token owner is the reviewer's identity in the PR header (`PrMeta.viewer`). Errors here
     * propagate out. This host always sets `capabilities.editPublished`, which depends
     * on a known identity. Without it, there is nothing to compare ownership against, so the header would be false.
     */
    private viewerUser(): Promise<ReviewUser> {
        this.viewer ??= this.client.graphql(VIEWER_QUERY, {}, viewerResponseSchema).then(
            (response) => ({
                login: response.viewer.login,
                displayName: response.viewer.name ?? null,
                // `viewer` owns Sherpa's token. A person does the review, not a bot.
                bot: false,
                avatarUrl: avatarOf(response.viewer.avatarUrl),
            }),
            (error: unknown) => {
                // Do not cache a failed response. The next call asks again.
                this.viewer = null;
                throw new RpcFailure('host_unavailable', `GitHub did not identify the token owner: ${messageOf(error)}`);
            },
        );
        return this.viewer;
    }

    /**
     * The token owner's login. null means `viewer` did not respond. A lenient variant for polling and finding
     * pending reviews, where an unknown identity only weakens draft labels without misrepresenting permissions.
     */
    private viewerLogin(): Promise<string | null> {
        return this.viewerUser().then(
            (user) => user.login,
            (error: unknown) => {
                process.stderr.write(`sherpa-review-server: ${messageOf(error)}\n`);
                return null;
            },
        );
    }

    /** All PR state in one query: header, diff threads, reviews and PR comments. */
    private async loadTick(): Promise<TickSnapshot> {
        const [viewer, response] = await Promise.all([
            this.viewerLogin(),
            this.client.graphql(
                TICK_QUERY,
                { owner: this.owner, repo: this.repo, number: this.number, threadCursor: null },
                tickResponseSchema,
            ),
        ]);

        const pr = response.repository?.pullRequest ?? null;
        if (pr === null) {
            throw this.prNotFound();
        }

        const threadNodes = compact(pr.reviewThreads.nodes);
        let page = pr.reviewThreads.pageInfo;
        while (page.hasNextPage) {
            const next = await this.client.graphql(
                THREADS_PAGE_QUERY,
                { owner: this.owner, repo: this.repo, number: this.number, threadCursor: page.endCursor },
                threadsPageResponseSchema,
            );
            const connection = next.repository?.pullRequest?.reviewThreads;
            if (connection === undefined) {
                break;
            }
            threadNodes.push(...compact(connection.nodes));
            page = connection.pageInfo;
        }

        const threads = await Promise.all(threadNodes.map((thread) => this.withAllComments(thread)));
        const reviews = compact(pr.reviews.nodes);
        return {
            meta: pr,
            reviews,
            threads: buildThreads({ threads, reviews, comments: compact(pr.comments.nodes), viewer }),
        };
    }

    /** Read the remaining comments in a thread with more than 10 replies, or replies would silently disappear. */
    private async withAllComments(thread: GithubReviewThread): Promise<GithubReviewThread> {
        if (!thread.comments.pageInfo.hasNextPage) {
            return thread;
        }

        const nodes = compact(thread.comments.nodes);
        let page = thread.comments.pageInfo;
        while (page.hasNextPage) {
            const next = await this.client.graphql(
                THREAD_COMMENTS_QUERY,
                { threadId: thread.id, commentCursor: page.endCursor },
                threadCommentsResponseSchema,
            );
            const connection = next.node?.comments;
            if (connection === undefined) {
                break;
            }
            nodes.push(...compact(connection.nodes));
            page = connection.pageInfo;
        }
        return { ...thread, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
    }

    private async cachedDiff(meta: GithubPrMeta): Promise<PrDiff> {
        const cache = this.iteration(meta.headRefOid);
        cache.diff ??= this.loadDiff(meta).catch((error: unknown) => {
            this.forget(cache);
            throw error;
        });
        return cache.diff;
    }

    private async loadDiff(meta: GithubPrMeta): Promise<PrDiff> {
        const [files, viewed, mergeBase] = await Promise.all([
            this.client.restList(`/repos/${this.owner}/${this.repo}/pulls/${String(this.number)}/files`, restFilesSchema, {
                query: { per_page: 100 },
            }),
            this.loadViewed(),
            this.mergeBase(meta),
        ]);

        if (files.length >= MAX_PR_FILES) {
            throw new RpcFailure(
                'host_unavailable',
                `GitHub returns at most ${String(MAX_PR_FILES)} PR files, and this PR has at least that many. The diff would be incomplete.`,
            );
        }

        const [sizes, binaries] = await Promise.all([
            this.loadImageSizes(files, meta.headRefOid, mergeBase),
            this.loadBinaryFlags(files, meta.headRefOid, mergeBase),
        ]);
        return {
            diffId: meta.headRefOid,
            baseCommit: mergeBase,
            headCommit: meta.headRefOid,
            files: files.map((file) => this.toFileDiff(file, meta.headRefOid, mergeBase, viewed, sizes, binaries)),
        };
    }

    private toFileDiff(
        file: GithubRestFile,
        headRefOid: string,
        mergeBase: string,
        viewed: ReadonlyMap<string, boolean>,
        sizes: ReadonlyMap<string, number>,
        binaries: ReadonlySet<string>,
    ): FileDiff {
        const path = file.filename;
        const changeType = CHANGE_TYPES[file.status] ?? 'modify';
        const patch = file.patch ?? null;

        return {
            fileId: path,
            path,
            oldPath: file.previous_filename ?? null,
            changeType,
            // Binary status is known only for files without a patch. The list has no other files.
            binary: binaries.has(path),
            // GitHub has no concept of a file excluded from review. CODEOWNERS describes owners, not reviews.
            generated: false,
            additions: file.additions,
            deletions: file.deletions,
            patch,
            viewed: viewed.get(path) ?? false,
            blameUrl:
                changeType === 'delete' ? null : `${WEB_BASE_URL}/${this.owner}/${this.repo}/blame/${headRefOid}/${encodePath(path)}`,
            hostFileUrl: `${WEB_BASE_URL}/${this.owner}/${this.repo}/pull/${String(this.number)}/files#diff-${sha256(path)}`,
            image: imageOf(file, changeType, headRefOid, mergeBase, sizes),
        };
    }

    /** Viewed marks are absent from the REST file list. They exist only in GraphQL. */
    private async loadViewed(): Promise<Map<string, boolean>> {
        const viewed = new Map<string, boolean>();
        let cursor: string | null = null;

        for (;;) {
            const response: GithubFilesResponse = await this.client.graphql(
                FILES_QUERY,
                { owner: this.owner, repo: this.repo, number: this.number, fileCursor: cursor },
                filesResponseSchema,
            );
            const connection = response.repository?.pullRequest?.files;
            if (connection === undefined) {
                return viewed;
            }
            for (const node of compact(connection.nodes)) {
                viewed.set(node.path, node.viewerViewedState === 'VIEWED');
            }
            if (!connection.pageInfo.hasNextPage) {
                return viewed;
            }
            cursor = connection.pageInfo.endCursor;
        }
    }

    /**
     * Image-side sizes in one aliased query. The `ImageSide` contract requires
     * sizes, and individual queries would cost one point per side.
     */
    private async loadImageSizes(
        files: readonly GithubRestFile[],
        headRefOid: string,
        mergeBase: string,
    ): Promise<Map<string, number>> {
        const expressions = new Map<string, string>();
        for (const file of files) {
            if (imageMimeOf(file.filename) === null) {
                continue;
            }
            const changeType = CHANGE_TYPES[file.status] ?? 'modify';
            if (changeType !== 'add') {
                const before = blobExpression(mergeBase, file.previous_filename ?? file.filename);
                expressions.set(before, before);
            }
            if (changeType !== 'delete') {
                const after = blobExpression(headRefOid, file.filename);
                expressions.set(after, after);
            }
        }

        const sizes = new Map<string, number>();
        if (expressions.size === 0) {
            return sizes;
        }

        const blobIds = [...expressions.keys()];
        const aliases = blobIds.map((_, index) => `b${String(index)}`);
        const variables: Record<string, unknown> = { owner: this.owner, repo: this.repo };
        aliases.forEach((alias, index) => {
            variables[alias] = blobIds[index];
        });

        const response = await this.client.graphql(blobSizesQuery(aliases), variables, blobAliasesResponseSchema);
        const repository = response.repository;
        if (repository === null) {
            return sizes;
        }
        aliases.forEach((alias, index) => {
            const blobId = blobIds[index];
            const byteSize = repository[alias]?.byteSize;
            if (blobId !== undefined && byteSize !== undefined) {
                sizes.set(blobId, byteSize);
                this.imageBlobs.set(blobId, byteSize);
            }
        });
        return sizes;
    }

    /**
     * Binary files among those for which REST returned no patch. The file list has no binary flag,
     * and statistics cannot determine it. A pure rename has zero statistics, just like a binary file, so
     * a regular `.ts` would reach the UI as "binary file not shown". Query the blob itself:
     * the old side at merge-base for deleted files, the new side at the branch head for others.
     *
     * One query for the whole diff, only when such files exist. If the blob is missing or the query
     * fails, treat the file as text. Text without a patch is more honest than a false binary label.
     */
    private async loadBinaryFlags(
        files: readonly GithubRestFile[],
        headRefOid: string,
        mergeBase: string,
    ): Promise<Set<string>> {
        const binary = new Set<string>();
        const asked = files
            .filter((file) => file.patch === undefined)
            .map((file, index) => ({
                alias: `b${String(index)}`,
                path: file.filename,
                expression:
                    (CHANGE_TYPES[file.status] ?? 'modify') === 'delete'
                        ? blobExpression(mergeBase, file.previous_filename ?? file.filename)
                        : blobExpression(headRefOid, file.filename),
            }));
        if (asked.length === 0) {
            return binary;
        }

        const variables: Record<string, unknown> = { owner: this.owner, repo: this.repo };
        for (const entry of asked) {
            variables[entry.alias] = entry.expression;
        }

        const blobs = await this.client
            .graphql(
                blobBinaryQuery(asked.map((entry) => entry.alias)),
                variables,
                blobAliasesResponseSchema,
            )
            .then(
                (response) => response.repository,
                (error: unknown) => {
                    process.stderr.write(
                        `sherpa-review-server: GitHub did not say whether files without patches are binary: ${messageOf(error)}\n`,
                    );
                    return null;
                },
            );
        if (blobs === null) {
            return binary;
        }

        for (const entry of asked) {
            if (blobs[entry.alias]?.isBinary === true) {
                binary.add(entry.path);
            }
        }
        return binary;
    }

    /** Comparison base. GraphQL does not return merge-base, so this is the sole REST endpoint used for it. */
    private mergeBase(meta: GithubPrMeta): Promise<string> {
        const cache = this.iteration(meta.headRefOid);
        cache.mergeBase ??= this.client
            .rest(
                `/repos/${this.owner}/${this.repo}/compare/${meta.baseRefOid}...${meta.headRefOid}`,
                compareSchema,
            )
            .then((response) => response.merge_base_commit.sha)
            .catch((error: unknown) => {
                this.forget(cache);
                throw error;
            });
        return cache.mergeBase;
    }

    /**
     * A viewed mark in the cached diff. Rebuild files instead of editing them in place:
     * a `PrDiff` already returned to a caller must not be mutated.
     */
    private async rememberViewed(headRefOid: string, fileId: HostId, viewed: boolean): Promise<void> {
        const cache = this.cache;
        if (cache?.headRefOid !== headRefOid || cache.diff === undefined) {
            return;
        }

        const pending = cache.diff;
        const current = await pending.catch(() => null);
        // While waiting, the head may have moved and the diff left the cache. Then there is nothing to update.
        if (current === null || cache.diff !== pending) {
            return;
        }
        const files = current.files.map((file) => (file.fileId === fileId ? { ...file, viewed } : file));
        cache.diff = Promise.resolve({ ...current, files });
    }

    /** The token owner's pending review. null means none exists, and the first draft creates one. */
    private async pendingReviewOf(reviews: readonly GithubReview[]): Promise<GithubReview | null> {
        const viewer = await this.viewerLogin();
        return (
            reviews.find(
                (review) => review.state === 'PENDING' && (viewer === null || review.author?.login === viewer),
            ) ?? null
        );
    }

    /**
     * Write to the pending review one operation at a time. The queue is a promise chain. A failed write
     * does not fail the next one, but the next one still waits its turn.
     */
    private withReviewLock<T>(action: () => Promise<T>): Promise<T> {
        const result = this.reviewWrites.then(action);
        // The queue preserves order without preserving failure. A failed write does not fail the next one.
        this.reviewWrites = result.catch(() => null);
        return result;
    }

    /** The pending review to write to. Create it lazily at the current branch head if absent. */
    private ensurePendingReview(): Promise<GithubReview> {
        return this.withReviewLock(() => this.ensurePendingReviewUnderLock());
    }

    /**
     * The same for calls already holding the write queue. A review created here always
     * has a nonempty body, since GitHub cannot add a body to a review created without one.
     */
    private async ensurePendingReviewUnderLock(): Promise<GithubReview> {
        const tick = await this.loadTick();
        const existing = await this.pendingReviewOf(tick.reviews);
        if (existing !== null) {
            return existing;
        }

        const meta = await this.meta();
        const response = await this.client.graphql(
            CREATE_REVIEW_MUTATION,
            { pullRequestId: meta.id, commitOID: meta.headRefOid, body: BODY_PLACEHOLDER },
            reviewMutationSchema,
            1,
        );
        const created = response.addPullRequestReview?.pullRequestReview ?? null;
        if (created === null) {
            throw new RpcFailure('host_unavailable', 'GitHub did not create a draft review for this PR.');
        }
        return created;
    }

    private async createThreadDraft(anchor: FileAnchor, body: string): Promise<Comment> {
        const review = await this.ensurePendingReview();
        const position = anchor.position;
        const side = position?.side === 'old' ? 'LEFT' : 'RIGHT';
        const multiline = position !== null && position.size > 1;

        return this.createWithDedup(
            async () => {
                const response = await this.client.graphql(
                    ADD_REVIEW_THREAD_MUTATION,
                    {
                        reviewId: review.id,
                        path: anchor.path,
                        body,
                        line: position === null ? null : position.line + position.size - 1,
                        side: position === null ? null : side,
                        startLine: multiline ? position.line : null,
                        startSide: multiline ? side : null,
                        subjectType: position === null ? 'FILE' : 'LINE',
                    },
                    addReviewThreadMutationSchema,
                    1,
                );
                const node = compact(response.addPullRequestReviewThread?.thread?.comments.nodes ?? null)[0];
                if (node === undefined) {
                    throw new RpcFailure('host_unavailable', 'GitHub did not return the created comment.');
                }
                return toDiffComment(node);
            },
            async () => {
                const threads = (await this.loadTick()).threads;
                const found = threads.find(
                    (thread) =>
                        thread.anchor?.path === anchor.path &&
                        thread.root.draft &&
                        thread.root.body === body &&
                        samePosition(thread.anchor.position, position),
                );
                return found?.root ?? null;
            },
        );
    }

    /**
     * A draft reply. GitHub has a mutation for replies in diff threads (replies are flat,
     * with no tree). A "reply" to a PR draft is another paragraph in the pending review body.
     */
    private async createReply(parentId: HostId, body: string): Promise<Comment> {
        const tick = await this.loadTick();
        const owner = threadOfComment(tick.threads, parentId);
        if (owner === null) {
            throw new RpcFailure('bad_request', `GitHub: comment ${parentId} is not in this PR's discussions.`);
        }

        const threadNodeId = parseThreadId(owner.id);
        if (threadNodeId === null) {
            if (!owner.root.draft) {
                throw new RpcFailure(
                    'bad_request',
                    'GitHub cannot add a draft reply to a published PR discussion. Write a new comment.',
                );
            }
            return this.createBodyDraft(body);
        }

        const review = await this.ensurePendingReview();
        return this.createWithDedup(
            async () => {
                const response = await this.client.graphql(
                    ADD_REVIEW_THREAD_REPLY_MUTATION,
                    { reviewId: review.id, threadId: threadNodeId, body },
                    addReviewThreadReplyMutationSchema,
                    1,
                );
                const comment = response.addPullRequestReviewThreadReply?.comment ?? null;
                if (comment === null) {
                    throw new RpcFailure('host_unavailable', 'GitHub did not return the created reply.');
                }
                return toDiffComment(comment);
            },
            async () => {
                const threads = (await this.loadTick()).threads;
                const thread = threads.find((candidate) => candidate.id === owner.id);
                return thread?.root.replies.find((reply) => reply.draft && reply.body === body) ?? null;
            },
        );
    }

    /**
     * A PR draft is a paragraph in the pending review body. GitHub has no other place for it.
     * Reading the body, adding a paragraph and writing it form one queue operation. Otherwise a concurrent
     * draft starting from the same body would get the same paragraph number and overwrite this one.
     */
    private createBodyDraft(body: string): Promise<Comment> {
        return this.withReviewLock(async () => {
            const review = await this.ensurePendingReviewUnderLock();
            if (review.body === '') {
                // A pending review created elsewhere without a body. GitHub will not allow adding one now.
                throw new RpcFailure(
                    'bad_request',
                    'GitHub: this PR already has a review with an empty body, and GitHub does not allow adding text to it. Submit or delete this pending review on GitHub and try again. Line comments still work as usual.',
                );
            }

            return this.createWithDedup(
                async () => {
                    const next = appendParagraph(review.body, body);
                    const saved = await this.writeReviewBody(review.id, next.body);
                    return {
                        id: reviewParagraphId(review.id, next.n),
                        author: userOf(saved.author),
                        body,
                        draft: true,
                        issue: null,
                        resolved: null,
                        createdAt: isoTime(saved.createdAt),
                        editedAt: saved.lastEditedAt === null ? null : isoTime(saved.lastEditedAt),
                        replies: [],
                    };
                },
                async () => {
                    // Compare only paragraphs in this review. A line draft with the same text is
                    // normal, and mistaking it for a body paragraph would later edit the wrong comment.
                    const threads = (await this.loadTick()).threads;
                    return findCommentIn(
                        threads,
                        (comment) =>
                            comment.draft && comment.body === body && isReviewParagraphOf(comment.id, review.id),
                    );
                },
            );
        });
    }

    /**
     * Create with a duplicate check. Blindly retrying a mutation is unsafe because a failed response may
     * hide a successful write. Make one attempt, then have the adapter reread the state
     * and accept the comment if it was created after all.
     */
    private async createWithDedup(
        create: () => Promise<Comment>,
        find: () => Promise<Comment | null>,
    ): Promise<Comment> {
        try {
            return await create();
        } catch (error) {
            const existing = await find().catch(() => null);
            if (existing !== null) {
                return existing;
            }
            throw error;
        }
    }

    private async writeReviewBody(reviewId: string, body: string): Promise<GithubReview> {
        const response = await this.client.graphql(
            UPDATE_REVIEW_BODY_MUTATION,
            { reviewId, body },
            updateReviewBodyMutationSchema,
            1,
        );
        const saved = response.updatePullRequestReview?.pullRequestReview ?? null;
        if (saved === null) {
            throw new RpcFailure('host_unavailable', 'GitHub did not confirm the review body write.');
        }
        return saved;
    }

    /**
     * Edit or delete one review body paragraph. `null` text means deletion.
     * Reading and writing form one queue operation, since another paragraph rewrites the same full body.
     */
    private rewriteParagraph(reviewId: string, n: number, text: string | null): Promise<void> {
        return this.withReviewLock(async () => {
            const response = await this.client.graphql(
                REVIEW_BODY_QUERY,
                { reviewId },
                reviewBodyResponseSchema,
            );
            const review = response.node;
            if (review === null) {
                throw new RpcFailure('bad_request', 'GitHub: this review is not in this PR.');
            }

            const next =
                text === null ? removeParagraph(review.body, n) : replaceParagraph(review.body, n, text);
            if (next === null) {
                throw new RpcFailure('bad_request', 'GitHub: this comment is no longer in the review body.');
            }
            await this.writeReviewBody(reviewId, next);
        });
    }

    private async findComment(commentId: HostId): Promise<Comment | null> {
        const threads = (await this.loadTick()).threads;
        return findCommentIn(threads, (comment) => comment.id === commentId);
    }

    /** A write succeeded, so subscribers need a fresh snapshot without waiting for a full tick. */
    private refreshSoon(): void {
        void this.pollTick();
    }

    /**
     * Shared polling with one timer and one GraphQL query per tick for all subscribers.
     * Polling starts with the first subscriber and stops with the last. A tick error does not end subscriptions.
     */
    private subscribePoll(handler: PollHandler): () => void {
        const subscription: PollSubscription = { handler, stopped: false, served: false };
        this.pollSubscriptions.add(subscription);

        if (this.pollTimer === null) {
            const timer = setInterval(() => {
                void this.pollTick();
            }, this.pollIntervalMs);
            // The adapter timer neither keeps the process alive nor counts as server activity (see idle.ts).
            timer.unref();
            this.pollTimer = timer;
        }
        void this.pollTick();

        return () => {
            if (subscription.stopped) {
                return;
            }
            subscription.stopped = true;
            this.pollSubscriptions.delete(subscription);
            if (this.pollSubscriptions.size === 0 && this.pollTimer !== null) {
                clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
        };
    }

    private async pollTick(): Promise<void> {
        if (this.polling) {
            // A tick is already in flight. It may have started before the write, so another tick must follow it.
            this.tickRequested = true;
            return;
        }
        if (this.pollSubscriptions.size === 0) {
            return;
        }

        this.polling = true;
        try {
            let tick: TickSnapshot | null = null;
            try {
                tick = await this.loadTick();
                this.rememberMeta(tick.meta);
            } catch (error) {
                // The next tick retries. A network hiccup must not end subscriptions.
                process.stderr.write(`sherpa-review-server: GitHub polling: ${messageOf(error)}\n`);
            }

            for (const subscription of [...this.pollSubscriptions]) {
                if (subscription.stopped) {
                    continue;
                }
                subscription.served = true;
                try {
                    await subscription.handler(tick, () => !subscription.stopped);
                } catch (error) {
                    process.stderr.write(`sherpa-review-server: GitHub polling: ${messageOf(error)}\n`);
                }
            }
        } finally {
            this.polling = false;
        }

        // Subscriptions and writes arriving during a tick must not wait for the next interval.
        const requested = this.tickRequested;
        this.tickRequested = false;
        if (requested || [...this.pollSubscriptions].some((subscription) => !subscription.served)) {
            void this.pollTick();
        }
    }

    private iteration(headRefOid: string): IterationCache {
        if (this.cache?.headRefOid !== headRefOid) {
            this.cache = { headRefOid };
        }
        return this.cache;
    }

    /** Do not leave a rejected promise in the cache. The next call must try again. */
    private forget(cache: IterationCache): void {
        if (this.cache === cache) {
            this.cache = null;
        }
    }

    private prNotFound(): RpcFailure {
        return new RpcFailure(
            'host_unavailable',
            `GitHub did not return PR ${this.owner}/${this.repo}#${String(this.number)}: it does not exist or the token cannot see it.`,
        );
    }
}

/** Aggregate check status. GitHub keeps it on the latest branch commit. */
function checksOf(meta: GithubPrMeta): PrChecks | null {
    const state = compact(meta.commits.nodes)[0]?.commit.statusCheckRollup?.state ?? null;
    switch (state) {
        case 'SUCCESS':
            return 'passed';
        case 'FAILURE':
        case 'ERROR':
            return 'failed';
        case 'PENDING':
        case 'EXPECTED':
            return 'pending';
        default:
            return null;
    }
}

/** The `submitPullRequestReview` event for each publish mode. GitHub has no sticky ship. */
type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

const REVIEW_EVENTS: Readonly<Record<Exclude<Verdict, 'sticky_ship'>, ReviewEvent>> = {
    comment: 'COMMENT',
    ship: 'APPROVE',
    request_changes: 'REQUEST_CHANGES',
};

/**
 * Publish modes for this PR. GitHub prevents the author from approving or requesting changes, so their own PR
 * only allows a review without a verdict. GitHub has no sticky ship. A new review clears approval instead of
 * preserving it across pushes.
 */
function publishVerdictsOf(meta: GithubPrMeta, viewerLogin: string): Exclude<Verdict, 'sticky_ship'>[] {
    const own = meta.author !== null && meta.author.login.toLowerCase() === viewerLogin.toLowerCase();
    return own ? ['comment'] : ['comment', 'ship', 'request_changes'];
}

/**
 * Verdicts from the "latest meaningful reviews": approval and request changes. Other states
 * (`COMMENTED`, `DISMISSED`) carry no verdict. A comment must not falsely count as a ship.
 */
function verdictsOf(meta: GithubPrMeta): ReviewerVerdict[] {
    const verdicts: ReviewerVerdict[] = [];
    for (const review of compact(meta.latestOpinionatedReviews?.nodes ?? null)) {
        const author = review.author;
        if (author === null) {
            continue;
        }
        if (review.state === 'APPROVED') {
            verdicts.push({ user: userOf(author), verdict: 'ship' });
        } else if (review.state === 'CHANGES_REQUESTED') {
            verdicts.push({ user: userOf(author), verdict: 'request_changes' });
        }
    }
    return verdicts;
}

/** The response is complete and can be cached until the iteration ends. */
function settled<T>(value: T): Degradable<T> {
    return { value, degraded: false };
}

/** An endpoint failed, leaving the response incomplete. Return the value without caching it. */
function degraded<T>(value: T): Degradable<T> {
    return { value, degraded: true };
}

/** The "My files" lens. An empty lens is disabled with an explanation, while its zones remain. */
function mineLens(paths: readonly string[], note: string | null, zones: readonly LensZone[] | null): Lens {
    return {
        id: 'mine',
        label: 'My files',
        paths: [...paths],
        available: paths.length > 0,
        note,
        zones: zones === null ? null : zones.map((zone) => ({ ...zone, paths: [...zone.paths] })),
        audit: null,
    };
}

/** The `note` text explains both why the lens is empty and why its response is incomplete to the reviewer. */
function ownershipNote(empty: boolean, teamsDegraded: boolean): string | null {
    const reason = empty ? 'No files of this PR are in your CODEOWNERS zones.' : null;
    if (!teamsDegraded) {
        return reason;
    }
    return reason === null ? TEAMS_UNKNOWN_NOTE : `${reason} ${TEAMS_UNKNOWN_NOTE}`;
}

/** An owner is mine if it matches my login without case sensitivity or a team I belong to. */
function isMine(rule: CodeownersRule, login: string, teams: ReadonlySet<string>): boolean {
    return rule.owners.some((owner) => {
        // An email owner never counts as mine, since GitHub does not identify who owns the address.
        if (!owner.startsWith('@')) {
            return false;
        }
        const name = owner.slice(1).toLowerCase();
        return name.includes('/') ? teams.has(name) : name === login.toLowerCase();
    });
}

/** Organizations of owner teams, with one entry per organization regardless of case. */
function orgsOf(owned: readonly { readonly rule: CodeownersRule | null }[]): string[] {
    const orgs = new Map<string, string>();
    for (const entry of owned) {
        for (const owner of entry.rule?.owners ?? []) {
            const [org, slug] = owner.startsWith('@') ? owner.slice(1).split('/') : [];
            if (org !== undefined && org !== '' && slug !== undefined && slug !== '') {
                orgs.set(org.toLowerCase(), org);
            }
        }
    }
    return [...orgs.values()];
}

/**
 * PR zones. A file belongs to exactly one zone since it has one rule. A zone key combines its boundary, "mine" and
 * owner. Different rules split the same boundary by owner.
 */
function ownershipZones(
    owned: readonly { readonly path: string; readonly rule: CodeownersRule | null }[],
    mine: (rule: CodeownersRule) => boolean,
): LensZone[] {
    const zones = new Map<string, LensZone>();

    for (const { path, rule } of owned) {
        // Files without rules or with rules that clear ownership stay outside zones. The UI groups them.
        if (rule === null || rule.owners.length === 0) {
            continue;
        }
        const zone = { path: zonePathOf(rule, path), mine: mine(rule), owner: ownerLabel(rule) };
        const key = JSON.stringify([zone.path, zone.mine, zone.owner]);
        const existing = zones.get(key);
        if (existing === undefined) {
            zones.set(key, { ...zone, paths: [path] });
        } else {
            existing.paths.push(path);
        }
    }

    return [...zones.values()].sort(compareZones);
}

/** A zone chip uses the rule's first owner without `@`: `org/team`, a login or an email unchanged. */
function ownerLabel(rule: CodeownersRule): string | null {
    const owner = rule.owners[0];
    if (owner === undefined) {
        return null;
    }
    return owner.startsWith('@') ? owner.slice(1) : owner;
}

/** Deterministic zone order by boundary, then "mine" and owner. */
function compareZones(left: LensZone, right: LensZone): number {
    if (left.path !== right.path) {
        return left.path < right.path ? -1 : 1;
    }
    if (left.mine !== right.mine) {
        return left.mine ? -1 : 1;
    }
    const leftOwner = left.owner ?? '';
    const rightOwner = right.owner ?? '';
    if (leftOwner === rightOwner) {
        return 0;
    }
    return leftOwner < rightOwner ? -1 : 1;
}

/** A file image. The extension determines its type, and its sides are blob addresses on each diff side. */
function imageOf(
    file: GithubRestFile,
    changeType: FileDiff['changeType'],
    headRefOid: string,
    mergeBase: string,
    sizes: ReadonlyMap<string, number>,
): FileImage | null {
    const mime = imageMimeOf(file.filename);
    if (mime === null) {
        return null;
    }

    const before =
        changeType === 'add'
            ? null
            : sideOf(blobExpression(mergeBase, file.previous_filename ?? file.filename), sizes);
    const after = changeType === 'delete' ? null : sideOf(blobExpression(headRefOid, file.filename), sizes);
    return before === null && after === null ? null : { mime, before, after };
}

/** Do not return a side with unknown sizes. `size` is part of the `ImageSide` contract. */
function sideOf(blobId: string, sizes: ReadonlyMap<string, number>): ImageSide | null {
    const size = sizes.get(blobId);
    return size === undefined ? null : { blobId, size };
}

/** A GraphQL blob with the fields the adapter requests. */
interface GithubBlob {
    readonly text?: string | null | undefined;
    readonly isBinary?: boolean | null | undefined;
    readonly byteSize?: number | undefined;
}

/** File-side text. `undefined` means content is unavailable for the whole file (binary or too large). */
function sideTextOf(blob: GithubBlob | null): string | null | undefined {
    if (blob === null) {
        // The side is absent entirely, as with add and delete.
        return null;
    }
    if (blob.isBinary === true || (blob.byteSize ?? 0) > MAX_CONTENT_BYTES) {
        return undefined;
    }
    return blob.text ?? undefined;
}

/** A GitHub blob address: `<commit>:<path>`, also used as `ImageSide.blobId`. */
function blobExpression(sha: string, path: string): string {
    return `${sha}:${path}`;
}

function parseBlobId(blobId: string): { sha: string; path: string } | null {
    const separator = blobId.indexOf(':');
    if (separator <= 0 || separator === blobId.length - 1) {
        return null;
    }
    return { sha: blobId.slice(0, separator), path: blobId.slice(separator + 1) };
}

/** A GitHub file link anchor is the sha256 of the path, not the path itself. */
function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function encodePath(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
}

function samePosition(left: AnchorPosition | null, right: AnchorPosition | null): boolean {
    if (left === null || right === null) {
        return left === right;
    }
    return left.side === right.side && left.line === right.line && left.size === right.size;
}

/** The thread owning the comment (root or reply). null means the comment does not exist. */
function threadOfComment(threads: readonly Thread[], commentId: string): Thread | null {
    for (const thread of threads) {
        if (thread.root.id === commentId || thread.root.replies.some((reply) => reply.id === commentId)) {
            return thread;
        }
    }
    return null;
}

function findCommentIn(threads: readonly Thread[], match: (comment: Comment) => boolean): Comment | null {
    for (const thread of threads) {
        for (const comment of [thread.root, ...thread.root.replies]) {
            if (match(comment)) {
                return comment;
            }
        }
    }
    return null;
}

/**
 * The body used to publish a pending review. Paragraph markers stay so published paragraphs
 * can still be addressed. With no paragraphs, send an empty string so the placeholder
 * does not appear to PR reviewers as an empty comment.
 */
function publishedBodyOf(body: string): string {
    const { paragraphs } = parseReviewBody(body);
    return paragraphs.length === 0 ? '' : renderReviewBody(paragraphs);
}

/** IDs of all snapshot drafts. Exactly these drafts will be published. */
function draftIdsOf(threads: readonly Thread[]): string[] {
    const ids: string[] = [];
    for (const thread of threads) {
        for (const comment of [thread.root, ...thread.root.replies]) {
            if (comment.draft) {
                ids.push(comment.id);
            }
        }
    }
    return ids;
}

/** A review state fingerprint. Reread metadata when it changes. */
function statusStampOf(meta: GithubPrMeta): string {
    const verdicts = compact(meta.latestOpinionatedReviews?.nodes ?? null)
        .map((review) => `${review.author?.login ?? ''}:${review.state}`)
        .join(',');
    return `${meta.updatedAt}#${meta.state}#${String(meta.isDraft)}#${verdicts}`;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
