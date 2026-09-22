import type {
    CommentDraft,
    Comment,
    FileContent,
    HostId,
    Iteration,
    Lens,
    PrDiff,
    PrMeta,
    PublishResult,
    Thread,
    Verdict,
} from './review.js';

/**
 * Host adapter interface (`docs/architecture.md §5`, `docs/product.md §4a`). One
 * abstraction with 3 implementations: a remote review host, a local Git checkout, and a fixture host for the UI and
 * tests. Everything specific to a host stays behind this boundary. The core (route, queue, progress,
 * snapshots) knows nothing about the host. Contract tests (`docs/testing.md §3`) run the same suite against every implementation.
 */
export interface ReviewHost {
    getPr(): Promise<PrMeta>;

    /**
     * PR iterations in order of appearance, with exactly one active iteration, always last. Statuses are
     * only `active`/`previous`: the adapter never returns `gone` (see `iterationStatusSchema`).
     * Without `capabilities.iterations`, the list contains one active iteration.
     */
    listIterations(): Promise<Iteration[]>;

    /**
     * Iteration diff. Without arguments, the host's active iteration. `{base, head}` gives a slice
     * between 2 listed iterations (interdiff: what changed from `base` to `head`),
     * with their `diffId` values as arguments. A slice with an unknown iteration or without
     * `capabilities.iterations` is rejected with a clear error. The slice's file paths are
     * a subset of the union of both iterations' paths.
     */
    getDiff(slice?: { base: HostId; head: HostId }): Promise<PrDiff>;

    /**
     * Iteration subscription: the callback receives the full list on every change
     * (new push, force-push) and once immediately after subscribing. Transport and
     * guarantees match `watchThreads` (polling, convergence without reactivity).
     */
    watchIterations(onChange: (iterations: Iteration[]) => void): () => void;

    /** One-time thread read: current state without a subscription. */
    getThreads(): Promise<Thread[]>;

    /**
     * Thread subscription: the callback receives a full snapshot on every change
     * (and once immediately after subscribing). Transport is an adapter detail. The common
     * denominator across hosts is polling, so reactivity
     * is not guaranteed, only convergence.
     */
    watchThreads(onChange: (threads: Thread[]) => void): () => void;

    /**
     * Save a draft to the host immediately (two-stage model). Returns the created comment.
     * `idempotencyKey` is the retry key from the draft buffer. A retry with the same key
     * must not create a second comment. A host without such an endpoint ignores the key.
     */
    saveDraft(draft: CommentDraft, options?: { idempotencyKey?: string }): Promise<Comment>;

    /**
     * Edit your own draft. `issue` is passed only with `capabilities.commentIssues`,
     * for any comment, including replies. undefined leaves the status unchanged.
     */
    updateDraft(commentId: HostId, body: string, issue?: boolean): Promise<void>;

    deleteDraft(commentId: HostId): Promise<void>;

    /**
     * Thread-level resolve for hosts without `capabilities.commentResolve`. Hosts with per-comment
     * resolve still have this method, which acts on the thread root.
     */
    setThreadResolved(threadId: HostId, resolved: boolean): Promise<void>;

    /**
     * Resolve an individual comment with an issue. Method presence must match
     * `capabilities.commentResolve` (checked by the contract suite). Resolving a comment without an issue is
     * a host error, not a silent success.
     */
    setCommentResolved?(commentId: HostId, resolved: boolean): Promise<void>;

    /**
     * Edit and delete your own published comment. The presence of both methods must match
     * `capabilities.editPublished` (checked by the contract suite). The host may soft-delete a published
     * comment, which must no longer be returned. Drafts go through
     * `updateDraft`/`deleteDraft` and the draft buffer, never through these methods.
     */
    updateComment?(commentId: HostId, body: string, issue?: boolean): Promise<void>;
    deleteComment?(commentId: HostId): Promise<void>;

    /**
     * Publish accumulated drafts as one batch and apply the verdict.
     * The verdict applies only if all drafts were published (`docs/design/SPEC-elements.md §4.5`).
     * The result carries no final PR state. Read it again through `getPr`.
     */
    publishBatch(verdict: Verdict): Promise<PublishResult>;

    /**
     * Synchronize viewed marks with the host. Method presence must match
     * `capabilities.fileViewedSync`, as checked by the contract suite.
     */
    setFileViewed?(fileId: HostId, viewed: boolean): Promise<void>;

    /**
     * Full file contents on both diff sides, for "Expand context".
     * Method presence must match `capabilities.fileContent` (checked by the contract
     * suite). null means contents are unavailable for this specific file (binary,
     * too large). The UI disables expansion for it.
     */
    getFileContent?(fileId: HostId): Promise<FileContent | null>;

    /**
     * Bytes by `ImageSide.blobId`, for the image card. Method presence must match
     * `capabilities.blobs` (checked by the contract suite). null means the host does not know this
     * blob or the side exceeds `IMAGE_BLOB_MAX_BYTES`. The host does not validate the byte format:
     * the server determines the response type from the magic bytes itself.
     */
    getBlob?(blobId: HostId): Promise<Uint8Array | null>;

    /**
     * The "My files" lens (CODEOWNERS). null means the host has no ownership concept.
     * The lens's `zones` includes all PR zones with boundaries and owners (not just the
     * reviewer's). null means the implementation only distinguishes "mine/not mine" membership.
     */
    ownershipLens(): Promise<Lens | null>;

    /** Additional host lenses (PCI DSS is host-specific). */
    extraLenses(): Promise<Lens[]>;
}
