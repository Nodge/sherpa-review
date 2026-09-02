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
 * Host adapter interface (requirements §1/C4, brief §4a). One abstraction, implemented by:
 * Fixture (M1, for UI/tests), GitHub (M6). All host-specific behaviour stays
 * behind this boundary. The core (walkthrough, queue, progress, snapshots) knows no host details.
 * The same contract test suite (requirements §7) runs against every implementation.
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
     * denominator across hosts is polling (M1-T1 decision), so reactive delivery
     * is not guaranteed, only convergence.
     */
    watchThreads(onChange: (threads: Thread[]) => void): () => void;

    /** Save a draft to the host immediately (two-stage model). Returns the created comment. */
    saveDraft(draft: CommentDraft): Promise<Comment>;

    /**
     * Edits your own draft. `issue` is passed only with `capabilities.commentIssues`
     * and only for thread roots / PR-level comments. undefined leaves the status unchanged.
     */
    updateDraft(commentId: HostId, body: string, issue?: boolean): Promise<void>;

    deleteDraft(commentId: HostId): Promise<void>;

    setThreadResolved(threadId: HostId, resolved: boolean): Promise<void>;

    /**
     * Publish accumulated drafts as one batch and apply the verdict.
     * The verdict applies only if every draft is published (SPEC §4.5).
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
     * The "My files" lens (CODEOWNERS). null means the host has no ownership concept.
     * The lens's `zones` includes all PR zones with boundaries and owners (not just the
     * reviewer's). null means the implementation only distinguishes "mine/not mine" membership.
     */
    ownershipLens(): Promise<Lens | null>;

    /** Additional host lenses (PCI DSS is host-specific). */
    extraLenses(): Promise<Lens[]>;
}
