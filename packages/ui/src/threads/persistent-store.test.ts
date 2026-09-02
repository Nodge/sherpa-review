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

    it('turns the open iteration into a previous one on push without losing the store or composer text', () => {
        const active = persistentThreadStore('fixture-persist-test', 'diff-2', [], new Set(['f1']));
        active.openComposer({
            key: 'new:f1:new:10',
            threadId: null,
            parentId: null,
            anchor: { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            text: 'written before the push',
            commentId: null,
            status: 'idle',
            saveUncertain: false,
            slow: false,
            confirmDiscard: false,
            resolvedAtOpen: false,
        });

        const layout = { diffId: 'diff-2', fileIdByPath: new Map([['app.ts', 'f1']]) };
        const past = persistentThreadStore('fixture-persist-test', 'diff-2', [], new Set(['f1']), layout);
        past.setIterationLayout(layout);

        expect(past).toBe(active);
        expect(past.getComposer('new:f1:new:10')?.text).toBe('written before the push');
        expect(past.getSnapshot().iterationLayout).toBe(layout);
    });
});
