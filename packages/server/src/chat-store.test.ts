import path from 'node:path';

import { chatFixtures, fixtureData } from '@sherpa/fixtures';
import type { PrDiff } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChatStore, LEGACY_DIFF_ID } from './chat-store.js';
import type { SherpaDatabase } from './db.js';
import { openDatabase } from './db.js';
import type { IterationMap } from './iterations/index.js';
import { buildIterationMap, opaqueMap } from './iterations/index.js';
import { makeTempSherpaDir, removeTempSherpaDir, seedAgentNotes } from './test-support.js';

/**
 * Note anchor migration between iterations (M4-T11). The fixture defines the expected result:
 * `chatFixtures('medium').notesAfterPush` contains the same notes as seen in the second iteration.
 */

const DATA = fixtureData('medium');
const NOTES = chatFixtures('medium')?.notes ?? [];
const NOTES_AFTER_PUSH = chatFixtures('medium')?.notesAfterPush ?? [];

function iterationAt(index: number): { diffId: string; baseCommit: string; headCommit: string; diff: PrDiff } {
    const iteration = DATA.iterations[index];
    if (iteration === undefined) {
        throw new Error(`medium fixture has no iteration ${String(index + 1)}`);
    }
    return { ...iteration.iteration, diff: iteration.diff };
}

const V1 = iterationAt(0);
const V2 = iterationAt(1);
const V3 = iterationAt(2);

/** Line carryover map between fixture iterations, built from its prepared slice. */
function mapBetween(from: typeof V1, to: typeof V1): IterationMap {
    const interdiff = DATA.interdiffs.find((slice) => slice.base === from.diffId && slice.head === to.diffId);
    if (interdiff === undefined) {
        throw new Error(`medium fixture has no slice ${from.diffId}→${to.diffId}`);
    }
    return buildIterationMap({
        interdiff: interdiff.diff,
        fromBaseCommit: from.baseCommit,
        toBaseCommit: to.baseCommit,
    });
}

function fileIdsOf(iteration: typeof V1): (path: string) => string | null {
    const byPath = new Map(iteration.diff.files.map((file) => [file.path, file.fileId]));
    return (path) => byPath.get(path) ?? null;
}

describe('note anchor carryover', () => {
    let sherpaDir: string;
    let db: SherpaDatabase;
    let store: ChatStore;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        db = openDatabase(path.join(sherpaDir, 'chat.db'));
        store = new ChatStore({ db });
    });

    afterEach(async () => {
        store.close();
        db.close();
        await removeTempSherpaDir(sherpaDir);
    });

    function migrate(from: typeof V1, to: typeof V1): { moved: number; lost: number } {
        return store.migrateNotes(from.diffId, to.diffId, mapBetween(from, to), fileIdsOf(to), to.headCommit);
    }

    it('moves notes to the second iteration exactly as the fixture describes', () => {
        seedAgentNotes(db, NOTES);

        const result = migrate(V1, V2);

        expect(result).toEqual({ moved: 4, lost: 1 });
        expect(store.read().notes).toEqual(NOTES_AFTER_PUSH);
    });

    it('does not move the original location of a note during carryover', () => {
        seedAgentNotes(db, NOTES);

        migrate(V1, V2);

        expect(store.read().notes.map((note) => note.origin)).toEqual(NOTES.map((note) => note.origin));
    });

    it('finds nothing on a repeated call because the notes are already on the new iteration', () => {
        seedAgentNotes(db, NOTES);
        migrate(V1, V2);
        const revision = store.revision;

        expect(migrate(V1, V2)).toEqual({ moved: 0, lost: 0 });
        expect(store.revision).toBe(revision);
    });

    it('never migrates a note again after it loses its anchor', () => {
        seedAgentNotes(db, NOTES);
        migrate(V1, V2);
        const lost = store.read().notes.filter((note) => note.lostAnchor);

        const second = migrate(V2, V3);

        expect(lost).toHaveLength(1);
        expect(store.read().notes.filter((note) => note.lostAnchor)).toEqual(lost);
        expect(second.lost).toBe(0);
    });

    it('loses all anchors when no slice is available for carryover', () => {
        seedAgentNotes(db, NOTES);

        const result = store.migrateNotes(V1.diffId, V2.diffId, opaqueMap(), fileIdsOf(V2), V2.headCommit);

        expect(result).toEqual({ moved: 0, lost: NOTES.length });
        expect(store.read().notes.every((note) => note.lostAnchor)).toBe(true);
        // A note that lost its anchor keeps the last valid anchor on its original iteration.
        expect(store.read().notes.map((note) => note.anchor)).toEqual(NOTES.map((note) => note.anchor));
    });

    it('does no work when carrying over to the same iteration', () => {
        seedAgentNotes(db, NOTES);

        expect(store.migrateNotes(V1.diffId, V1.diffId, opaqueMap(), fileIdsOf(V1), V1.headCommit)).toEqual({
            moved: 0,
            lost: 0,
        });
    });

    it('bumps the revision once for the entire carryover batch', () => {
        seedAgentNotes(db, NOTES);
        const before = store.revision;

        migrate(V1, V2);

        expect(store.revision).toBe(before + 1);
    });
});

describe('M3 anchor adoption', () => {
    let sherpaDir: string;
    let db: SherpaDatabase;
    let store: ChatStore;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        db = openDatabase(path.join(sherpaDir, 'legacy.db'));
        store = new ChatStore({ db });
    });

    afterEach(async () => {
        store.close();
        db.close();
        await removeTempSherpaDir(sherpaDir);
    });

    /** An M3 anchor does not name an iteration at all. */
    function seedLegacy(): void {
        const note = NOTES[0];
        if (note === undefined) {
            throw new Error('medium fixture needs at least one note');
        }
        const legacy = JSON.stringify({ ...note.anchor, diffId: undefined });
        db.prepare(
            `INSERT INTO chat_exchanges (
                id, question, anchor, status, answer, progress_text, error, task_id, head_commit, created_at, updated_at
             ) VALUES (1, 'question', ?, 'done', 'answer', NULL, NULL, NULL, NULL, ?, ?)`,
        ).run(legacy, note.createdAt, note.createdAt);
        db.prepare(
            `INSERT INTO agent_notes (id, exchange_id, anchor, text, commit_hash, created_at)
             VALUES (1, 1, ?, 'answer', NULL, ?)`,
        ).run(legacy, note.createdAt);
    }

    it('adopts both current and original anchors without an iteration into the active one', () => {
        seedLegacy();
        expect(store.read().notes[0]?.anchor.diffId).toBe(LEGACY_DIFF_ID);

        expect(store.adoptLegacyAnchors(V2.diffId)).toBe(1);

        const note = store.read().notes[0];
        expect(note?.anchor.diffId).toBe(V2.diffId);
        expect(note?.origin.anchor.diffId).toBe(V2.diffId);
        // Adoption does not move lines. The anchor is the same, with an iteration added.
        expect(note?.anchor.start).toBe(NOTES[0]?.anchor.start);
    });

    it('has nothing left to adopt on a repeated call', () => {
        seedLegacy();
        store.adoptLegacyAnchors(V2.diffId);
        const revision = store.revision;

        expect(store.adoptLegacyAnchors(V2.diffId)).toBe(0);
        expect(store.revision).toBe(revision);
    });
});
