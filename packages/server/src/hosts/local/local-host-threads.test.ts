import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitAvailable } from './git-fixture.js';
import { disposeGitProjectTemplate, draftOnA, fileIdOf, GitProject, PROJECT_PREFIX } from './git-project.js';
import type { LocalHost, LocalHostOptions } from './local-host.js';
import { fileThreadsStore, memoryThreadsStore } from './threads-store.js';

/**
 * Local host threads using real `git`: draft storage and anchor carryover between working-tree
 * iterations.
 */

const PREFIX = PROJECT_PREFIX;

/** Each host endpoint invokes `git` several times. The default five-second timeout is too short. */
const TIMEOUT_MS = 30_000;

afterAll(() => {
    disposeGitProjectTemplate();
});

describe.skipIf(!gitAvailable)('local host threads', { timeout: TIMEOUT_MS }, () => {
    let project: GitProject;

    beforeEach(() => {
        project = new GitProject('sherpa-local-threads-');
    });

    afterEach(() => {
        project.cleanup();
    });

    function makeHost(overrides: Partial<LocalHostOptions> = {}): LocalHost {
        return project.makeHost(overrides);
    }

    it('drafts survive host recreation with the same storage', async () => {
        project.seedOneFile();
        const threads = memoryThreadsStore();

        const first = makeHost({ threads });
        const diff = await first.getDiff();
        const file = diff.files[0];
        const created = await first.saveDraft({
            body: 'look here',
            parentId: null,
            anchor: { fileId: file?.fileId ?? '', path: 'src/a.ts', position: { side: 'new', line: 1, size: 1 } },
        });

        const revived = await makeHost({ threads }).getThreads();
        expect(revived).toHaveLength(1);
        expect(revived[0]?.root.id).toBe(created.id);
        expect(revived[0]?.root.body).toBe('look here');
        expect(revived[0]?.root.draft).toBe(true);
        expect(revived[0]?.pinnedTo?.diffId).toBe(diff.diffId);
    });

    it('an anchor moves to the new iteration by file path', async () => {
        project.seedOneFile();
        const host = makeHost();
        const before = await host.getDiff();
        await host.saveDraft({
            body: 'question',
            parentId: null,
            anchor: {
                fileId: before.files[0]?.fileId ?? '',
                path: 'src/a.ts',
                position: { side: 'new', line: 1, size: 1 },
            },
        });

        project.repo.write(`${PREFIX}/src/a.ts`, 'const a = 3;\n');
        await host.refresh();

        const after = await host.getDiff();
        const thread = (await host.getThreads())[0];
        expect(thread?.anchor?.fileId).toBe(after.files[0]?.fileId);
        expect(thread?.outdated).toBe(true);
        expect(thread?.pinnedTo?.diffId).toBe(before.diffId);
    });

    // Any tree change advances `diffId`, so thread staleness is checked against its file:
    // otherwise an unrelated edit would detach every thread from its lines.
    it('an edit in another file does not make the thread outdated: its pin moves to the active iteration', async () => {
        project.seedTwoFiles();
        const host = makeHost();
        const before = await host.getDiff();
        await host.saveDraft(draftOnA(before));

        project.repo.write(`${PREFIX}/src/b.ts`, 'const b = 3;\n');
        await host.refresh();

        const after = await host.getDiff();
        expect(after.diffId).not.toBe(before.diffId);
        const thread = (await host.getThreads())[0];
        expect(thread?.outdated).toBe(false);
        expect(thread?.pinnedTo?.diffId).toBe(after.diffId);
        expect(thread?.pinnedTo?.commit).toBe(after.headCommit);
        expect(thread?.anchor?.fileId).toBe(fileIdOf(after, 'src/a.ts'));
    });

    it('editing a thread file makes the thread outdated, pinned to the iteration where it was written', async () => {
        project.seedTwoFiles();
        const host = makeHost();
        const before = await host.getDiff();
        await host.saveDraft(draftOnA(before));

        project.repo.write(`${PREFIX}/src/a.ts`, 'const a = 3;\n');
        await host.refresh();

        const thread = (await host.getThreads())[0];
        expect(thread?.outdated).toBe(true);
        expect(thread?.pinnedTo?.diffId).toBe(before.diffId);
    });

    it('a thread becomes outdated when its file leaves the diff', async () => {
        project.seedTwoFiles();
        const host = makeHost();
        const before = await host.getDiff();
        await host.saveDraft(draftOnA(before));

        // Reverted the edit: the file is no longer in the diff at all.
        project.repo.write(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        await host.refresh();

        expect((await host.getDiff()).files.map((file) => file.path)).toEqual(['src/b.ts']);
        const thread = (await host.getThreads())[0];
        expect(thread?.outdated).toBe(true);
        expect(thread?.pinnedTo?.diffId).toBe(before.diffId);
    });

    it('repeating a write with the same idempotency key does not create another comment', async () => {
        project.seedOneFile();
        const host = makeHost();

        const first = await host.saveDraft(
            { body: 'once', parentId: null, anchor: null },
            { idempotencyKey: 'retry-1' },
        );
        const repeated = await host.saveDraft(
            { body: 'once', parentId: null, anchor: null },
            { idempotencyKey: 'retry-1' },
        );

        expect(repeated.id).toBe(first.id);
        expect(await host.getThreads()).toHaveLength(1);
    });

    it('both concurrent drafts reach the file', async () => {
        project.seedOneFile();
        const reviewPath = path.join(project.repo.root, 'state', 'local-review.json');
        const host = makeHost({ threads: fileThreadsStore(reviewPath) });

        const [first, second] = await Promise.all([
            host.saveDraft({ body: 'one', parentId: null, anchor: null }),
            host.saveDraft({ body: 'two', parentId: null, anchor: null }),
        ]);

        expect(first.id).not.toBe(second.id);
        const revived = await makeHost({ threads: fileThreadsStore(reviewPath) }).getThreads();
        expect(revived.map((thread) => thread.root.body).sort()).toEqual(['one', 'two']);
    });
});
