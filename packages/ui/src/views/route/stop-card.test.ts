import type { Thread } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { stopChangeThreads } from './stop-card.tsx';
import { createT } from '../../i18n/index.js';

const t = createT('en');

function thread(id: string, line: number | null): Thread {
    return {
        id,
        anchor:
            line === null
                ? null
                : {
                      fileId: 'f1',
                      path: 'services/orders/src/domain/order.ts',
                      position: { side: 'new', line, size: 1 },
                  },
        resolved: false,
        resolvedBy: null,
        outdated: false,
        pinnedTo: null,
        root: {
            id: `${id}-root`,
            author: { login: 'reviewer', displayName: 'Reviewer', bot: false },
            body: 'text',
            draft: false,
            issue: null,
            resolved: null,
            createdAt: '2026-09-01T10:00:00.000Z',
            editedAt: null,
            replies: [],
        },
    };
}

const THREADS = new Map<string, Thread>([
    ['t-line', thread('t-line', 33)],
    ['t-pr', thread('t-pr', null)],
]);

describe('links to threads that caused the change', () => {
    it('labels an anchored thread with its line and an unanchored one with PR', () => {
        expect(
            stopChangeThreads({ kind: 'changed', reason: null, threadIds: ['t-line', 't-pr'] }, THREADS, t),
        ).toEqual([
            { id: 't-line', label: 'thread at line 33' },
            { id: 't-pr', label: 'thread on the PR' },
        ]);
    });

    it('creates no link for an unknown id', () => {
        expect(
            stopChangeThreads({ kind: 'changed', reason: null, threadIds: ['t-line', 'no-such-thread'] }, THREADS, t),
        ).toEqual([{ id: 't-line', label: 'thread at line 33' }]);
    });

    it('has no links for an unclassified stop', () => {
        expect(stopChangeThreads(null, THREADS, t)).toEqual([]);
    });
});
