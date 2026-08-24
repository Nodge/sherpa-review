import { describe, expect, it } from 'vitest';

import { persistentThreadStore } from './persistent-store.js';

describe('persistent thread store', () => {
    it('returns the same store after a view remount and keeps composer text', () => {
        const first = persistentThreadStore('fixture-persist-test', 'diff-1', [], new Set(['f1']));
        first.openComposer({
            key: 'new:f1:new:10',
            threadId: null,
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            text: 'keep this',
            commentId: null,
            status: 'error',
            saveUncertain: true,
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });

        const remounted = persistentThreadStore('fixture-persist-test', 'diff-1', [], new Set(['f1']));

        expect(remounted).toBe(first);
        expect(remounted.getComposer('new:f1:new:10')).toMatchObject({
            text: 'keep this',
            status: 'error',
        });
    });
});
