import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { ProgressStore } from './progress-store.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

/** Reading progress (T8): persisting explicit marks, revision and change subscription. */
describe('reading progress store', () => {
    let sherpaDir: string;
    let file: string;
    const opened: SherpaDatabase[] = [];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        file = path.join(sherpaDir, 'progress.db');
    });

    afterEach(async () => {
        for (const db of opened.splice(0)) {
            db.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    function open(): SherpaDatabase {
        const db = openDatabase(file);
        opened.push(db);
        return db;
    }

    it('starts with no records and revision zero', () => {
        const store = new ProgressStore({ db: open() });

        expect(store.read()).toEqual([]);
        expect(store.revision).toBe(0);
    });

    it('writes and clears a mark and preserves it across database reopen', () => {
        const store = new ProgressStore({ db: open() });

        store.setFileViewed('file-1', true);
        store.setFileViewed('file-2', false);

        expect(store.read()).toEqual([
            { fileId: 'file-1', viewed: true, seenRanges: [] },
            { fileId: 'file-2', viewed: false, seenRanges: [] },
        ]);

        // A new server process: the revision starts over, while records remain.
        const restarted = new ProgressStore({ db: open() });
        expect(restarted.read()).toEqual([
            { fileId: 'file-1', viewed: true, seenRanges: [] },
            { fileId: 'file-2', viewed: false, seenRanges: [] },
        ]);
        expect(restarted.revision).toBe(0);
    });

    it('overwrites the value when marking again instead of adding rows', () => {
        const store = new ProgressStore({ db: open() });

        store.setFileViewed('file-1', true);
        store.setFileViewed('file-1', false);

        expect(store.read()).toEqual([{ fileId: 'file-1', viewed: false, seenRanges: [] }]);
    });

    it('increments the revision on each change and leaves it unchanged on an idempotent write', () => {
        const store = new ProgressStore({ db: open() });

        expect(store.setFileViewed('file-1', true)).toBe(1);
        expect(store.setFileViewed('file-1', false)).toBe(2);
        // Nothing changed, so there is nothing to notify other tabs about.
        expect(store.setFileViewed('file-1', false)).toBe(2);
        expect(store.revision).toBe(2);
    });

    it('notifies a subscriber of the new revision and supports unsubscribe', () => {
        const store = new ProgressStore({ db: open() });
        const seen: number[] = [];
        const stop = store.subscribe((revision) => {
            seen.push(revision);
        });

        store.setFileViewed('file-1', true);
        store.setFileViewed('file-1', true);
        store.setFileViewed('file-2', true);
        stop();
        store.setFileViewed('file-3', true);

        expect(seen).toEqual([1, 2]);
    });

    it('reads seen ranges with marks and leaves a file with only ranges unpinned', () => {
        const db = open();
        // No range writes in M1. M2 stops will write them. Read tests use direct inserts.
        db.prepare('INSERT INTO file_seen_ranges (file_id, side, start_line, end_line) VALUES (?, ?, ?, ?)').run(
            'file-1',
            'new',
            10,
            20,
        );
        db.prepare('INSERT INTO file_seen_ranges (file_id, side, start_line, end_line) VALUES (?, ?, ?, ?)').run(
            'file-2',
            'old',
            1,
            3,
        );
        const store = new ProgressStore({ db });
        store.setFileViewed('file-1', true);

        expect(store.read()).toEqual([
            { fileId: 'file-1', viewed: true, seenRanges: [{ side: 'new', start: 10, end: 20 }] },
            { fileId: 'file-2', viewed: false, seenRanges: [{ side: 'old', start: 1, end: 3 }] },
        ]);
    });

    it('does not notify subscribers after close', () => {
        const store = new ProgressStore({ db: open() });
        let calls = 0;
        store.subscribe(() => {
            calls += 1;
        });

        store.close();
        store.setFileViewed('file-1', true);

        expect(calls).toBe(0);
    });
});
