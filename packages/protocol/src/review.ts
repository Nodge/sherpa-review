import { z } from 'zod';

/**
 * Review domain types (requirements §1/C4, brief §4a): data that crosses the host adapter boundary
 * and reaches the UI. Host details (sticky ship mechanics, signed host ids,
 * status fields, etc.) stay as verdicts and opaque strings, without leaking into the model.
 * Shapes checked against the M1-T1 spike.
 */

/**
 * Opaque host identifier (PR, comment, diff file, iteration).
 * Do not parse or construct these: hosts can use signed numbers or base64 protobufs,
 * while GitHub uses node ids. The contract promises only equality in either case.
 */
export const hostIdSchema = z.string().min(1);
export type HostId = z.infer<typeof hostIdSchema>;

/** Comment or PR author. The bot flag controls muting and the source chip in the UI (brief F4). */
export const reviewUserSchema = z.object({
    login: z.string().min(1),
    /** Human-readable source name. Bots use a label such as "AI Review (…)". */
    displayName: z.string().nullable(),
    bot: z.boolean(),
});
export type ReviewUser = z.infer<typeof reviewUserSchema>;

/** Host capabilities. The UI hides unavailable actions (sticky ship and viewed sync vary across hosts). */
export const hostCapabilitiesSchema = z.object({
    stickyShip: z.boolean(),
    fileViewedSync: z.boolean(),
    /** The host can return full file contents (`getFileContent`). Without it, "Expand context" is unavailable. */
    fileContent: z.boolean(),
    /** The host distinguishes "comment opens an issue / needs no reply" (`CommentDraft.issue`). Without it, the UI hides the control. */
    commentIssues: z.boolean(),
    /**
     * The host lists previous iterations and returns slices between them (`listIterations` has more than
     * one entry, `getDiff({base, head})`). Without this, `listIterations` contains only
     * the active iteration, slices are rejected, and the server cannot carry over progress or classify stops
     * after a push. The UI only shows "route is stale".
     */
    iterations: z.boolean(),
});
export type HostCapabilities = z.infer<typeof hostCapabilitiesSchema>;

export const prStateSchema = z.enum(['open', 'merged', 'closed']);
export type PrState = z.infer<typeof prStateSchema>;

/**
 * Aggregate CI check status for the PR. null means the host does not provide it (the review host exposes checks through
 * a separate, unexplored API. The adapter returns null, and the UI hides it).
 */
export const prChecksSchema = z.enum(['passed', 'failed', 'pending']);
export type PrChecks = z.infer<typeof prChecksSchema>;

/** PR header. `statusLabel` is the review status in the host's words, displayed as is by the UI. */
export const prMetaSchema = z.object({
    id: hostIdSchema,
    url: z.string().min(1),
    title: z.string(),
    author: reviewUserSchema,
    fromBranch: z.string(),
    toBranch: z.string(),
    state: prStateSchema,
    statusLabel: z.string(),
    checks: prChecksSchema.nullable(),
    updatedAt: z.iso.datetime(),
    capabilities: hostCapabilitiesSchema,
});
export type PrMeta = z.infer<typeof prMetaSchema>;

export const fileChangeTypeSchema = z.enum(['add', 'modify', 'delete', 'copy', 'move', 'conflict']);
export type FileChangeType = z.infer<typeof fileChangeTypeSchema>;

/**
 * One diff file. Content is a raw unified diff (`patch`), parsed into a line model
 * by the UI in a worker (requirements §1/C3). The server and adapter do not interpret the text.
 */
export const fileDiffSchema = z.object({
    /** Opaque file id in this iteration, the anchor for comments and viewed marks. */
    fileId: hostIdSchema,
    path: z.string().min(1),
    /** Previous path for copy/move. */
    oldPath: z.string().nullable(),
    changeType: fileChangeTypeSchema,
    binary: z.boolean(),
    /**
     * "The team does not require review of this file": the file is excluded from the active review rules
     * (CODEOWNERS or host equivalent). This is not a heuristic, the review tool follows team policy.
     */
    generated: z.boolean(),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
    /** Unified diff for the file. null for binary files and files without a text diff. */
    patch: z.string().nullable(),
    /** Host-side viewed mark. null if unsupported by the host (see capabilities). */
    viewed: z.boolean().nullable(),
    /** Link to this file's blame view on the host. null if the host has no link to offer. */
    blameUrl: z.string().nullable(),
});
export type FileDiff = z.infer<typeof fileDiffSchema>;

/**
 * File content on both sides of the diff supplies "Expand context" (SPEC §2.13):
 * the UI fills in lines outside the hunks from this text. The host needs no protocol for context
 * width. A null side means the file does not exist on that side (add/delete).
 */
export const fileContentSchema = z.object({
    oldText: z.string().nullable(),
    newText: z.string().nullable(),
});
export type FileContent = z.infer<typeof fileContentSchema>;

/**
 * The entire PR diff, either one host iteration or a slice between two iterations
 * (`getDiff({base, head})`, interdiff). A slice's `diffId` is the `head` iteration id,
 * and `baseCommit` is the reviewed commit of the `base` iteration. Slice file `fileId` values
 * are opaque, just as in iterations, and differ from the `fileId` values in the iterations themselves.
 */
export const prDiffSchema = z.object({
    /** Opaque iteration id for snapshot provenance and new comment anchors. */
    diffId: hostIdSchema,
    baseCommit: z.string().min(1),
    /** Reviewed side (some hosts use a synthetic merge commit instead of the branch HEAD). */
    headCommit: z.string().min(1),
    files: z.array(fileDiffSchema),
});
export type PrDiff = z.infer<typeof prDiffSchema>;

/**
 * Iteration status. `active` is the one under review now (exactly one). `previous` means
 * the host still lists it. `gone` means the host no longer lists it (a force-push on GitHub),
 * but the server retains its locally saved diff (brief §4a). Only the server sets
 * `gone`, by comparing the host's list with its own storage. The adapter returns only what it sees.
 */
export const iterationStatusSchema = z.enum(['active', 'previous', 'gone']);
export type IterationStatus = z.infer<typeof iterationStatusSchema>;

/**
 * A PR iteration is the unit of review time: one push by the author is one
 * iteration. Route snapshots, reading progress and note anchors are tied to `diffId`.
 */
export const iterationSchema = z.object({
    diffId: hostIdSchema,
    baseCommit: z.string().min(1),
    /** The iteration's reviewed commit, the same as `PrDiff.headCommit`. */
    headCommit: z.string().min(1),
    createdAt: z.iso.datetime(),
    status: iterationStatusSchema,
});
export type Iteration = z.infer<typeof iterationSchema>;

/** Position in a file diff: side + line + span (size ≥ 1, may be a range). */
export const anchorPositionSchema = z.object({
    side: z.enum(['old', 'new']),
    line: z.number().int().positive(),
    size: z.number().int().positive(),
});
export type AnchorPosition = z.infer<typeof anchorPositionSchema>;

/** Thread/draft anchor. Without `position`, the comment applies to the whole file. */
export const fileAnchorSchema = z.object({
    fileId: hostIdSchema,
    path: z.string().min(1),
    position: anchorPositionSchema.nullable(),
});
export type FileAnchor = z.infer<typeof fileAnchorSchema>;

/**
 * Comment with a subtree of replies. Threads are trees, not lists: spike data
 * reaches depth 14, with branching at ~7% of nodes. The UI flattens them for rendering (indent cap 4).
 * `draft` is my unpublished draft (visible only to me, with a "publishes on ship" chip).
 */
export interface Comment {
    id: HostId;
    author: ReviewUser;
    /** Markdown as returned by the host. */
    body: string;
    draft: boolean;
    /**
     * Whether the comment opens an issue, the same flag set by `CommentDraft.issue`.
     * `null` only for hosts without `capabilities.commentIssues`. Where issues exist, "unknown" is not a state.
     * A comment without an issue status does not open an issue, and the UI shows the toggle switched off
     * instead of hiding it.
     */
    issue: boolean | null;
    createdAt: string;
    editedAt: string | null;
    replies: Comment[];
}
export const commentSchema: z.ZodType<Comment> = z.object({
    id: hostIdSchema,
    author: reviewUserSchema,
    body: z.string(),
    draft: z.boolean(),
    issue: z.boolean().nullable(),
    createdAt: z.iso.datetime(),
    editedAt: z.iso.datetime().nullable(),
    get replies() {
        return z.array(commentSchema);
    },
});

/**
 * A thread's pin to the commit where it was written (SPEC §4.5 "pinned to 9f3c1ab"): the iteration
 * of the original anchor reported by the host. The UI neither stores
 * nor computes its own pin. A `pinnedTo.diffId` different from the active iteration gives "view at the
 * old commit". The rest is handled by `outdated` and the rebound `anchor`.
 */
export const threadPinSchema = z.object({
    diffId: hostIdSchema,
    commit: z.string().min(1),
});
export type ThreadPin = z.infer<typeof threadPinSchema>;

/**
 * A thread contains the root comment and thread-level state.
 * `anchor: null` means a PR discussion. The adapter computes `outdated`
 * (from the difference between iteration lists if the host has no such field). `pinnedTo: null` means
 * a PR discussion or that the host does not know the anchor's iteration.
 */
export const threadSchema = z.object({
    id: hostIdSchema,
    anchor: fileAnchorSchema.nullable(),
    resolved: z.boolean(),
    resolvedBy: z.string().nullable(),
    outdated: z.boolean(),
    pinnedTo: threadPinSchema.nullable(),
    root: commentSchema,
});
export type Thread = z.infer<typeof threadSchema>;

/**
 * Draft to create (two-stage model, brief §3.6): saved to the host immediately,
 * published as one batch with a verdict. Either a reply (`parentId`) or a new thread (`anchor`;
 * null in both means a PR comment.
 */
export const commentDraftSchema = z.object({
    body: z.string().min(1),
    parentId: hostIdSchema.nullable(),
    anchor: fileAnchorSchema.nullable(),
    /**
     * Whether the comment opens an issue (requires a reply). Passed only for new threads and
     * PR-level comments. Omitted for replies and hosts without `commentIssues`,
     * so the host uses its default.
     */
    issue: z.boolean().optional(),
});
export type CommentDraft = z.infer<typeof commentDraftSchema>;

/** Verdict that finishes a review. GitHub variants (approve) will be added in M6 with a minor version bump. */
export const verdictSchema = z.enum(['ship', 'sticky_ship', 'request_changes']);
export type Verdict = z.infer<typeof verdictSchema>;

/**
 * Batch publication result. On partial failure, the verdict is NOT applied,
 * the review is not complete (SPEC §4.5), and the UI shows the failed comments.
 */
export const publishResultSchema = z.object({
    publishedCommentIds: z.array(hostIdSchema),
    failed: z.array(z.object({ commentId: hostIdSchema, message: z.string() })),
    verdictApplied: z.boolean(),
});
export type PublishResult = z.infer<typeof publishResultSchema>;

/**
 * Ownership lens zone (M2F-T7, decision #3): the boundary from ownership configuration is
 * the owning configuration directory, or a subpath within it for subpath rules.
 * A diff file belongs to at most one zone, the deepest boundary.
 * Zones describe the entire PR (not just the reviewer's zones) and remain meaningful even when
 * the lens has `available: false`. The reviewer has no zone, but other ownership zones exist in the PR.
 */
export const lensZoneSchema = z.object({
    /** Zone boundary relative to the repository root, without leading or trailing `/`. */
    path: z.string().min(1),
    /** The reviewer owns the zone ("you · owner" chip). */
    mine: z.boolean(),
    /**
     * Owner name for the chip (ownership rule alias, for example `modules-team`).
     * null means the rule has no alias, so the UI uses an unnamed chip label.
     */
    owner: z.string().nullable(),
    /** Current diff file paths within the zone, membership as in the lens's `paths`. There are no empty zones. */
    paths: z.array(z.string()).min(1),
});
export type LensZone = z.infer<typeof lensZoneSchema>;

/**
 * A lens is a named set of paths for filtering files (README filter model).
 * `available: false` means the lens mechanism is unavailable (the reviewer has no zone, an
 * undocumented endpoint broke). The UI disables the filter and explains why using `note`.
 */
export const lensSchema = z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    /** Specific file paths in the current diff (not directory prefixes). The UI filter checks membership. */
    paths: z.array(z.string()),
    available: z.boolean(),
    note: z.string().nullable(),
    /**
     * PR ownership zones, only for the ownership lens. null means the implementation does not
     * distinguish zones (directory fallback in the review host, extra lenses), so the UI groups
     * files by path prefix, as before M2F-T7. The UI groups files outside all zones
     * (generated files and files not covered by CODEOWNERS).
     */
    zones: z.array(lensZoneSchema).nullable(),
});
export type Lens = z.infer<typeof lensSchema>;
