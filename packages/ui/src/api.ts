import type {
    FileContent,
    PrDiff,
    PriorityClass,
    PrMeta,
    UiCancelResponse,
    UiEnqueueResponse,
    UiOpenInEditorResponse,
    UiReviewLensesResponse,
    UiTask,
} from '@sherpa/protocol';
import {
    rpcErrorSchema,
    UI_ENDPOINTS,
    uiCancelResponseSchema,
    uiEnqueueResponseSchema,
    uiOpenInEditorResponseSchema,
    uiReviewDiffResponseSchema,
    uiReviewFileContentResponseSchema,
    uiReviewLensesResponseSchema,
    uiReviewPrResponseSchema,
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

export async function fetchReviewPr(token: string): Promise<PrMeta> {
    return (await get(UI_ENDPOINTS.reviewPr, token, uiReviewPrResponseSchema)).pr;
}

export async function fetchReviewDiff(token: string): Promise<PrDiff> {
    return (await get(UI_ENDPOINTS.reviewDiff, token, uiReviewDiffResponseSchema)).diff;
}

/** File filter lenses: ownership is separate from extra lenses (README §Filters). */
export async function fetchReviewLenses(token: string): Promise<UiReviewLensesResponse> {
    return get(UI_ENDPOINTS.reviewLenses, token, uiReviewLensesResponseSchema);
}

/**
 * File contents for "Expand context". Called only with `capabilities.fileContent`.
 * `null` means this file has no available contents (binary or too large).
 */
export async function fetchFileContent(token: string, fileId: string): Promise<FileContent | null> {
    const path = `${UI_ENDPOINTS.reviewFileContent}?fileId=${encodeURIComponent(fileId)}`;
    return (await get(path, token, uiReviewFileContentResponseSchema)).content;
}

export async function openInEditor(token: string, path: string, line?: number): Promise<UiOpenInEditorResponse> {
    return post(
        UI_ENDPOINTS.openInEditor,
        token,
        line === undefined ? { path } : { path, line },
        uiOpenInEditorResponseSchema,
    );
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
