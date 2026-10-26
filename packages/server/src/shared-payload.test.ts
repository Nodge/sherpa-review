import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { diffKeyOf, PR_DIFF_FILE, SharedPayloadStore } from './shared-payload.js';
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
        expect(first).toBe(path.join(sharedDir, 'diff', key, PR_DIFF_FILE));
        expect(fs.readFileSync(first, 'utf8')).toBe('first text');
    });

    it('writes overflow patches once under the diff key beside the shared file with private permissions', () => {
        const file = store.prDiff('base-head', 'diff', [{ name: '03-main.ts.md', content: 'patch' }]);
        const patch = path.join(store.prDiffPatchesDir('base-head'), '03-main.ts.md');
        store.prDiff('base-head', 'diff', [{ name: '03-main.ts.md', content: 'other patch' }]);

        expect(store.prDiffPatchesDir('base-head')).toBe(path.join(path.dirname(file), 'patches-v2'));
        expect(fs.readFileSync(patch, 'utf8')).toBe('patch');
        expect(fs.statSync(path.dirname(patch)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(patch).mode & 0o777).toBe(0o600);
        // Changing the key removes them along with the shared file. They belong to one build.
        store.prDiff('base-head2', 'new diff');
        expect(fs.existsSync(patch)).toBe(false);
    });

    it('requires an overflow patch name to be a filename, not a path', () => {
        expect(() => store.prDiff('base-head', 'diff', [{ name: '../escape.md', content: 'patch' }])).toThrow();
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

    it('joins an inter-iteration slice to the diff build without starting a separate build', () => {
        const diff = store.prDiff('base-head', 'iteration diff');
        const slice = store.interdiff('headA-headB', 'inter-iteration slice');

        expect(slice).toBe(path.join(sharedDir, 'diff', 'headA-headB', 'interdiff.md'));
        // Both directories are alive. Tasks for this build haven't been queued yet, so no task holds them.
        expect(fs.existsSync(diff)).toBe(true);
        expect(fs.existsSync(slice)).toBe(true);

        // A new iteration diff starts a new build and removes the previous directories.
        store.prDiff('base-head2', 'diff after push');
        expect(fs.existsSync(diff)).toBe(false);
        expect(fs.existsSync(slice)).toBe(false);
    });

    it('preserves a slice during cleanup while an open task references it', () => {
        store.prDiff('base-head', 'iteration diff');
        const slice = store.interdiff('headA-headB', 'inter-iteration slice');
        openContextFiles = [slice];

        store.prDiff('base-head2', 'diff after push');

        expect(fs.existsSync(slice)).toBe(true);
    });

    it('preserves keys referenced by tasks during startup cleanup', () => {
        const kept = store.prDiff('base-head', 'needed diff');
        // Create a second key without key-change cleanup, as a previous process might have left it.
        const stale = path.join(sharedDir, 'diff', 'old-key');
        fs.mkdirSync(stale, { recursive: true });
        fs.writeFileSync(path.join(stale, PR_DIFF_FILE), 'previous diff');
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

        expect(fs.readdirSync(path.join(sharedDir, 'diff', 'base-head'))).toEqual(['files', PR_DIFF_FILE]);
        expect(fs.readdirSync(path.join(sharedDir, 'diff', 'base-head', 'files'))).toHaveLength(1);
    });
});
