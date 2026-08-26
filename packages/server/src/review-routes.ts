import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { ReviewHost, UiOpenInEditorResponse } from '@sherpa/protocol';
import {
    UI_ENDPOINTS,
    uiDeleteDraftRequestSchema,
    uiOpenInEditorRequestSchema,
    uiOpenInEditorResponseSchema,
    uiReviewDiffResponseSchema,
    uiReviewFileContentRequestSchema,
    uiReviewFileContentResponseSchema,
    uiReviewLensesResponseSchema,
    uiReviewPrResponseSchema,
    uiReviewProgressResponseSchema,
    uiReviewThreadsResponseSchema,
    uiReviewWriteAckSchema,
    uiPublishRequestSchema,
    uiPublishResponseSchema,
    uiSaveDraftRequestSchema,
    uiSaveDraftResponseSchema,
    uiSetFileViewedRequestSchema,
    uiSetFileViewedResponseSchema,
    uiSetThreadResolvedRequestSchema,
    uiUpdateDraftRequestSchema,
} from '@sherpa/protocol';
import type { z } from 'zod';

import { RpcFailure } from './errors.js';
import type { JsonResponse, RequestContext, Route } from './http.js';
import { handlingRpcFailures, readJsonBody } from './http.js';
import type { ProgressStore } from './progress-store.js';
import type { ReviewFeed } from './review-feed.js';

/**
 * UI review endpoints (M1-T10): PR metadata, active iteration diff, threads, lenses and file content.
 * "Open in external editor" lives here too. It does not involve the host, but belongs alongside
 * the other reader endpoints.
 *
 * Fail-closed in both directions: the adapter validates host responses against its schemas, and the server validates
 * what it sends to the UI against the contract schemas. No host (prKey did not map to anything) means `no_review_host`.
 * A host failure (network, token, invalid response) means `host_unavailable` with a readable reason.
 *
 * Reading progress (T8) is the exception. It is local, stored in this PR SQLite DB, and works without a host.
 * Its endpoints never return `no_review_host`.
 */

/** Default editor command: VS Code with a jump to the line. */
const DEFAULT_EDITOR_COMMAND = 'code -g {file}:{line}';

export interface EditorOptions {
    /** Root for resolving diff paths. Defaults to the server's cwd (the checkout). */
    readonly cwd?: string;
    /** Command template. Defaults to `SHERPA_EDITOR`, then `DEFAULT_EDITOR_COMMAND`. */
    readonly command?: string;
    /** Command runner. Tests replace it to avoid opening an editor. */
    readonly launch?: (command: string, args: readonly string[]) => Promise<void>;
}

export interface ReviewRoutesOptions {
    readonly host: ReviewHost | null;
    /** Thread revision: a successful local write wakes SSE clients immediately. */
    readonly reviewFeed: ReviewFeed | null;
    /** Reading progress for this PR: the local source of truth for viewed marks. */
    readonly progress: ProgressStore;
    readonly editor?: EditorOptions;
}

export function createReviewRoutes(options: ReviewRoutesOptions): Route[] {
    const mirrorFileViewed = createViewedMirror(options.host);
    const updateDraft = createKeyedWriteQueue((commentId: string, body: string) => {
        const host = hostOf(options);
        return call(() => host.updateDraft(commentId, body));
    });
    const setThreadResolved = createKeyedWriteQueue((threadId: string, resolved: boolean) => {
        const host = hostOf(options);
        return call(() => host.setThreadResolved(threadId, resolved));
    });
    return [
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewPr,
            handle: handlingRpcFailures(async () => {
                const host = hostOf(options);
                return respond(uiReviewPrResponseSchema, { pr: await call(() => host.getPr()) });
            }),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewDiff,
            handle: handlingRpcFailures(async () => {
                const host = hostOf(options);
                return respond(uiReviewDiffResponseSchema, { diff: await call(() => host.getDiff()) });
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
                const host = hostOf(options);
                const request = await readRequest(ctx, uiSaveDraftRequestSchema, 'saving a draft');
                const comment = await call(() => host.saveDraft(request.draft));
                options.reviewFeed?.bumpLocalWrite();
                return respond(uiSaveDraftResponseSchema, { comment });
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewUpdateDraft,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiUpdateDraftRequestSchema, 'updating a draft');
                await updateDraft(request.commentId, request.body);
                options.reviewFeed?.bumpLocalWrite();
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewDeleteDraft,
            handle: handlingRpcFailures(async (ctx) => {
                const host = hostOf(options);
                const request = await readRequest(ctx, uiDeleteDraftRequestSchema, 'deleting a draft');
                await deleteDraftConvergently(host, request.commentId);
                options.reviewFeed?.bumpLocalWrite();
                return respond(uiReviewWriteAckSchema, { acknowledged: true }, 'local');
            }),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewThreadResolved,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiSetThreadResolvedRequestSchema, 'changing thread status');
                await setThreadResolved(request.threadId, request.resolved);
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
            method: 'POST',
            path: UI_ENDPOINTS.openInEditor,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiOpenInEditorRequestSchema, '"open in editor"');
                const body = await openInEditor(request.path, request.line, options.editor ?? {});
                return respond(uiOpenInEditorResponseSchema, body);
            }),
        },
        {
            method: 'GET',
            path: UI_ENDPOINTS.reviewProgress,
            handle: handlingRpcFailures(() =>
                respond(
                    uiReviewProgressResponseSchema,
                    { files: options.progress.read(), progressRevision: options.progress.revision },
                    'local',
                ),
            ),
        },
        {
            method: 'POST',
            path: UI_ENDPOINTS.reviewFileViewed,
            handle: handlingRpcFailures(async (ctx) => {
                const request = await readRequest(ctx, uiSetFileViewedRequestSchema, 'setting a viewed mark');
                // The local record is the source of truth. The host learns about it next, and only if it supports it.
                const progressRevision = options.progress.setFileViewed(request.fileId, request.viewed);
                mirrorFileViewed(request.fileId, request.viewed);
                return respond(uiSetFileViewedResponseSchema, { progressRevision }, 'local');
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
                return respond(uiReviewLensesResponseSchema, { ownership, extra });
            }),
        },
    ];
}

/** Request body under the contract schema. `what` appears in the rejection message as "request for what". */
async function readRequest<T>(ctx: RequestContext, schema: z.ZodType<T>, what: string): Promise<T> {
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
 * Opens a file in an external editor (MUST in the brief). Every failure returns `unavailable`
 * with a reason, shown as an inline hint rather than a UI error.
 */
async function openInEditor(
    filePath: string,
    line: number | undefined,
    options: EditorOptions,
): Promise<UiOpenInEditorResponse> {
    const cwd = options.cwd ?? process.cwd();
    const absolute = path.resolve(cwd, filePath);
    // The path comes from the host diff and must stay within the checkout.
    const relative = path.relative(cwd, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return { outcome: 'unavailable', message: `Path ${filePath} points outside the checkout ${cwd}.` };
    }

    const exists = await stat(absolute).then(
        (info) => info.isFile(),
        () => false,
    );
    if (!exists) {
        return {
            outcome: 'unavailable',
            message: `File ${relative} is not on disk: the server runs in ${cwd}, and the file is not there.`,
        };
    }

    const template = options.command ?? process.env.SHERPA_EDITOR ?? DEFAULT_EDITOR_COMMAND;
    const parts = template
        .split(/\s+/)
        .filter((part) => part !== '')
        .map((part) => part.replaceAll('{file}', absolute).replaceAll('{line}', String(line ?? 1)));
    const [command, ...args] = parts;
    if (command === undefined) {
        return { outcome: 'unavailable', message: 'The editor command is empty: check SHERPA_EDITOR.' };
    }

    try {
        await (options.launch ?? launchDetached)(command, args);
    } catch (error) {
        return {
            outcome: 'unavailable',
            message: `Could not start "${template}": ${messageOf(error)}.`,
        };
    }
    return { outcome: 'opened', message: null };
}

/**
 * Starts the editor separately from the server. It outlives Sherpa and does not keep it running.
 * The promise waits only until it is clear whether the process started.
 */
function launchDetached(command: string, args: readonly string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, [...args], { detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
}

function hostOf(options: ReviewRoutesOptions): ReviewHost {
    if (options.host === null) {
        throw new RpcFailure(
            'no_review_host',
            'This PR has no host adapter: its PR key is not recognized as a supported host or fixture key.',
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
 * The contract schema validates the response body. Invalid data never leaves the server (requirements §7).
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
