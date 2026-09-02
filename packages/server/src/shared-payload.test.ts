import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { diffKeyOf, SharedPayloadStore } from './shared-payload.js';
import { mediumDiff } from './route/fixture-support.js';

describe('shared payload directory', () => {
    let sharedDir: string;
    let store: SharedPayloadStore;
    /** Context for tasks that are still being read. Cleanup must preserve their keys. */
    let openContextFiles: string[];

    beforeEach(async () => {
        sharedDir = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sherpa-shared-')), 'shared');
        openContextFiles = [];
        store = new SharedPayloadStore(sharedDir, () => openContextFiles);
    });

    afterEach(async () => {
        await fs.promises.rm(path.dirname(sharedDir), { recursive: true, force: true });
    });

    it('uses a commit pair as the diff key, keeps the path stable and writes the file once', () => {
        const diff = mediumDiff();
        const key = diffKeyOf(diff);

        expect(key).toBe(`${diff.baseCommit}-${diff.headCommit}`);
        const first = store.prDiff(key, 'first text');
        // Content written under a key is never overwritten. The path is shared across time too.
        const second = store.prDiff(key, 'other text');

        expect(second).toBe(first);
        expect(first).toBe(path.join(sharedDir, 'diff', key, 'pr-diff.md'));
        expect(fs.readFileSync(first, 'utf8')).toBe('first text');
    });

    it('addresses a guide by its content hash, so new text gets a new path', () => {
        const first = store.guide('chat-guide', 'old guide');
        const second = store.guide('chat-guide', 'new guide');

        expect(first).not.toBe(second);
        expect(path.basename(first)).toMatch(/^chat-guide-[0-9a-f]{8}\.md$/);
        expect(fs.readFileSync(first, 'utf8')).toBe('old guide');
        expect(fs.readFileSync(second, 'utf8')).toBe('new guide');
        expect(store.guide('chat-guide', 'old guide')).toBe(first);
    });

    it('addresses a file side by fileId and side and uses a safe path name', () => {
        const first = store.fileSide('k1', 'src/../weird path/main.ts', 'new', 'text');
        const second = store.fileSide('k1', 'src/../weird path/main.ts', 'new', 'other text');
        const other = store.fileSide('k1', 'src/../weird path/main.ts', 'old', 'old side');

        expect(second).toBe(first);
        expect(other).not.toBe(first);
        expect(path.dirname(first)).toBe(path.join(sharedDir, 'diff', 'k1', 'files'));
        expect(path.basename(first)).not.toContain('/');
        expect(path.basename(first)).toMatch(/\.new\.md$/);
        expect(fs.readFileSync(first, 'utf8')).toBe('text');
    });

    it('creates a new directory and removes the old one when the key changes', () => {
        const before = store.prDiff('base-head', 'old diff');
        const after = store.prDiff('base-head2', 'new diff');

        expect(fs.existsSync(before)).toBe(false);
        expect(fs.existsSync(after)).toBe(true);
        expect(fs.readdirSync(path.join(sharedDir, 'diff'))).toEqual(['base-head2']);
    });

    it('preserves a diff still being read by an open task when the key changes', () => {
        const held = store.prDiff('base-head', 'open task diff');
        openContextFiles = [held, '/tmp/somewhere/else.md'];

        const after = store.prDiff('base-head2', 'new diff');

        expect(fs.readFileSync(held, 'utf8')).toBe('open task diff');
        expect(fs.existsSync(after)).toBe(true);
        // The task closed. The next key change removes its directory.
        openContextFiles = [];
        store.prDiff('base-head3', 'another diff');

        expect(fs.existsSync(held)).toBe(false);
    });

    it('preserves keys referenced by tasks during startup cleanup', () => {
        const kept = store.prDiff('base-head', 'needed diff');
        // Create a second key without key-change cleanup, as a previous process might have left it.
        const stale = path.join(sharedDir, 'diff', 'old-key');
        fs.mkdirSync(stale, { recursive: true });
        fs.writeFileSync(path.join(stale, 'pr-diff.md'), 'previous diff');
        openContextFiles = [kept, '/tmp/somewhere/else.md'];

        store.sweepDiffKeys();

        expect(fs.existsSync(kept)).toBe(true);
        expect(fs.existsSync(stale)).toBe(false);
    });

    it('uses private permissions for directories and files: 0700 and 0600', () => {
        const file = store.prDiff('base-head', 'diff');

        expect(fs.statSync(sharedDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it('leaves no temporary files after writing', () => {
        store.prDiff('base-head', 'diff');
        store.fileSide('base-head', 'f-main', 'new', 'file');

        expect(fs.readdirSync(path.join(sharedDir, 'diff', 'base-head'))).toEqual(['files', 'pr-diff.md']);
        expect(fs.readdirSync(path.join(sharedDir, 'diff', 'base-head', 'files'))).toHaveLength(1);
    });
});
