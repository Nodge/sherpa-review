import type { CommentDraft, Comment, HostId, Lens, PrDiff, PrMeta, PublishResult, Thread, Verdict } from './review.js';

/**
 * Host adapter interface (requirements §1/C4, brief §4a). One abstraction, implemented by:
 * Fixture (M1, for UI/tests), GitHub (M6). All host-specific behaviour stays
 * behind this boundary. The core (walkthrough, queue, progress, snapshots) knows no host details.
 * The same contract test suite (requirements §7) runs against every implementation.
 */
export interface ReviewHost {
    getPr(): Promise<PrMeta>;

    /**
     * Iteration diff. With no arguments, returns the host's active iteration. Explicit base/head request
     * an arbitrary slice (M4, stacked/base selection). The adapter may reject
     * an unsupported combination with a clear error.
     */
    getDiff(opts?: { base?: string; head?: string }): Promise<PrDiff>;

    /**
     * Thread subscription: the callback receives a full snapshot on every change
     * (and once immediately after subscribing). Transport is an adapter detail. The common
     * denominator across hosts is polling (M1-T1 decision), so reactive delivery
     * is not guaranteed, only convergence.
     */
    watchThreads(onChange: (threads: Thread[]) => void): () => void;

    /** Save a draft to the host immediately (two-stage model). Returns the created comment. */
    saveDraft(draft: CommentDraft): Promise<Comment>;

    updateDraft(commentId: HostId, body: string): Promise<void>;

    deleteDraft(commentId: HostId): Promise<void>;

    setThreadResolved(threadId: HostId, resolved: boolean): Promise<void>;

    /**
     * Publish accumulated drafts as one batch and apply the verdict.
     * The verdict applies only if every draft is published (SPEC §4.5).
     */
    publishBatch(verdict: Verdict): Promise<PublishResult>;

    /** Synchronize viewed marks with the host. Absent on hosts without this feature (capabilities.fileViewedSync). */
    setFileViewed?(fileId: HostId, viewed: boolean): Promise<void>;

    /** "My files" lens (CODEOWNERS or host equivalent). null if the host has no ownership concept. */
    ownershipLens(): Promise<Lens | null>;

    /** Additional host lenses (PCI DSS is host-specific). */
    extraLenses(): Promise<Lens[]>;
}
