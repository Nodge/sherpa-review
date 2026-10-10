import { anchor, bot, comment, human, thread } from '@sherpa/fixtures';
import type { Thread } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { threadIsVisible } from '../threads/model.js';
import { bodyNeedsExpand, discussionSummary } from './overview-model.js';

/**
 * Discussion card model (docs/design/SPEC-additions-2026-08-26.md §1e): who gets a row, in what order,
 * what the header counts and what goes into the "outside the diff" fold.
 */

const DIFF_ID = 'd1';
const GONE = 'services/orders/src/gone.ts';
const ALIVE = 'services/orders/src/alive.ts';
const FILE_IDS = new Set([anchor(DIFF_ID, ALIVE).fileId]);

function at(path: string, line: number) {
    return anchor(DIFF_ID, path, { side: 'new', line });
}

function lineThread(login: string, name: string, line: number, createdAt: string, resolved = false): Thread {
    return thread({
        id: `${login}-${String(line)}`,
        anchor: at(ALIVE, line),
        resolved,
        root: comment({ id: `${login}-${String(line)}-root`, author: human(login, name), body: 'x', createdAt }),
    });
}

describe('discussion card model', () => {
    it('counts all PR threads in the header but only visible ones in rows and chips', () => {
        const threads: readonly Thread[] = [
            lineThread('ada', 'Ada Ortiz', 1, '2026-08-24T10:00:00.000Z'),
            lineThread('ada', 'Ada Ortiz', 2, '2026-08-24T09:00:00.000Z', true),
            thread({
                id: 'bot-1',
                anchor: at(ALIVE, 3),
                root: comment({ id: 'bot-1-root', author: bot('ai-review-bot', 'AI Review'), body: 'y', createdAt: '2026-08-24T08:00:00.000Z' }),
            }),
        ];

        const summary = discussionSummary(threads, FILE_IDS);

        // There is no source filter anymore: rows include all PR threads, including bots and resolved ones.
        expect({ total: summary.total, open: summary.open }).toEqual({ total: 3, open: 2 });
        expect(summary.participants.map((row) => [row.login, row.threads, row.open])).toEqual([
            ['ada', 2, 1],
            ['ai-review-bot', 1, 1],
        ]);
    });

    it('sorts by open threads, then recency on ties, with bots always after people', () => {
        const threads: readonly Thread[] = [
            lineThread('one-open', 'One Open', 1, '2026-08-24T12:00:00.000Z'),
            lineThread('two-open', 'Two Open', 2, '2026-08-24T07:00:00.000Z'),
            lineThread('two-open', 'Two Open', 3, '2026-08-24T06:00:00.000Z'),
            lineThread('older', 'Older One', 4, '2026-08-20T12:00:00.000Z'),
            thread({
                id: 'bot-many',
                anchor: at(ALIVE, 5),
                root: comment({ id: 'bot-many-root', author: bot('ai-review-bot', 'AI Review'), body: 'y', createdAt: '2026-08-24T13:00:00.000Z' }),
            }),
            thread({
                id: 'bot-many-2',
                anchor: at(ALIVE, 6),
                root: comment({ id: 'bot-many-2-root', author: bot('ai-review-bot', 'AI Review'), body: 'y', createdAt: '2026-08-24T13:30:00.000Z' }),
            }),
        ];

        const summary = discussionSummary(threads, FILE_IDS);

        expect(summary.participants.map((row) => row.login)).toEqual([
            'two-open',
            'one-open',
            'older',
            'ai-review-bot',
        ]);
        expect(summary.participants.map((row) => row.bot)).toEqual([false, false, false, true]);
    });

    it('uses replies as well as the root to find the latest participant activity', () => {
        const reply = comment({
            id: 'reply',
            author: human('other', 'Other'),
            body: 'r',
            createdAt: '2026-08-24T18:00:00.000Z',
        });
        const withReply = thread({
            id: 'root-with-reply',
            anchor: at(ALIVE, 1),
            root: comment({
                id: 'root-with-reply-root',
                author: human('ada', 'Ada Ortiz'),
                body: 'x',
                createdAt: '2026-08-24T10:00:00.000Z',
                replies: [reply],
            }),
        });

        const summary = discussionSummary([withReply], FILE_IDS);

        expect(summary.participants[0]?.lastActivity).toBe('2026-08-24T18:00:00.000Z');
    });

    it('builds participant rows from all thread authors to match the lens results', () => {
        const answered = thread({
            id: 'answered',
            anchor: at(ALIVE, 1),
            root: comment({
                id: 'answered-root',
                author: human('ada', 'Ada Ortiz'),
                body: 'x',
                createdAt: '2026-08-24T10:00:00.000Z',
                replies: [
                    comment({
                        id: 'answered-reply',
                        author: human('riley', 'Riley Irwin'),
                        body: 'r',
                        createdAt: '2026-08-24T10:30:00.000Z',
                    }),
                ],
            }),
        });
        const own = lineThread('ada', 'Ada Ortiz', 2, '2026-08-24T09:00:00.000Z');
        const threads = [answered, own];

        const summary = discussionSummary(threads, FILE_IDS);

        // riley has no threads of their own, but their lens shows results, so they also get a row.
        expect(summary.participants.map((row) => [row.login, row.threads, row.open])).toEqual([
            ['ada', 2, 2],
            ['riley', 1, 1],
        ]);
        for (const row of summary.participants) {
            const lens = threads.filter((item) => threadIsVisible(item, row.login));
            expect(lens).toHaveLength(row.threads);
        }
    });

    it('includes only human PR-level and removed-file threads outside the diff, with no bot threads', () => {
        const prLevel = thread({
            id: 'pr-human',
            anchor: null,
            root: comment({ id: 'pr-human-root', author: human('ada', 'Ada Ortiz'), body: 'x', createdAt: '2026-08-24T10:00:00.000Z' }),
        });
        const gone = thread({
            id: 'gone-human',
            anchor: at(GONE, 3),
            root: comment({ id: 'gone-human-root', author: human('morgan', 'Morgan Price'), body: 'x', createdAt: '2026-08-24T11:00:00.000Z' }),
        });
        const botPrLevel = thread({
            id: 'pr-bot',
            anchor: null,
            root: comment({ id: 'pr-bot-root', author: bot('ai-review-bot', 'AI Review'), body: 'y', createdAt: '2026-08-24T12:00:00.000Z' }),
        });
        const atCode = lineThread('kai', 'Kai Kennedy', 1, '2026-08-24T09:00:00.000Z');

        const summary = discussionSummary([prLevel, gone, botPrLevel, atCode], FILE_IDS);

        // The newest thread comes first. A PR-level bot only gets a row with a counter.
        expect(summary.outside.map((item) => item.id)).toEqual(['gone-human', 'pr-human']);
        expect(summary.participants.map((row) => row.login)).toContain('ai-review-bot');
    });

    it('gives a PR-level bot a counter row but never expands its body outside the diff', () => {
        const botThread = thread({
            id: 'pr-bot',
            anchor: null,
            root: comment({ id: 'pr-bot-root', author: bot('ai-review-bot', 'AI Review'), body: 'y', createdAt: '2026-08-24T12:00:00.000Z' }),
        });

        const summary = discussionSummary([botThread], FILE_IDS);

        expect(summary.participants.map((row) => row.login)).toEqual(['ai-review-bot']);
        expect(summary.outside).toEqual([]);
        expect(summary.total).toBe(1);
    });
});

describe('thread body truncation', () => {
    it('needs expand for a long body but not a short one', () => {
        expect(bodyNeedsExpand('one line')).toBe(false);
        expect(bodyNeedsExpand(['a', 'b', 'c', 'd'].join('\n'))).toBe(false);
        expect(bodyNeedsExpand(['a', 'b', 'c', 'd', 'e'].join('\n'))).toBe(true);
    });

    it('counts wrapped lines in a 360px column for a long line', () => {
        expect(bodyNeedsExpand('x'.repeat(200))).toBe(true);
        expect(bodyNeedsExpand('x'.repeat(200), 400)).toBe(false);
    });

    it('does not wrap code blocks and counts their source lines', () => {
        const fenced = ['```', 'y'.repeat(300), '```'].join('\n');

        expect(bodyNeedsExpand(fenced)).toBe(false);
    });
});
