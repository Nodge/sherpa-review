import type { ChatExchange } from '@sherpa/protocol';

/** Number of recent exchanges shown by an empty `@` (docs/design/SPEC-elements.md §2.18). */
export const CHAT_RECENT_LIMIT = 8;

export interface ChatSearchResult {
    readonly exchanges: readonly ChatExchange[];
    readonly truncated: boolean;
}

/**
 * Chat history for the palette query. Search uses substrings instead of fuzzy matching: in long answers,
 * a subsequence matches almost everything, making the results meaningless.
 */
export function searchChat(exchanges: readonly ChatExchange[], query: string, limit: number): ChatSearchResult {
    const needle = query.trim().toLowerCase();
    const sorted = [...exchanges].sort(
        (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id - left.id,
    );
    if (needle === '') {
        return { exchanges: sorted.slice(0, CHAT_RECENT_LIMIT), truncated: false };
    }
    const found = sorted.filter(
        (exchange) =>
            exchange.question.toLowerCase().includes(needle) ||
            exchange.answer?.toLowerCase().includes(needle) === true,
    );
    return { exchanges: found.slice(0, limit), truncated: found.length > limit };
}
