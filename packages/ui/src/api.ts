import type {
    ChatExchange,
    Comment,
    CommentDraft,
    FileContent,
    PrDiff,
    PriorityClass,
    PublishResult,
    Thread,
    UiCancelResponse,
    UiChatAskAnchor,
    UiChatCancelResponse,
    UiChatResponse,
    UiChatRetryResponse,
    UiEnqueueResponse,
    UiFeedbackRequest,
    UiFeedbackResponse,
    UiOpenInEditorResponse,
    UiPrState,
    UiPrStatePatch,
    UiReviewLensesResponse,
    UiReviewProgressResponse,
    UiRouteFillStopRequest,
    UiRouteFillStopResponse,
    UiRouteGenerateResponse,
    UiReviewRouteResponse,
    UiSetFileViewedResponse,
    UiSetStopViewedResponse,
    UiSettings,
    UiSettingsPatch,
    UiSnapshotSummary,
    UiStopSeenRange,
    UiTask,
    UiViewedMirrorRequest,
    Verdict,
} from '@sherpa/protocol';
import {
    rpcErrorSchema,
    UI_ENDPOINTS,
    uiCancelResponseSchema,
    uiChatAskResponseSchema,
    uiChatCancelResponseSchema,
    uiChatResponseSchema,
    uiChatRetryResponseSchema,
    uiEnqueueResponseSchema,
    uiFeedbackResponseSchema,
    uiOpenInEditorResponseSchema,
    uiPrStateResponseSchema,
    uiPublishResponseSchema,
    uiReviewDiffResponseSchema,
    uiReviewFileContentResponseSchema,
    uiReviewLensesResponseSchema,
    uiReviewProgressResponseSchema,
    uiReviewRouteResponseSchema,
    uiReviewSnapshotsResponseSchema,
    uiReviewThreadsResponseSchema,
    uiReviewWriteAckSchema,
    uiRouteFillStopResponseSchema,
    uiRouteGenerateResponseSchema,
    uiSaveDraftResponseSchema,
    uiSetFileViewedResponseSchema,
    uiSetStopViewedResponseSchema,
    uiSettingsResponseSchema,
} from '@sherpa/protocol';
import type { z } from 'zod';

/**
 * UI actions (rpc-design §2): regular REST with a bearer token. Protocol schemas validate
 * responses. The UI consumes nothing that has not passed validation.
 */

/** An error the reviewer can see as is: the contract messages are already readable. */
export class ApiError extends Error {
    constructor(message: string, readonly status: number | null = null) {
        super(message);
    }
}

export async function enqueueEchoTask(token: string, text: string, priority?: PriorityClass): Promise<UiTask> {
    const body: UiEnqueueResponse = await post(
        UI_ENDPOINTS.enqueue,
        token,
        priority === undefined ? { type: 'echo', text } : { type: 'echo', text, priority },
        uiEnqueueResponseSchema,
    );
    return body.task;
}

export async function cancelTask(token: string, taskId: number): Promise<UiCancelResponse['outcome']> {
    const body: UiCancelResponse = await post(UI_ENDPOINTS.cancel, token, { taskId }, uiCancelResponseSchema);
    return body.outcome;
}

/** Active iteration diff, or a saved iteration with `diffId` (snapshot picker, M4). */
export async function fetchReviewDiff(token: string, diffId?: string | null): Promise<PrDiff> {
    return (await get(withQuery(UI_ENDPOINTS.reviewDiff, { diffId }), token, uiReviewDiffResponseSchema)).diff;
}

/** File filter lenses: ownership is separate from extra lenses (README §Filters). */
export async function fetchReviewLenses(token: string): Promise<UiReviewLensesResponse> {
    return get(UI_ENDPOINTS.reviewLenses, token, uiReviewLensesResponseSchema);
}

/** Full thread snapshot. Refetched when `threadsRevision` increases. */
export async function fetchReviewThreads(token: string): Promise<Thread[]> {
    return (await get(UI_ENDPOINTS.reviewThreads, token, uiReviewThreadsResponseSchema)).threads;
}

export async function saveReviewDraft(token: string, draft: CommentDraft): Promise<Comment> {
    return (await post(UI_ENDPOINTS.reviewSaveDraft, token, { draft }, uiSaveDraftResponseSchema)).comment;
}

export async function updateReviewDraft(token: string, commentId: string, body: string, issue?: boolean): Promise<void> {
    await post(UI_ENDPOINTS.reviewUpdateDraft, token, { commentId, body, issue }, uiReviewWriteAckSchema);
}

export async function deleteReviewDraft(token: string, commentId: string): Promise<void> {
    await post(UI_ENDPOINTS.reviewDeleteDraft, token, { commentId }, uiReviewWriteAckSchema);
}

export async function setReviewThreadResolved(token: string, threadId: string, resolved: boolean): Promise<void> {
    await post(UI_ENDPOINTS.reviewThreadResolved, token, { threadId, resolved }, uiReviewWriteAckSchema);
}

/** Publishes accumulated drafts and applies the verdict only if the entire batch succeeds. */
export async function publishReview(token: string, verdict: Verdict): Promise<PublishResult> {
    return (await post(UI_ENDPOINTS.reviewPublish, token, { verdict }, uiPublishResponseSchema)).result;
}

/**
 * File contents for "Expand context". Called only with `capabilities.fileContent`.
 * `null` means this file has no available contents (binary or too large).
 */
export async function fetchFileContent(token: string, fileId: string): Promise<FileContent | null> {
    const path = `${UI_ENDPOINTS.reviewFileContent}?fileId=${encodeURIComponent(fileId)}`;
    return (await get(path, token, uiReviewFileContentResponseSchema)).content;
}

/**
 * PR reading progress (T8): explicit marks and seen ranges. The endpoint is local, so it also works when
 * the PR has no review host.
 */
export async function fetchReviewProgress(
    token: string,
    diffId?: string | null,
): Promise<UiReviewProgressResponse> {
    return get(withQuery(UI_ENDPOINTS.reviewProgress, { diffId }), token, uiReviewProgressResponseSchema);
}

/** Explicit "viewed" mark. Returns the progress revision after the write. */
export async function setFileViewed(
    token: string,
    fileId: string,
    viewed: boolean,
): Promise<UiSetFileViewedResponse> {
    return post(UI_ENDPOINTS.reviewFileViewed, token, { fileId, viewed }, uiSetFileViewedResponseSchema);
}

/**
 * A stop's "viewed" mark (M2-T7) sends the visible snapshot ID
 * and seen ranges with it. With `viewed: false`, the server deletes this stop's saved ranges.
 */
export async function setStopViewed(
    token: string,
    snapshotId: string,
    stopId: string,
    viewed: boolean,
    ranges: readonly UiStopSeenRange[],
): Promise<UiSetStopViewedResponse> {
    return post(
        UI_ENDPOINTS.reviewStopViewed,
        token,
        { snapshotId, stopId, viewed, ranges },
        uiSetStopViewedResponseSchema,
    );
}

/** Mirrors read transitions from coverage. This endpoint does not change local progress. */
export async function mirrorViewedFiles(token: string, entries: UiViewedMirrorRequest['entries']): Promise<void> {
    await post(UI_ENDPOINTS.reviewViewedMirror, token, { entries }, uiReviewWriteAckSchema);
}

/**
 * Route state (M2): phase, snapshot and revision. The endpoint is local and works without a review host,
 * Refetched when `routeRevision` from SSE increases.
 */
export async function fetchReviewRoute(
    token: string,
    snapshotId?: string | null,
): Promise<UiReviewRouteResponse> {
    return get(withQuery(UI_ENDPOINTS.reviewRoute, { snapshot: snapshotId }), token, uiReviewRouteResponseSchema);
}

/**
 * PR snapshots for the picker (M4-T9). A server without this endpoint returns 404.
 * The caller falls back to the single current snapshot without showing an error in the UI.
 */
export async function fetchReviewSnapshots(token: string): Promise<readonly UiSnapshotSummary[]> {
    return (await get(UI_ENDPOINTS.reviewSnapshots, token, uiReviewSnapshotsResponseSchema)).snapshots;
}

/**
 * Start or restart route generation: "Retry" on the failure card (README §12)
 * and the palette command. The request has no body because the server knows what to generate.
 */
export async function generateReviewRoute(token: string): Promise<UiRouteGenerateResponse['outcome']> {
    const body: UiRouteGenerateResponse = await post(
        UI_ENDPOINTS.reviewRouteGenerate,
        token,
        {},
        uiRouteGenerateResponseSchema,
    );
    return body.outcome;
}

/** Fills one failed slot in the current snapshot without rebuilding the entire route. */
export async function fillRouteStop(
    token: string,
    request: UiRouteFillStopRequest,
): Promise<UiRouteFillStopResponse['outcome']> {
    const body: UiRouteFillStopResponse = await post(
        UI_ENDPOINTS.reviewRouteFillStop,
        token,
        request,
        uiRouteFillStopResponseSchema,
    );
    return body.outcome;
}

/** Full chat and note snapshot. Refetched when `chatRevision` increases. */
export async function fetchReviewChat(token: string): Promise<UiChatResponse> {
    return get(UI_ENDPOINTS.reviewChat, token, uiChatResponseSchema);
}

/** Enqueues a question about the selection or the whole PR. Shows the created exchange optimistically. */
export async function askReviewChat(token: string, text: string, anchor?: UiChatAskAnchor): Promise<ChatExchange> {
    return (
        await post(
            UI_ENDPOINTS.reviewChatAsk,
            token,
            anchor === undefined ? { text } : { text, anchor },
            uiChatAskResponseSchema,
        )
    ).exchange;
}

export async function cancelReviewChat(
    token: string,
    exchangeId: number,
): Promise<UiChatCancelResponse['outcome']> {
    return (
        await post(UI_ENDPOINTS.reviewChatCancel, token, { exchangeId }, uiChatCancelResponseSchema)
    ).outcome;
}

export async function retryReviewChat(
    token: string,
    exchangeId: number,
): Promise<UiChatRetryResponse['outcome']> {
    return (
        await post(UI_ENDPOINTS.reviewChatRetry, token, { exchangeId }, uiChatRetryResponseSchema)
    ).outcome;
}

export async function deleteReviewChatNote(token: string, noteId: number): Promise<void> {
    await post(UI_ENDPOINTS.reviewChatNoteDelete, token, { noteId }, uiReviewWriteAckSchema);
}

export async function openInEditor(token: string, path: string, line?: number): Promise<UiOpenInEditorResponse> {
    return post(
        UI_ENDPOINTS.openInEditor,
        token,
        line === undefined ? { path } : { path, line },
        uiOpenInEditorResponseSchema,
    );
}

/** Sends feedback. On failure, forms keep their text and retry the same request. */
export async function sendFeedback(token: string, request: UiFeedbackRequest): Promise<UiFeedbackResponse> {
    return post(UI_ENDPOINTS.feedback, token, request, uiFeedbackResponseSchema);
}

/** Endpoint parameters. Empty values (`undefined`/`null`) stay out of the URL. */
function withQuery(path: string, params: Readonly<Record<string, string | null | undefined>>): string {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
            query.set(name, value);
        }
    }
    const search = query.toString();
    return search === '' ? path : `${path}?${search}`;
}

/**
 * Global UI settings live in `~/.sherpa/settings.json`, not `localStorage`, because
 * each PR server listens on its own port, so browser storage does not carry over to the next PR.
 */
export async function fetchUiSettings(token: string): Promise<UiSettings> {
    return (await get(UI_ENDPOINTS.settings, token, uiSettingsResponseSchema)).settings;
}

/** Changes the named fields. Returns the full set after the server merges them. */
export async function patchUiSettings(token: string, settings: UiSettingsPatch): Promise<UiSettings> {
    return (await patch(UI_ENDPOINTS.settings, token, settings, uiSettingsResponseSchema)).settings;
}

/**
 * UI state for this PR: collapsed directories and cards, recent palette commands. Stored in the
 * PR database on the server for the same reason as global settings, but separately for each PR.
 */
export async function fetchUiPrState(token: string): Promise<UiPrState> {
    return (await get(UI_ENDPOINTS.prState, token, uiPrStateResponseSchema)).prState;
}

/**
 * Replaces the named fields in full. Returns the entire state. `keepalive` supports writes from
 * `pagehide`, because the browser aborts normal requests when the page closes.
 */
export async function patchUiPrState(
    token: string,
    prState: UiPrStatePatch,
    options: { readonly keepalive?: boolean } = {},
): Promise<UiPrState> {
    return (await patch(UI_ENDPOINTS.prState, token, prState, uiPrStateResponseSchema, options)).prState;
}

async function get<T>(path: string, token: string, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
    } catch {
        throw new ApiError('The Sherpa server is not responding. Check that it is still running and retry.');
    }
    return validate(response, schema);
}

async function post<T>(path: string, token: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
        });
    } catch {
        throw new ApiError('The Sherpa server is not responding. Check that it is still running and retry.');
    }
    return validate(response, schema);
}

async function patch<T>(
    path: string,
    token: string,
    body: unknown,
    schema: z.ZodType<T>,
    options: { readonly keepalive?: boolean } = {},
): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
            ...(options.keepalive === true ? { keepalive: true } : {}),
        });
    } catch {
        throw new ApiError('The Sherpa server is not responding. Check that it is still running and retry.');
    }
    return validate(response, schema);
}

async function validate<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        throw new ApiError(errorMessage(payload), response.status);
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
        throw new ApiError('The server response failed contract validation. Update Sherpa.');
    }
    return parsed.data;
}

function errorMessage(payload: unknown): string {
    const parsed = rpcErrorSchema.safeParse(payload);
    if (!parsed.success) {
        return 'The server returned an error without a clear description. Check its output in the terminal.';
    }

    const { message, details } = parsed.data.error;
    return details === undefined || details.length === 0 ? message : `${message} ${details.join('; ')}`;
}
