import type { ChatExchange } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { CHAT_RECENT_LIMIT, searchChat } from './chat-search.js';

function exchange(id: number, question: string, answer: string | null, createdAt: string): ChatExchange {
    return {
        id,
        question,
        anchor: null,
        status: answer === null ? 'queued' : 'done',
        taskId: null,
        answer,
        progressText: null,
        error: null,
        locale: null,
        createdAt,
        updatedAt: createdAt,
    };
}

const HISTORY: readonly ChatExchange[] = Array.from({ length: 12 }, (_, index) =>
    exchange(
        index + 1,
        `Question ${String(index + 1)}`,
        `Answer ${String(index + 1)}`,
        `2026-08-20T09:${String(index + 10).padStart(2, '0')}:00.000Z`,
    ),
);

describe('searchChat', () => {
    it('returns recent exchanges for an empty query, newest first', () => {
        const found = searchChat(HISTORY, '', 50);

        expect(found.exchanges).toHaveLength(CHAT_RECENT_LIMIT);
        expect(found.exchanges.map((item) => item.id)).toEqual([12, 11, 10, 9, 8, 7, 6, 5]);
        // Limiting recent exchanges is not search truncation, so the limit notice does not apply.
        expect(found.truncated).toBe(false);
    });

    it('breaks timestamp ties by id, newest first', () => {
        const same = [
            exchange(1, 'First', null, '2026-08-20T09:00:00.000Z'),
            exchange(2, 'Second', null, '2026-08-20T09:00:00.000Z'),
        ];

        expect(searchChat(same, '', 50).exchanges.map((item) => item.id)).toEqual([2, 1]);
    });

    it('searches substrings in the question and answer, ignoring case', () => {
        const history = [
            exchange(1, 'Why is the window 30 minutes?', 'It closes at the deadline.', '2026-08-20T09:10:00.000Z'),
            exchange(2, 'What about the courier?', 'The deadline is checked before dispatch.', '2026-08-20T09:11:00.000Z'),
            exchange(3, 'Is there a risk of a leak?', null, '2026-08-20T09:12:00.000Z'),
        ];

        expect(searchChat(history, 'DEADLINE', 50).exchanges.map((item) => item.id)).toEqual([2, 1]);
        expect(searchChat(history, 'courier', 50).exchanges.map((item) => item.id)).toEqual([2]);
        expect(searchChat(history, 'leak', 50).exchanges.map((item) => item.id)).toEqual([3]);
        expect(searchChat(history, 'cache', 50).exchanges).toEqual([]);
    });

    it('does not use fuzzy matching: a subsequence of letters is not a match', () => {
        const history = [exchange(1, 'Why is the window 30 minutes?', 'It closes at the deadline.', '2026-08-20T09:10:00.000Z')];

        expect(searchChat(history, 'wyi', 50).exchanges).toEqual([]);
    });

    it('truncates search results at the limit and reports it', () => {
        const found = searchChat(HISTORY, 'question', 3);

        expect(found.exchanges.map((item) => item.id)).toEqual([12, 11, 10]);
        expect(found.truncated).toBe(true);
        expect(searchChat(HISTORY, 'question', 50).truncated).toBe(false);
    });
});
