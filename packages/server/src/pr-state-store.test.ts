import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import { PrStateStore } from './pr-state-store.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

/** UI state for one PR: KV by schema field, a patch replaces the whole field. */
describe('UI state store for this PR', () => {
    let sherpaDir: string;
    let file: string;
    const opened: SherpaDatabase[] = [];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        file = path.join(sherpaDir, 'pr-state.db');
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

    it('returns schema defaults for an empty database', () => {
        const store = new PrStateStore({ db: open() });

        expect(store.read()).toEqual({ treeCollapsed: {}, diffCollapsed: {}, paletteRecent: [] });
    });

    it('patches one field without changing its neighbours', () => {
        const store = new PrStateStore({ db: open() });
        store.patch({ treeCollapsed: { 'src/api': true } });

        const result = store.patch({ paletteRecent: ['diff.toggleMode'] });

        expect(result).toEqual({
            treeCollapsed: { 'src/api': true },
            diffCollapsed: {},
            paletteRecent: ['diff.toggleMode'],
        });
        expect(store.read()).toEqual(result);
    });

    it('replaces the named field entirely so a deleted key disappears', () => {
        const store = new PrStateStore({ db: open() });
        store.patch({ treeCollapsed: { 'src/api': true, 'src/ui': false } });

        // The reviewer reset `src/ui` to its default: the key is gone from the map, which differs
        // from `false` because the default depends on directory size.
        store.patch({ treeCollapsed: { 'src/api': true } });

        expect(store.read().treeCollapsed).toEqual({ 'src/api': true });
    });

    it('keeps neighbouring fields intact when one value is corrupt', () => {
        const db = open();
        const store = new PrStateStore({ db });
        store.patch({ treeCollapsed: { 'src/api': true }, paletteRecent: ['diff.toggleMode'] });
        db.prepare('UPDATE ui_pr_state SET value_json = ? WHERE key = ?').run('{oops', 'treeCollapsed');
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

        expect(store.read()).toEqual({ treeCollapsed: {}, diffCollapsed: {}, paletteRecent: ['diff.toggleMode'] });
        expect(stderr).toHaveBeenCalled();
        stderr.mockRestore();
    });

    it('uses the default only for the field whose value fails the schema', () => {
        const db = open();
        const store = new PrStateStore({ db });
        store.patch({ diffCollapsed: { f1: true } });
        db.prepare('UPDATE ui_pr_state SET value_json = ? WHERE key = ?').run('["f1"]', 'diffCollapsed');
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

        expect(store.read().diffCollapsed).toEqual({});
        expect(stderr).toHaveBeenCalled();
        stderr.mockRestore();
    });

    it('preserves state across database reopen', () => {
        const first = new PrStateStore({ db: open() });
        first.patch({ diffCollapsed: { f1: true }, paletteRecent: ['a', 'b'] });
        opened.splice(0).forEach((db) => {
            db.close();
        });

        const second = new PrStateStore({ db: open() });

        expect(second.read()).toEqual({
            treeCollapsed: {},
            diffCollapsed: { f1: true },
            paletteRecent: ['a', 'b'],
        });
    });

    it('changes nothing for an empty patch', () => {
        const store = new PrStateStore({ db: open() });
        store.patch({ paletteRecent: ['a'] });

        expect(store.patch({})).toEqual({ treeCollapsed: {}, diffCollapsed: {}, paletteRecent: ['a'] });
    });

    it('takes the write time from the injected clock', () => {
        const db = open();
        const store = new PrStateStore({ db, now: () => new Date('2026-09-02T10:00:00.000Z') });
        store.patch({ paletteRecent: ['a'] });

        const row = db.prepare('SELECT updated_at FROM ui_pr_state WHERE key = ?').get('paletteRecent') as {
            updated_at: string;
        };

        expect(row.updated_at).toBe('2026-09-02T10:00:00.000Z');
    });
});
