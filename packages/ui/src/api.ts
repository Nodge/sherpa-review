import type {
    Comment,
    CommentDraft,
    FileContent,
    PrDiff,
    PriorityClass,
    PublishResult,
    Thread,
    UiCancelResponse,
    UiEnqueueResponse,
    UiFeedbackRequest,
    UiFeedbackResponse,
    UiOpenInEditorResponse,
    UiReviewLensesResponse,
    UiReviewProgressResponse,
    UiRouteGenerateResponse,
    UiReviewRouteResponse,
    UiSetFileViewedResponse,
    UiSetStopViewedResponse,
    UiStopSeenRange,
    UiTask,
    Verdict,
} from '@sherpa/protocol';
import {
    rpcErrorSchema,
    UI_ENDPOINTS,
    uiCancelResponseSchema,
    uiEnqueueResponseSchema,
    uiFeedbackResponseSchema,
    uiOpenInEditorResponseSchema,
    uiPublishResponseSchema,
    uiReviewDiffResponseSchema,
    uiReviewFileContentResponseSchema,
    uiReviewLensesResponseSchema,
    uiReviewProgressResponseSchema,
    uiReviewRouteResponseSchema,
    uiReviewThreadsResponseSchema,
    uiReviewWriteAckSchema,
    uiRouteGenerateResponseSchema,
    uiSaveDraftResponseSchema,
    uiSetFileViewedResponseSchema,
    uiSetStopViewedResponseSchema,
} from '@sherpa/protocol';
import type { z } from 'zod';

/**
 * UI actions (rpc-design §2): regular REST with a bearer token. Protocol schemas validate
 * responses. The UI consumes nothing that has not passed validation.
 */

/** An error the reviewer can see as is: the contract messages are already readable. */
export class ApiError extends Error {}

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

export async function fetchReviewDiff(token: string): Promise<PrDiff> {
    return (await get(UI_ENDPOINTS.reviewDiff, token, uiReviewDiffResponseSchema)).diff;
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

export async function updateReviewDraft(token: string, commentId: string, body: string): Promise<void> {
    await post(UI_ENDPOINTS.reviewUpdateDraft, token, { commentId, body }, uiReviewWriteAckSchema);
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
export async function fetchReviewProgress(token: string): Promise<UiReviewProgressResponse> {
    return get(UI_ENDPOINTS.reviewProgress, token, uiReviewProgressResponseSchema);
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
 * A stop's "viewed" mark (M2-T7) is sent with seen ranges calculated by
 * the UI. With `viewed: false`, the server removes this stop's stored ranges.
 */
export async function setStopViewed(
    token: string,
    stopId: string,
    viewed: boolean,
    ranges: readonly UiStopSeenRange[],
): Promise<UiSetStopViewedResponse> {
    return post(UI_ENDPOINTS.reviewStopViewed, token, { stopId, viewed, ranges }, uiSetStopViewedResponseSchema);
}

/**
 * Route state (M2): phase, snapshot and revision. The endpoint is local and works without a review host,
 * Refetched when `routeRevision` from SSE increases.
 */
export async function fetchReviewRoute(token: string): Promise<UiReviewRouteResponse> {
    return get(UI_ENDPOINTS.reviewRoute, token, uiReviewRouteResponseSchema);
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

async function validate<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        throw new ApiError(errorMessage(payload));
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
