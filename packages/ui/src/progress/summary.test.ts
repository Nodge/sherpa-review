import { fixtureIteration } from '@sherpa/fixtures';
import type { Comment, Thread } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { FileReadState } from './read-state.js';
import { commentBodies, countDraftComments, countPublishedReplies, reviewProgressSummary } from './summary.js';

function state(seen: number, total: number, read = false): FileReadState {
    return {
        state: read ? 'read' : seen === 0 ? 'unread' : 'partial',
        seen,
        total,
        pinned: read,
        generatedDefault: false,
    };
}

function comment(id: string, draft: boolean, replies: Comment[] = []): Comment {
    return {
        id,
        author: { login: 'alice', displayName: 'Alice Ingram', bot: false },
        body: `text ${id}`,
        draft,
        issue: null,
        createdAt: '2026-08-25T10:00:00.000Z',
        editedAt: null,
        replies,
    };
}

function threads(): Thread[] {
    return [
        {
            id: 'thread-1',
            anchor: null,
            resolved: false,
            resolvedBy: null,
            outdated: false,
        pinnedTo: null,
            root: comment('root', true, [comment('reply', true, [comment('deep', false)])]),
        },
    ];
}

describe('review progress aggregates', () => {
    it('counts viewed files and lines from effective read-state values', () => {
        const files = fixtureIteration('medium').diff.files;
        const first = files[0];
        const second = files[1];
        if (first === undefined || second === undefined) {
            throw new Error('small fixture needs two files');
        }
        const firstTotal = first.additions + first.deletions;
        const secondTotal = second.additions + second.deletions;
        const readState = new Map<string, FileReadState>([
            [first.fileId, state(firstTotal, firstTotal, true)],
            [second.fileId, state(Math.min(2, secondTotal), secondTotal)],
        ]);

        expect(reviewProgressSummary(files, readState)).toEqual({
            filesSeen: 1,
            filesTotal: files.length,
            linesSeen: firstTotal + Math.min(2, secondTotal),
            linesTotal: files.reduce((total, file) => total + file.additions + file.deletions, 0),
            percentSeen: Math.floor(
                ((firstTotal + Math.min(2, secondTotal)) /
                    files.reduce((total, file) => total + file.additions + file.deletions, 0)) *
                    100,
            ),
        });
    });

    it('considers an empty diff 100% viewed', () => {
        expect(reviewProgressSummary([], new Map())).toEqual({
            filesSeen: 0,
            filesTotal: 0,
            linesSeen: 0,
            linesTotal: 0,
            percentSeen: 100,
        });
    });
});

describe('comment publication selectors', () => {
    it('recursively counts drafts and published replies', () => {
        const source = threads();

        expect(countDraftComments(source)).toBe(2);
        expect(countPublishedReplies(source, ['root', 'reply', 'deep'])).toBe(2);
        expect(commentBodies(source)).toEqual(
            new Map([
                ['root', 'text root'],
                ['reply', 'text reply'],
                ['deep', 'text deep'],
            ]),
        );
    });
});
