import { UI_ENDPOINTS } from '@sherpa/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deleteReviewChatNote } from './api.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
});

describe('note deletion through the UI API', () => {
    it('sends noteId to reviewChatNoteDelete and validates the ack', async () => {
        const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
            Promise.resolve(
                new Response(JSON.stringify({ acknowledged: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            ),
        );
        globalThis.fetch = fetch;

        await deleteReviewChatNote('token', 31);

        expect(fetch).toHaveBeenCalledWith(
            UI_ENDPOINTS.reviewChatNoteDelete,
            expect.objectContaining({
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
                body: JSON.stringify({ noteId: 31 }),
            }),
        );
    });
});
