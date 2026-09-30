import type { ServerResponse } from 'node:http';

import type { PrDiff, ReviewHost, UiStopSeenRange } from '@sherpa/protocol';
import {
    UI_ENDPOINTS,
    uiReviewBlobRequestSchema,
    uiDeleteDraftRequestSchema,
    uiDraftBufferEntryRequestSchema,
    uiDraftBufferResponseSchema,
    uiReviewDiffRequestSchema,
    uiReviewDiffResponseSchema,
    uiReviewFileContentRequestSchema,
    uiReviewProgressRequestSchema,
    uiReviewFileContentResponseSchema,
    uiReviewLensesResponseSchema,
    uiReviewProgressResponseSchema,
    uiReviewThreadsResponseSchema,
    uiReviewWriteAckSchema,
    uiPublishRequestSchema,
    uiPublishResponseSchema,
    uiSaveDraftRequestSchema,
    uiSaveDraftResponseSchema,
    uiSetFileViewedRequestSchema,
    uiSetFileViewedResponseSchema,
    uiSetStopFileViewedRequestSchema,
    uiSetStopFileViewedResponseSchema,
    uiSetStopViewedRequestSchema,
    uiSetStopViewedResponseSchema,
    uiSetThreadResolvedRequestSchema,
    uiSetCommentResolvedRequestSchema,
    uiUpdateCommentRequestSchema,
    uiDeleteCommentRequestSchema,
    uiViewedMirrorRequestSchema,
    uiUpdateDraftRequestSchema,
    uiUpdateDraftResponseSchema,
} from '@sherpa/protocol';
import type { z } from 'zod';

import type { BlobCache } from './blob-cache.js';
import type { DraftBufferWriter } from './draft-buffer.js';
import { RpcFailure } from './errors.js';
import type { JsonResponse, RequestContext, Route, StreamContext } from './http.js';
import { handlingRpcFailures, readJsonBody, rpcFailureResponse, sendJson } from './http.js';
import type { IterationFeed } from './iteration-feed.js';
import type { IterationStore } from './iteration-store.js';
import { rememberIterationDiff } from './iteration-store.js';
import { LEGACY_DIFF_ID } from './iterations/index.js';
import type { PrMetaCache } from './pr-meta.js';
import type { ProgressStore } from './progress-store.js';
import type { ReviewFeed } from './review-feed.js';
import type { RouteStore } from './route-store.js';

/**
 * UI review endpoints: active iteration diff, threads, lenses, file contents.
 * PR metadata has no endpoint of its own. It comes in the `uiState` snapshot.
 *
 * Fail-closed in both directions: the adapter validates host responses against its schemas, and the server validates
 * what it sends to the UI against the contract schemas. No host (prKey did not map to anything) means `no_review_host`.
 * A host failure (network, token, invalid response) means `host_unavailable` with a readable reason.
 *
 * Reading progress is the exception: it is local, lives in this PR's SQLite database and works without a host.
 * Its endpoints never return `no_review_host`.
 */

export interface ReviewRoutesOptions {
    readonly host: ReviewHost | null;
    /** Thread revision: a successful local write wakes SSE clients immediately. */
    readonly reviewFeed: ReviewFeed | null;
    /** Reading progress for this PR: the local source of truth for viewed marks. */
    readonly progress: ProgressStore;
    /** Route snapshots: drops late marks, and iteration progress looks up its own snapshot. */
    readonly route: Pick<RouteStore, 'read' | 'listSnapshots'>;
    /** PR metadata cache: publishing a verdict changes the status, and capabilities determine whether slices are available. */
    readonly prMeta: Pick<PrMetaCache, 'refresh' | 'get'>;
    /** Draft buffer: all draft writes go through it, both creation and editing. */
    readonly draftBuffer: DraftBufferWriter;
    /** Local storage for iteration patches. If absent, there is nowhere to save the diff (tests without a database). */
    readonly iterations?: IterationStore | null;
    /** PR iterations: endpoints use these to tell whether a request concerns the active iteration or a previous one. */
    readonly iterationFeed?: IterationFeed | null;
    /** On-disk image byte cache. If absent, every request goes to the host (tests without state). */
    readonly blobs?: BlobCache | null;
    /**
     * Publication completed. Registered only where publishing has a consequence:
     * for the local host, it enqueues an agent task.
     */
    readonly onPublished?: () => void;
}

export function createReviewRoutes(options: ReviewRoutesOptions): Route[] {
    const mirrorFileViewed = createViewedMirror(options.host);
    // One queue per ID: resolving a thread, resolving a comment and editing a published comment target the same
    // host object (when a thread is its root), and must be applied in arrival order.
    const queueWrite = createKeyedWriteQueue((_id: string, write: (host: ReviewHost) => Promise<void>) =>
        call(() => write(hostOf(options))),
    );
    return [
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewDiff,
            handle: handlingRpcFailures(async (ctx) => {
                const host = hostOf(options);
                const request = parseQuery(
                    uiReviewDiffRequestSchema,
                    {
                        ...optionalParam(ctx, 'diffId'),
                        ...optionalParam(ctx, 'base'),
                        ...optionalParam(ctx, 'head'),
                    },
                    'diff',
                );
                const diff =
                    request.base !== undefined && request.head !== undefined
                        ? await interdiffOf(options, host, request.base, request.head)
                        : await diffOfIteration(options, host, request.diffId);
                return respond(uiReviewDiffResponseSchema, { diff });
            }),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewThreads,
            handle: handlingRpcFailures(async () => {
                const host = hostOf(options);
                return respond(uiReviewThreadsResponseSchema, { threads: await call(() => host.getThreads()) });
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewSaveDraft,
            handle: handlingRpcFailures(async (ctx) => {
                hostOf(options);
                const request = await readRequest(ctx, uiSaveDraftRequestSchema, 'saving a draft');
                const result = await options.draftBuffer.write({
                    id: request.clientKey,
                    draft: request.draft,
                    commentId: null,
                });
                if (result.outcome === 'buffered') {
                    return respond(uiSaveDraftResponseSchema, result, 'local');
                }
                if (result.comment === null) {
                    // The record disappeared between the upsert and the attempt (a concurrent request discarded the buffer entry).
                    throw new RpcFailure('internal', 'The draft disappeared from the buffer before it could be written to the host.');
                }
                return respond(uiSaveDraftResponseSchema, { outcome: 'saved', comment: result.comment });
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewUpdateDraft,
            handle: handlingRpcFailures(async (ctx) => {
                hostOf(options);
                const request = await readRequest(ctx, uiUpdateDraftRequestSchema, 'updating a draft');
                const result = await options.draftBuffer.write({
                    id: request.clientKey,
                    // An edit knows only the text and issue: after a reload, the comment being edited
                    // determines the composer location (the edit composer carries no anchor).
                    draft: {
                        body: request.body,
                        parentId: null,
                        anchor: null,
                        ...(request.issue === undefined ? {} : { issue: request.issue }),
                    },
                    commentId: request.commentId,
                });
                return respond(
                    uiUpdateDraftResponseSchema,
                    result.outcome === 'buffered' ? result : { outcome: 'saved' },
                    'local',
                );
            }),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewDraftBuffer,
            handle: handlingRpcFailures(() =>
                respond(uiDraftBufferResponseSchema, { entries: options.draftBuffer.list() }, 'local'),
            ),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewDraftBufferRetry,
            handle: handlingRpcFailures(async (ctx) => {
                hostOf(options);
                const request = await readRequest(ctx, uiDraftBufferEntryRequestSchema, 'retrying a draft');
                await options.draftBuffer.retry(request.id);
                return respond(uiDraftBufferResponseSchema, { entries: options.draftBuffer.list() }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewDraftBufferDiscard,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiDraftBufferEntryRequestSchema, 'discarding a draft');
                await options.draftBuffer.discard(request.id);
                return respond(uiDraftBufferResponseSchema, { entries: options.draftBuffer.list() }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewDeleteDraft,
            handle: handlingRpcFailures(async (ctx) => {
                const host = hostOf(options);
                const request = await readRequest(ctx, uiDeleteDraftRequestSchema, 'deleting a draft');
                await deleteDraftConvergently(host, request.commentId);
                // The draft is gone, so there is nowhere to deliver the pending edit. Letting it block ship
                // would last forever, so entries for this comment are removed along with it.
                options.draftBuffer.forgetComment(request.commentId);
                options.reviewFeed?.bumpLocalWrite();
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewThreadResolved,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiSetThreadResolvedRequestSchema, 'changing thread status');
                await queueWrite(request.threadId, (host) =>
                    host.setThreadResolved(request.threadId, request.resolved),
                );
                options.reviewFeed?.bumpLocalWrite();
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewCommentResolved,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(
                    ctx,
                    uiSetCommentResolvedRequestSchema,
                    'changing comment status',
                );
                await queueWrite(request.commentId, (host) =>
                    hostMethod(
                        host.setCommentResolved?.bind(host),
                        'This host does not track resolved status on comments. The status applies to the whole thread.',
                    )(request.commentId, request.resolved),
                );
                options.reviewFeed?.bumpLocalWrite();
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewUpdateComment,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiUpdateCommentRequestSchema, 'editing a comment');
                await queueWrite(request.commentId, (host) =>
                    hostMethod(
                        host.updateComment?.bind(host),
                        'This host cannot edit published comments.',
                    )(request.commentId, request.body, request.issue),
                );
                options.reviewFeed?.bumpLocalWrite();
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewDeleteComment,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiDeleteCommentRequestSchema, 'deleting a comment');
                await queueWrite(request.commentId, (host) =>
                    hostMethod(
                        host.deleteComment?.bind(host),
                        'This host cannot delete published comments.',
                    )(request.commentId),
                );
                options.reviewFeed?.bumpLocalWrite();
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewPublish,
            handle: handlingRpcFailures(async (ctx) => {
                const host = hostOf(options);
                const request = await readRequest(ctx, uiPublishRequestSchema, 'publishing a review');
                const result = await call(() => host.publishBatch(request.verdict));
                // Even a partial failure changes threads: the published part is no longer drafts.
                options.reviewFeed?.bumpLocalWrite();
                // A verdict changes PR status: refresh metadata, then send the updated snapshot over SSE.
                // The endpoint response does not wait for this: publication has already completed, and the host's `getPr()` may
                // spend tens of seconds retrying with timeouts. `refresh` swallows its own errors.
                void options.prMeta.refresh();
                // Enqueuing the round task does not hold up the response either: the reviewer has already published.
                options.onPublished?.();
                return respond(uiPublishResponseSchema, { result });
            }),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewFileContent,
            handle: handlingRpcFailures(async (ctx) => {
                const host = hostOf(options);
                const request = uiReviewFileContentRequestSchema.safeParse({
                    fileId: ctx.url.searchParams.get('fileId') ?? '',
                });
                if (!request.success) {
                    throw new RpcFailure('bad_request', 'The file content request is missing the fileId parameter.');
                }

                const getContent = host.getFileContent?.bind(host);
                if (getContent === undefined) {
                    // The UI does not call this with `capabilities.fileContent: false`. A request here means
                    // the versions are out of sync, which needs a readable error message.
                    throw new RpcFailure(
                        'bad_request',
                        'This host cannot provide file contents. "Expand context" is unavailable.',
                    );
                }

                const content = await call(() => getContent(request.data.fileId));
                return respond(uiReviewFileContentResponseSchema, { content });
            }),
        },
        {
            // Image bytes are not JSON: the endpoint writes the response itself (type from magic bytes,
            // permanent immutable cache, 304 for `If-None-Match`).
            method: 'GET',
            path: UI_ENDPOINTS.reviewBlob,
            stream: (ctx) => serveBlob(options, ctx),
        },
        {
            // Progress is scoped to an iteration: the active one (implicit or named explicitly) responds
            // with the current snapshot, a previous one as is (an old snapshot is read-only).
            method: 'GET',
            path: UI_ENDPOINTS.reviewProgress,
            handle: handlingRpcFailures(async (ctx) => {
                const request = parseQuery(
                    uiReviewProgressRequestSchema,
                    { ...optionalParam(ctx, 'diffId') },
                    'reading progress',
                );
                const active = await activeDiffId(options);
                // The server has no iterations at all: all progress lives under `LEGACY_DIFF_ID`, regardless of
                // what the tab calls the only diff. Any `diffId` it sends refers to that diff.
                const single = withoutIterations(options, active);
                const asActive = single || request.diffId === undefined || request.diffId === active;
                const diffId = asActive ? active : (request.diffId ?? active);
                const snapshotId = asActive
                    ? (options.route.read().snapshot?.snapshotId ?? null)
                    : lastSnapshotOf(options, diffId);
                return respond(
                    uiReviewProgressResponseSchema,
                    {
                        // The iteration the response was read from: the tab uses it to check whether it received
                        // its own `fileId`. The server gives the only iteration its internal name,
                        // and the tab uses the name from the diff, so we respond with the tab's name.
                        diffId: single ? (request.diffId ?? diffId) : diffId,
                        files: options.progress.read(diffId),
                        stops: snapshotId === null ? [] : options.progress.readStops(snapshotId),
                        progressRevision: options.progress.revision,
                    },
                    'local',
                );
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewFileViewed,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiSetFileViewedRequestSchema, 'setting a viewed mark');
                // The local record is the source of truth. The host learns about it next, and only if it supports it.
                const active = await activeDiffId(options);
                const diffId = writtenIteration(options, active, [request.fileId]);
                let progressRevision = options.progress.setFileViewed(
                    diffId,
                    request.fileId,
                    request.viewed,
                    options.route.read().snapshot?.snapshotId ?? null,
                );
                if (diffId !== active) {
                    progressRevision = carryFileViewed(
                        options,
                        diffId,
                        active,
                        request.fileId,
                        request.viewed,
                        progressRevision,
                    );
                }
                mirrorFileViewed(request.fileId, request.viewed);
                return respond(uiSetFileViewedResponseSchema, { progressRevision }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewStopViewed,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(
                    ctx,
                    uiSetStopViewedRequestSchema,
                    'setting a viewed mark on a stop',
                );
                // The stop mark itself stays local. The UI separately reports files becoming read through its ranges
                // via reviewViewedMirror, once it recalculates diff coverage.
                const activeSnapshotId = options.route.read().snapshot?.snapshotId ?? null;
                const stale = request.snapshotId !== undefined && request.snapshotId !== activeSnapshotId;
                // Stop marks are keyed by snapshot: without a route, there is nowhere to write them.
                if (stale || activeSnapshotId === null) {
                    return respond(
                        uiSetStopViewedResponseSchema,
                        { progressRevision: options.progress.revision },
                        'local',
                    );
                }
                const active = await activeDiffId(options);
                let progressRevision = options.progress.revision;
                for (const write of stopWrites(options, active, request)) {
                    progressRevision = options.progress.setStopViewed(
                        activeSnapshotId,
                        write.diffId,
                        request.stopId,
                        request.viewed,
                        write.ranges,
                    );
                }
                return respond(uiSetStopViewedResponseSchema, { progressRevision }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewStopFileViewed,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(
                    ctx,
                    uiSetStopFileViewedRequestSchema,
                    'setting a viewed mark on a file in a stop',
                );
                const activeSnapshotId = options.route.read().snapshot?.snapshotId ?? null;
                const stale = request.snapshotId !== undefined && request.snapshotId !== activeSnapshotId;
                if (stale || activeSnapshotId === null) {
                    return respond(
                        uiSetStopFileViewedResponseSchema,
                        { progressRevision: options.progress.revision },
                        'local',
                    );
                }
                const active = await activeDiffId(options);
                let progressRevision = options.progress.revision;
                for (const target of writeTargets(options, active, [request.fileId])) {
                    const fileId = target.fileIdOf(request.fileId);
                    if (fileId === undefined) {
                        continue;
                    }
                    progressRevision = options.progress.setStopFileViewed(
                        activeSnapshotId,
                        target.diffId,
                        request.stopId,
                        fileId,
                        request.viewed,
                        request.ranges,
                    );
                }
                return respond(uiSetStopFileViewedResponseSchema, { progressRevision }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewViewedMirror,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(
                    ctx,
                    uiViewedMirrorRequestSchema,
                    'mirroring files becoming viewed',
                );
                for (const entry of request.entries) {
                    mirrorFileViewed(entry.fileId, entry.viewed);
                }
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewLenses,
            handle: handlingRpcFailures(async () => {
                const host = hostOf(options);
                const [ownership, extra] = await call(() =>
                    Promise.all([host.ownershipLens(), host.extraLenses()]),
                );
                return respond(uiReviewLensesResponseSchema, {
                    ownership,
                    extra,
                    ownershipSource: host.ownershipSource,
                });
            }),
        },
    ];
}

/**
 * Image side bytes by `ImageSide.blobId`. The order is cache, host, cache write: the blob addresses
 * content, so a second pass and a slice do not call the host. Host misses (`null`) are not cached:
 * they describe the host's current state, not a property of the content.
 */
async function serveBlob(options: ReviewRoutesOptions, ctx: StreamContext): Promise<void> {
    try {
        await writeBlob(options, ctx);
    } catch (error) {
        const failure =
            error instanceof RpcFailure
                ? error
                : new RpcFailure('internal', `Could not retrieve image bytes: ${messageOf(error)}`);
        sendJson(ctx.res, rpcFailureResponse(failure));
    }
}

async function writeBlob(options: ReviewRoutesOptions, ctx: StreamContext): Promise<void> {
    const request = uiReviewBlobRequestSchema.safeParse({
        blobId: ctx.url.searchParams.get('blobId') ?? '',
    });
    if (!request.success) {
        throw new RpcFailure('bad_request', 'The image byte request is missing the blobId parameter.');
    }
    const blobId = request.data.blobId;
    const etag = etagOf(blobId);

    if (ctx.req.headers['if-none-match'] === etag) {
        // The contents at this ID cannot change, so no body is needed.
        ctx.res.writeHead(304, cacheHeaders(etag));
        ctx.res.end();
        return;
    }

    const cached = (await options.blobs?.read(blobId)) ?? null;
    if (cached !== null) {
        sendBytes(ctx.res, cached, etag);
        return;
    }

    const host = hostOf(options);
    const getBlob = host.getBlob?.bind(host);
    if (getBlob === undefined) {
        // The UI does not call this with `capabilities.blobs: false`. A request means the versions are out of sync.
        throw new RpcFailure(
            'bad_request',
            'This host cannot provide file bytes. Images in the diff are unavailable.',
        );
    }

    const bytes = await call(() => getBlob(blobId));
    if (bytes === null) {
        throw new RpcFailure('not_found', 'The host has no such blob, or the side is too large.');
    }
    await options.blobs?.write(blobId, bytes);
    sendBytes(ctx.res, bytes, etag);
}

function sendBytes(res: ServerResponse, bytes: Uint8Array, etag: string): void {
    res.writeHead(200, {
        'content-type': sniffImageMime(bytes),
        'content-length': String(bytes.byteLength),
        ...cacheHeaders(etag),
    });
    res.end(bytes);
}

function cacheHeaders(etag: string): Record<string, string> {
    return {
        // The blob is content-addressed: there is nothing to revalidate, and no reason to do so.
        'cache-control': 'private, max-age=31536000, immutable',
        etag,
        'x-content-type-options': 'nosniff',
    };
}

/** ETag from an opaque ID: quotes and backslashes inside the value are escaped. */
function etagOf(blobId: string): string {
    return `"${blobId.replace(/["\\]/g, '\\$&')}"`;
}

/**
 * Image type from magic bytes. Do not trust the path extension: the type goes to the browser, and
 * the contents must identify themselves. Unrecognized content is `application/octet-stream`.
 */
export function sniffImageMime(bytes: Uint8Array): string {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) {
        return 'image/png';
    }
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
        return 'image/jpeg';
    }
    if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
        return 'image/gif';
    }
    if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
        return 'image/webp';
    }
    if (startsWith(bytes, [0x42, 0x4d])) {
        return 'image/bmp';
    }
    if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) {
        return 'image/x-icon';
    }
    return looksLikeSvg(bytes) ? 'image/svg+xml' : 'application/octet-stream';
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
    return prefix.every((byte, index) => bytes[index] === byte);
}

/** XML prolog and comments before the root tag: enough text to find `<svg`. */
const SVG_PROLOG_MAX_CHARS = 4096;

/** Text whose first tag is `<svg`: skips a prolog, comments and BOM before it. */
function looksLikeSvg(bytes: Uint8Array): boolean {
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, SVG_PROLOG_MAX_CHARS));
    } catch {
        return false;
    }

    let rest = text.replace(/^\ufeff/, '').trimStart();
    while (rest.startsWith('<?') || rest.startsWith('<!')) {
        const end = rest.startsWith('<!--') ? rest.indexOf('-->') + 3 : rest.indexOf('>') + 1;
        if (end <= 0) {
            return false;
        }
        rest = rest.slice(end).trimStart();
    }
    return /^<svg[\s>/]/i.test(rest);
}

/**
 * One iteration's diff. The active one (or one the feed does not know about yet) comes from the host,
 * since only it knows the latest `viewed` marks. A previous one comes from local patch storage, because
 * `getDiff` accepts only a slice, not "the diff of iteration N".
 */
async function diffOfIteration(
    options: ReviewRoutesOptions,
    host: ReviewHost,
    diffId: string | undefined,
): Promise<PrDiff> {
    const active = options.iterationFeed?.active() ?? null;
    if (diffId === undefined || active === null || active.diffId === diffId) {
        const diff = await call(() => host.getDiff());
        // The active iteration's patch is saved to storage (docs/product.md §4a). The endpoint response does not wait for it.
        const iterations = options.iterations;
        if (iterations != null) {
            void rememberIterationDiff(iterations, host, diff);
        }
        if (diffId === undefined || diff.diffId === diffId) {
            return diff;
        }
    }

    const stored = options.iterations?.get(diffId) ?? null;
    if (stored === null) {
        throw new RpcFailure('bad_request', `The diff for iteration ${diffId} was not saved. There is nothing to display.`);
    }
    return stored.diff;
}

/** The host computes a slice between iterations, the local cache retains it (the host takes 2.8–3.7 s). */
async function interdiffOf(
    options: ReviewRoutesOptions,
    host: ReviewHost,
    base: string,
    head: string,
): Promise<PrDiff> {
    if (options.prMeta.get()?.capabilities.iterations === false) {
        throw new RpcFailure(
            'bad_request',
            'This host cannot provide slices between iterations. "What is new" is unavailable.',
        );
    }
    const iterations = options.iterations;
    if (iterations == null) {
        return call(() => host.getDiff({ base, head }));
    }
    return call(() => iterations.getInterdiff(base, head, () => host.getDiff({ base, head })));
}

/**
 * The iteration progress writes to. The feed may not have started yet (SSE is not open), so the list
 * is fetched on demand. Without a host, the server uses a single "iteration", `LEGACY_DIFF_ID`.
 */
async function activeDiffId(options: ReviewRoutesOptions): Promise<string> {
    const active = (await options.iterationFeed?.resolveActive()) ?? null;
    return active?.diffId ?? LEGACY_DIFF_ID;
}

/** Latest snapshot of the iteration: iteration progress shows its stop marks. */
function lastSnapshotOf(options: ReviewRoutesOptions, diffId: string): string | null {
    const own = options.route.listSnapshots().filter((snapshot) => snapshot.diffId === diffId);
    return own.at(-1)?.snapshotId ?? null;
}

/**
 * Whether the server uses a single iteration: there is no host, or the host has no iterations. Then all
 * progress lives under `LEGACY_DIFF_ID`, and any `diffId` from the tab refers to it.
 *
 * A host with iterations whose list has not arrived yet (`listIterations` failed) does not qualify:
 * treating a previous iteration as active would return progress from another iteration.
 */
function withoutIterations(options: ReviewRoutesOptions, active: string): boolean {
    return (
        active === LEGACY_DIFF_ID &&
        (options.iterationFeed == null || options.prMeta.get()?.capabilities.iterations === false)
    );
}

/**
 * The current snapshot's iteration, when it differs from the active one and its diff is saved. This is the stale
 * window: a push has arrived, but the tab still renders the snapshot's diff. `null` means there is no such window.
 */
function snapshotIteration(options: ReviewRoutesOptions, active: string): string | null {
    const snapshotDiffId = options.route.read().snapshot?.diffId ?? null;
    if (snapshotDiffId === null || snapshotDiffId === active || withoutIterations(options, active)) {
        return null;
    }
    return options.iterations?.get(snapshotDiffId) == null ? null : snapshotDiffId;
}

/**
 * The iteration a mark is written under: usually the active one, but during the stale window the tab
 * still renders the snapshot iteration's diff, so the mark must go under that iteration. Otherwise it will not return
 * when progress for the same diff is read again.
 *
 * There are two candidates: the active iteration and the current snapshot's iteration. The tab cannot show
 * any others with marks enabled, since a previous snapshot is read-only.
 */
function writtenIteration(options: ReviewRoutesOptions, active: string, fileIds: readonly string[]): string {
    const snapshotDiffId = snapshotIteration(options, active);
    if (snapshotDiffId === null || fileIds.length === 0) {
        return active;
    }
    const own = new Set((options.iterations?.get(snapshotDiffId)?.diff.files ?? []).map((file) => file.fileId));
    return fileIds.every((fileId) => own.has(fileId)) ? snapshotDiffId : active;
}

/** Where the ranges of one stop mark go: the iteration and its translated `fileId`. */
interface StopWrite {
    readonly diffId: string;
    readonly ranges: readonly UiStopSeenRange[];
}

/** The iteration a mark goes under, and its `fileId` translation. `undefined` means the file cannot be translated. */
interface WriteTarget {
    readonly diffId: string;
    readonly fileIdOf: (fileId: string) => string | undefined;
}

/**
 * Iterations for one mark with ranges. Normally there is one, the active iteration.
 * During the stale window there are two: the iteration the tab rendered and the active one.
 * Carryover for the pair runs once and has already happened by this point. Without the second write, the ranges
 * would disappear when the route is rebuilt. Only files untouched by the slice are translated to the active iteration.
 */
function writeTargets(options: ReviewRoutesOptions, active: string, fileIds: readonly string[]): readonly WriteTarget[] {
    const drawn = writtenIteration(options, active, fileIds);
    if (drawn === active) {
        return [{ diffId: active, fileIdOf: sameFileId }];
    }
    const carried = carriedFileIds(options, drawn, active);
    return [
        { diffId: drawn, fileIdOf: sameFileId },
        { diffId: active, fileIdOf: (fileId) => carried?.get(fileId) },
    ];
}

function sameFileId(fileId: string): string {
    return fileId;
}

/**
 * Writes for one stop mark by `writeTargets`: a stop without translatable files still
 * gets written to the active iteration with an empty set.
 *
 * Clearing a mark sends no ranges, so they cannot tell us which iteration the tab rendered:
 * both iterations it could have shown are cleared.
 */
function stopWrites(
    options: ReviewRoutesOptions,
    active: string,
    request: z.infer<typeof uiSetStopViewedRequestSchema>,
): readonly StopWrite[] {
    if (!request.viewed) {
        const drawn = snapshotIteration(options, active);
        const wiped = drawn === null ? [active] : [drawn, active];
        return wiped.map((diffId) => ({ diffId, ranges: [] }));
    }
    const targets = writeTargets(
        options,
        active,
        request.ranges.map((range) => range.fileId),
    );
    return targets.map((target) => ({
        diffId: target.diffId,
        ranges: request.ranges.flatMap((range) => {
            const fileId = target.fileIdOf(range.fileId);
            return fileId === undefined ? [] : [{ ...range, fileId }];
        }),
    }));
}

/**
 * A mark made during the stale window is repeated on the active iteration: carryover for the pair
 * runs once and has already happened by this point. Without the second write, the mark would disappear
 * when the route is rebuilt.
 */
function carryFileViewed(
    options: ReviewRoutesOptions,
    from: string,
    active: string,
    fileId: string,
    viewed: boolean,
    revision: number,
): number {
    const target = carriedFileIds(options, from, active)?.get(fileId) ?? null;
    return target === null ? revision : options.progress.setFileViewed(active, target, viewed, null);
}

/**
 * Translates `fileId` from iteration `from` to the active one by file path. Only a file
 * untouched by the slice is translated: its contents are the same in both iterations, so the mark is
 * valid. No slice available (the host does not support them, or it has not been computed yet) means no translation:
 * falsely marking a changed file is worse than losing a mark.
 */
function carriedFileIds(
    options: ReviewRoutesOptions,
    from: string,
    active: string,
): ReadonlyMap<string, string> | null {
    const iterations = options.iterations;
    if (iterations == null) {
        return null;
    }
    const source = iterations.get(from)?.diff.files ?? null;
    const target = iterations.get(active)?.diff.files ?? null;
    const interdiff = iterations.peekInterdiff(from, active);
    if (source === null || target === null || interdiff === null) {
        return null;
    }
    const touched = new Set<string>();
    for (const file of interdiff.files) {
        touched.add(file.path);
        if (file.oldPath != null) {
            touched.add(file.oldPath);
        }
    }
    const idOfPath = new Map<string, string>();
    for (const file of target) {
        // The first file with this path wins, as in `indexDiff`.
        if (!idOfPath.has(file.path)) {
            idOfPath.set(file.path, file.fileId);
        }
    }
    const carried = new Map<string, string>();
    for (const file of source) {
        const id = touched.has(file.path) ? undefined : idOfPath.get(file.path);
        if (id !== undefined) {
            carried.set(file.fileId, id);
        }
    }
    return carried;
}

/** A query parameter, if present: a missing key in the parsed object means "not specified". */
export function optionalParam(ctx: RequestContext, name: string): Record<string, string> {
    const value = ctx.url.searchParams.get(name);
    return value === null ? {} : { [name]: value };
}

/** Parses the query against the contract schema. `what` appears in the rejection message as "request for what". */
export function parseQuery<T>(schema: z.ZodType<T>, query: unknown, what: string): T {
    const parsed = schema.safeParse(query);
    if (!parsed.success) {
        throw new RpcFailure(
            'bad_request',
            `The query parameters for ${what} failed contract validation.`,
            parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        );
    }
    return parsed.data;
}

/** Request body under the contract schema. `what` appears in the rejection message as "request for what". */
export async function readRequest<T>(ctx: RequestContext, schema: z.ZodType<T>, what: string): Promise<T> {
    const parsed = schema.safeParse(await readJsonBody(ctx.req));
    if (!parsed.success) {
        throw new RpcFailure(
            'bad_request',
            `The request for ${what} failed contract validation.`,
            parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        );
    }
    return parsed.data;
}

/** An indeterminate delete response counts as success if a fresh snapshot no longer contains the comment. */
async function deleteDraftConvergently(host: ReviewHost, commentId: string): Promise<void> {
    try {
        await call(() => host.deleteDraft(commentId));
    } catch (deleteError) {
        let threads: Awaited<ReturnType<ReviewHost['getThreads']>>;
        try {
            threads = await call(() => host.getThreads());
        } catch {
            throw deleteError;
        }
        const contains = threads.some((thread) => {
            const visit = (comment: typeof thread.root): boolean =>
                comment.id === commentId || comment.replies.some(visit);
            return visit(thread.root);
        });
        if (contains) {
            throw deleteError;
        }
    }
}

/** Writes for one key reach the host in the order the server received them, even if the previous write failed. */
function createKeyedWriteQueue<T>(write: (key: string, value: T) => Promise<void>): (key: string, value: T) => Promise<void> {
    const queues = new Map<string, Promise<void>>();

    return (key, value) => {
        const request = (queues.get(key) ?? Promise.resolve()).then(() => write(key, value));
        const tail = request.then(
            () => undefined,
            () => undefined,
        );
        queues.set(key, tail);
        void tail.then(() => {
            if (queues.get(key) === tail) {
                queues.delete(key);
            }
        });
        return request;
    };
}

/**
 * Mirroring a mark to the host (`capabilities.fileViewedSync`) is best-effort after the local
 * write: failure does not roll it back and is not an endpoint error. Method availability matches
 * the capability by contract (checked by the host contract suite), so there is no extra `getPr`
 * just to read the flag.
 *
 * Per-file queue: host network calls (with retries inside the adapter) can finish in the reverse
 * order of the marks, leaving the host with a value the reviewer has already undone. A value
 * that is stale by the time its turn comes is not mirrored at all. The next write supersedes it.
 */
function createViewedMirror(host: ReviewHost | null): (fileId: string, viewed: boolean) => void {
    const setFileViewed = host?.setFileViewed?.bind(host);
    if (setFileViewed === undefined) {
        return () => undefined;
    }

    const queues = new Map<string, Promise<void>>();
    const latest = new Map<string, number>();
    let seq = 0;

    return (fileId, viewed) => {
        const mine = (seq += 1);
        latest.set(fileId, mine);
        const queued = (queues.get(fileId) ?? Promise.resolve())
            .then(async () => {
                if (latest.get(fileId) === mine) {
                    await setFileViewed(fileId, viewed);
                }
            })
            .catch((error: unknown) => {
                process.stderr.write(
                    `sherpa-server: the host did not accept the viewed mark for ${fileId}: ${messageOf(error)}\n`,
                );
            });
        queues.set(fileId, queued);
        void queued.then(() => {
            // The file queue is empty, so forget it. Otherwise the map would grow throughout the session.
            if (queues.get(fileId) === queued) {
                queues.delete(fileId);
                latest.delete(fileId);
            }
        });
    };
}

/**
 * Optional host method. The UI does not call this with the capability flag off. A request here means
 * the versions are out of sync, which needs a readable error message instead of a crash.
 */
function hostMethod<T extends (...args: never[]) => Promise<void>>(method: T | undefined, why: string): T {
    if (method === undefined) {
        throw new RpcFailure('bad_request', why);
    }
    return method;
}

function hostOf(options: ReviewRoutesOptions): ReviewHost {
    if (options.host === null) {
        throw new RpcFailure(
            'no_review_host',
            'This review has no host adapter. The key was not recognized as hosted, local or fixture.',
        );
    }
    return options.host;
}

/** An adapter error without a contract code is a host failure, not an internal failure on our side. */
async function call<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof RpcFailure) {
            throw error;
        }
        throw new RpcFailure('host_unavailable', `Host adapter failed: ${messageOf(error)}`);
    }
}

/**
 * The response body is checked against the contract schema: invalid data never leaves the server (docs/testing.md).
 * `local` means the server built the response itself (reading progress), so any mismatch is its own fault.
 */
export function respond<T>(schema: z.ZodType<T>, body: unknown, source: 'host' | 'local' = 'host'): JsonResponse {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        throw new RpcFailure(
            source === 'host' ? 'host_unavailable' : 'internal',
            source === 'host'
                ? 'The host response did not match the review contract.'
                : 'The server response did not match the review contract.',
            parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        );
    }
    return { status: 200, body: parsed.data };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
