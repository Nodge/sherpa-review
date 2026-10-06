import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CommentDraft, PrDiff, Thread } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';



import { memoryIterationsStore } from './iterations-store.js';
import { LocalHost } from './local-host.js';
import { isBinaryContent, synthesizeAddPatch } from './patch.js';
import { MAX_FILE_BYTES } from './snapshot.js';
import type { LocalThreadsStore } from './threads-store.js';
import { emptyReviewData, fileThreadsStore, memoryThreadsStore } from './threads-store.js';
import type { CommandRunner } from './vcs.js';

const PREFIX = 'app';

/** Waits for a condition: polling has its own timer, so a fixed delay would be a guess. */
async function waitUntil(condition: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for: ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

describe('untracked file patch', () => {
    it('text is sent as one hunk adding the entire file', () => {
        const patch = synthesizeAddPatch('src/new.ts', Buffer.from('const a = 1;\nconst b = 2;\n'));

        expect(patch).toBe(
            [
                'diff --git a/src/new.ts b/src/new.ts',
                'new file mode 100644',
                '--- /dev/null',
                '+++ b/src/new.ts',
                '@@ -0,0 +1,2 @@',
                '+const a = 1;',
                '+const b = 2;',
                '',
            ].join('\n'),
        );
    });

    it('a file without a trailing newline is marked as in git', () => {
        const patch = synthesizeAddPatch('a.txt', Buffer.from('one\ntwo'));

        expect(patch).toContain('@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n');
    });

    it('an empty file has a header without a hunk', () => {
        expect(synthesizeAddPatch('empty.txt', Buffer.alloc(0))).toBe(
            'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n--- /dev/null\n+++ b/empty.txt\n',
        );
    });

    it('binary content gets no patch', () => {
        expect(isBinaryContent(Buffer.from([0x01, 0x00, 0x02]))).toBe(true);
        expect(synthesizeAddPatch('logo.png', Buffer.from([0x89, 0x50, 0x00, 0x01]))).toBeNull();
    });

    // Scan for a zero byte only at the start of the file: no need to read an entire gigabyte dump.
    it('a zero byte beyond the sample does not make the file binary', () => {
        const content = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0x00])]);

        expect(isBinaryContent(content)).toBe(false);
    });
});

describe('parsing VCS output', () => {
    it('status: a clean tree prints an empty object', () => {
        expect(parseVcsStatus('{"status":{}}')).toEqual({ changed: [], untracked: [] });
    });

    it('status: changed and untracked file paths are relative to the checkout root', () => {
        const status = parseVcsStatus(
            JSON.stringify({
                status: {
                    changed: [{ status: 'modified', type: 'file', path: 'tools/app/README.md' }],
                    untracked: [
                        { status: 'untracked', type: 'file', path: 'tools/app/new/note.md' },
                        { status: 'untracked', type: 'directory', path: 'tools/app/other' },
                    ],
                },
            }),
        );

        expect(status.changed).toEqual([{ status: 'modified', path: 'tools/app/README.md' }]);
        // A directory would mean the VCS did not inspect it. The diff needs files.
        expect(status.untracked).toEqual(['tools/app/new/note.md']);
    });

    it('status: unreadable output is an error, not a clean tree', () => {
        expect(() => parseGitStatus('not json')).toThrow('git status');
    });

    // The status letter is padded with spaces to the column, rather than separated by a tab.
    it('name-status: separates the status letter with spaces', () => {
        expect(parseNameStatus('M       README.md\nA       src/new.ts\nD       src/old.ts\n')).toEqual([
            { changeType: 'modify', path: 'README.md', oldPath: null },
            { changeType: 'add', path: 'src/new.ts', oldPath: null },
            { changeType: 'delete', path: 'src/old.ts', oldPath: null },
        ]);
    });

    it('name-status: includes the old path for a rename but not a copy', () => {
        expect(parseNameStatus('R100\tsrc/old.ts\tsrc/new.ts\nC75\tsrc/a.ts\tsrc/b.ts\n')).toEqual([
            { changeType: 'move', path: 'src/new.ts', oldPath: 'src/old.ts' },
            { changeType: 'copy', path: 'src/b.ts', oldPath: null },
        ]);
    });

    it('name-status: does not treat a space inside a path as a separator', () => {
        expect(parseNameStatus('M       docs/my notes.md\n')).toEqual([
            { changeType: 'modify', path: 'docs/my notes.md', oldPath: null },
        ]);
    });
});

const ON_SHIP = 'on ship, commit and open a PR';

describe('local host on the working tree', () => {
    let root: string;
    let fake: FakeVcs;

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-local-unit-')));
        fake = new FakeVcs({ root, prefix: PREFIX });
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function makeHost(
        overrides: { branch?: string | null; threads?: LocalThreadsStore; verdicts?: string | null } = {},
    ): LocalHost {
        return new LocalHost({
            prKey: 'local-git-app-0badc0de',
            vcs: scriptedVcs(fake.runner),
            projectDir: fake.projectDir,
            base: null,
            branch: overrides.branch === undefined ? fake.branch : overrides.branch,
            ...(overrides.verdicts === undefined ? {} : { verdicts: overrides.verdicts }),
            threads: overrides.threads ?? memoryThreadsStore(),
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
        });
    }

    it('the diff includes an edit and an untracked file, but excludes another directory', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        fake.writeDisk(`${PREFIX}/scratch/notes.md`, '# notes\n');
        fake.commit('other/b.ts', 'const b = 1;\n');
        fake.writeDisk('other/b.ts', 'const b = 2;\n');

        const diff = await makeHost().getDiff();

        expect(diff.files.map((file) => file.path).sort()).toEqual(['scratch/notes.md', 'src/a.ts']);
        const untracked = diff.files.find((file) => file.path === 'scratch/notes.md');
        expect(untracked?.changeType).toBe('add');
        expect(untracked?.additions).toBe(1);
        expect(untracked?.patch).toContain('+# notes');
        expect(diff.files.every((file) => file.fileId.startsWith(`${diff.diffId}:`))).toBe(true);
    });

    it('all diff files belong to the reviewer ownership zone', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        fake.writeDisk(`${PREFIX}/scratch/notes.md`, '# notes\n');
        const host = makeHost();

        const lens = await host.ownershipLens();

        expect(host.ownershipSource).toBe('git diff');
        expect(lens).toMatchObject({ id: 'mine', available: true, zones: null });
        expect([...lens.paths].sort()).toEqual(['scratch/notes.md', 'src/a.ts']);
    });

    it('a removed file is sent as delete, with null new-side content', async () => {
        fake.commit(`${PREFIX}/src/gone.ts`, 'export const gone = 1;\n');
        fake.removeDisk(`${PREFIX}/src/gone.ts`);
        const host = makeHost();

        const diff = await host.getDiff();
        const file = diff.files.find((candidate) => candidate.path === 'src/gone.ts');
        expect(file?.changeType).toBe('delete');

        const content = await host.getFileContent(file?.fileId ?? '');
        expect(content?.oldText).toBe('export const gone = 1;\n');
        expect(content?.newText).toBeNull();
    });

    it('an unchanged diff keeps the iteration, a changed diff creates a new one', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const host = makeHost();
        const first = await host.getDiff();

        await host.refresh();
        expect((await host.getDiff()).diffId).toBe(first.diffId);

        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 3;\n');
        await host.refresh();
        expect((await host.getDiff()).diffId).not.toBe(first.diffId);
    });

    it('review metadata describes the directory and branch, with no verdicts before publishing', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');

        const pr = await makeHost().getPr();

        expect(pr).toMatchObject({
            id: 'local-git-app-0badc0de',
            url: `file://${fake.projectDir}`,
            title: fake.branch,
            fromBranch: fake.branch,
            toBranch: 'main',
            statusLabel: 'local',
            verdicts: [],
        });
        expect(pr.author.login).toBe(fake.login);
        // The local tree is read by its owner.
        expect(pr.viewer).toEqual({ login: fake.login, displayName: null, bot: false });
        expect(pr.capabilities).toEqual({
            publishVerdicts: ['comment'],
            fileViewedSync: false,
            fileContent: true,
            commentIssues: false,
            commentResolve: false,
            editPublished: true,
            iterations: true,
            blobs: true,
        });
    });

    it('a verdict from an old file belongs to its iteration: a new diff clears it', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const { diffId } = await makeHost().getDiff();
        // Without `--verdicts`, ship cannot be published, but previously written files must remain readable.
        const host = makeHost({
            threads: memoryThreadsStore({ ...emptyReviewData(), verdict: { verdict: 'ship', diffId } }),
        });

        expect((await host.getPr()).verdicts).toEqual([
            { user: { login: fake.login, displayName: null, bot: false }, verdict: 'ship' },
        ]);

        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 3;\n');
        await host.refresh();
        expect((await host.getPr()).verdicts).toEqual([]);
    });

    it('only comments can be published: rejects the verdict and keeps the draft', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        const draft = await host.saveDraft({ body: 'about B', parentId: null, anchor: null });

        for (const verdict of ['ship', 'sticky_ship', 'request_changes'] as const) {
            await expect(host.publishBatch(verdict)).rejects.toThrow(/comments only/);
        }
        expect((await host.getThreads()).find((thread) => thread.id === draft.id)?.root.draft).toBe(true);
        expect(await host.pendingRounds()).toEqual([]);

        await host.publishBatch('comment');
        // Publishing without a verdict does not count as a reviewer verdict.
        expect((await host.getPr()).verdicts).toEqual([]);
    });

    it('with --verdicts the modes match a PR: Request changes and Ship, without Comment', async () => {
        seedTwoFiles(fake);

        expect((await makeHost({ verdicts: ON_SHIP }).getPr()).capabilities.publishVerdicts).toEqual([
            'request_changes',
            'ship',
        ]);
        expect((await makeHost({ verdicts: null }).getPr()).capabilities.publishVerdicts).toEqual(['comment']);
    });

    it('with --verdicts, comment and sticky_ship are rejected and the draft remains', async () => {
        seedTwoFiles(fake);
        const host = makeHost({ verdicts: ON_SHIP });
        const draft = await host.saveDraft({ body: 'about B', parentId: null, anchor: null });

        for (const verdict of ['comment', 'sticky_ship'] as const) {
            await expect(host.publishBatch(verdict)).rejects.toThrow(/through Request changes/);
        }
        expect((await host.getThreads()).find((thread) => thread.id === draft.id)?.root.draft).toBe(true);
        expect(await host.pendingRounds()).toEqual([]);
    });

    it('a verdict creates a round even without comments: the session must receive it', async () => {
        seedTwoFiles(fake);
        const host = makeHost({ verdicts: ON_SHIP });

        expect(await host.publishBatch('ship')).toEqual({ publishedCommentIds: [], failed: [], verdictApplied: true });
        expect(await host.publishBatch('request_changes')).toEqual({
            publishedCommentIds: [],
            failed: [],
            verdictApplied: true,
        });

        const rounds = await host.pendingRounds();
        expect(rounds.map((round) => [round.verdict, round.threadIds])).toEqual([
            ['ship', []],
            ['request_changes', []],
        ]);
        // The latest iteration verdict appears in the header.
        expect((await host.getPr()).verdicts).toEqual([
            { user: { login: fake.login, displayName: null, bot: false }, verdict: 'request_changes' },
        ]);
    });

    it('ship publishes drafts and includes their threads in the round', async () => {
        seedTwoFiles(fake);
        const host = makeHost({ verdicts: ON_SHIP });
        const draft = await host.saveDraft({ body: 'about B', parentId: null, anchor: null });

        const result = await host.publishBatch('ship');

        expect(result.publishedCommentIds).toEqual([draft.id]);
        expect(await host.pendingRounds()).toMatchObject([{ verdict: 'ship', threadIds: [draft.id] }]);
        expect((await host.roundContext((await host.pendingRounds())[0]?.id ?? '')).verdict).toBe('ship');
    });

    it('round context includes the current host instruction', async () => {
        seedTwoFiles(fake);
        const host = makeHost({ verdicts: ON_SHIP });
        await host.publishBatch('ship');
        const roundId = (await host.pendingRounds())[0]?.id ?? '';

        expect((await host.roundContext(roundId)).instruction).toBe(ON_SHIP);

        host.setVerdicts('on ship, merge into main');
        expect((await host.roundContext(roundId)).instruction).toBe('on ship, merge into main');

        host.setVerdicts(null);
        expect((await host.roundContext(roundId)).instruction).toBeNull();
    });

    it('the mode switches on a running host and reports the change', async () => {
        seedTwoFiles(fake);
        const changes: (string | null)[] = [];
        const host = new LocalHost({
            prKey: 'local-git-app-0badc0de',
            vcs: scriptedVcs(fake.runner),
            projectDir: fake.projectDir,
            base: null,
            branch: fake.branch,
            threads: memoryThreadsStore(),
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
            onVerdictsChanged: (verdicts) => changes.push(verdicts),
        });

        expect(host.setVerdicts(null)).toBe(false);
        expect(host.setVerdicts(ON_SHIP)).toBe(true);
        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['request_changes', 'ship']);
        await expect(host.publishBatch('comment')).rejects.toThrow();

        // A new instruction with the mode already enabled is saved, but does not require rereading metadata.
        expect(host.setVerdicts('on ship, merge into main')).toBe(false);
        expect(host.setVerdicts('on ship, merge into main')).toBe(false);

        expect(host.setVerdicts(null)).toBe(true);
        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['comment']);
        expect(changes).toEqual([ON_SHIP, 'on ship, merge into main', null]);
    });

    // A failed write leaves the mode in memory unchanged. Otherwise another `up` would consider it enabled.
    it('a repeated call retries saving a mode after the previous save failed', async () => {
        seedTwoFiles(fake);
        const stored: (string | null)[] = [];
        let calls = 0;
        const host = new LocalHost({
            prKey: 'local-git-app-0badc0de',
            vcs: scriptedVcs(fake.runner),
            projectDir: fake.projectDir,
            base: null,
            branch: fake.branch,
            threads: memoryThreadsStore(),
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
            onVerdictsChanged: (verdicts) => {
                calls += 1;
                if (calls === 1) {
                    throw new Error('disk full');
                }
                stored.push(verdicts);
            },
        });

        expect(() => host.setVerdicts(ON_SHIP)).toThrow('disk full');
        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['comment']);

        expect(host.setVerdicts(ON_SHIP)).toBe(true);
        expect(calls).toBe(2);
        expect(stored).toEqual([ON_SHIP]);
        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['request_changes', 'ship']);
    });

    it('switching the checkout branch makes all host endpoints fail', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const host = makeHost();
        await host.getDiff();

        fake.branch = 'another';
        await expect(host.refresh()).rejects.toThrow(
            `checkout switched to branch another; run \`sherpa up --local ${fake.projectDir}\` again`,
        );
        await expect(host.getDiff()).rejects.toThrow('checkout switched to branch another');

        // Back on the review branch: the next poll clears the failure.
        fake.branch = 'feature';
        await host.refresh();
        expect((await host.getDiff()).files).toHaveLength(1);
    });

    it('the first snapshot fixes the key branch when it is not yet known', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const resolved: string[] = [];
        const host = new LocalHost({
            prKey: 'local-git-app-0badc0de',
            vcs: scriptedVcs(fake.runner),
            projectDir: fake.projectDir,
            base: null,
            branch: null,
            threads: memoryThreadsStore(),
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
            onBranchResolved: (branch) => resolved.push(branch),
        });

        await host.getDiff();
        expect(resolved).toEqual(['feature']);

        fake.branch = 'another';
        await expect(host.refresh()).rejects.toThrow('checkout switched to branch another');
    });

    it('drafts survive host recreation with the same storage', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
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
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
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

        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 3;\n');
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
        seedTwoFiles(fake);
        const host = makeHost();
        const before = await host.getDiff();
        await host.saveDraft(draftOnA(before));

        fake.writeDisk(`${PREFIX}/src/b.ts`, 'const b = 3;\n');
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
        seedTwoFiles(fake);
        const host = makeHost();
        const before = await host.getDiff();
        await host.saveDraft(draftOnA(before));

        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 3;\n');
        await host.refresh();

        const thread = (await host.getThreads())[0];
        expect(thread?.outdated).toBe(true);
        expect(thread?.pinnedTo?.diffId).toBe(before.diffId);
    });

    it('a thread becomes outdated when its file leaves the diff', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        const before = await host.getDiff();
        await host.saveDraft(draftOnA(before));

        // Reverted the edit: the file is no longer in the diff at all.
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        await host.refresh();

        expect((await host.getDiff()).files.map((file) => file.path)).toEqual(['src/b.ts']);
        const thread = (await host.getThreads())[0];
        expect(thread?.outdated).toBe(true);
        expect(thread?.pinnedTo?.diffId).toBe(before.diffId);
    });

    it('repeating a write with the same idempotency key does not create another comment', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
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

    it('image bytes are returned by blobId, with distinct sides', async () => {
        const before = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
        const after = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02, 0x03]);
        fake.commit(`${PREFIX}/logo.png`, before);
        fake.writeDisk(`${PREFIX}/logo.png`, after);
        const host = makeHost();

        const file = (await host.getDiff()).files[0];
        expect(file?.binary).toBe(true);
        expect(file?.patch).toBeNull();
        expect(file?.image?.mime).toBe('image/png');
        expect(file?.image?.before?.size).toBe(before.length);
        expect(file?.image?.after?.size).toBe(after.length);

        const bytes = await host.getBlob(file?.image?.after?.blobId ?? '');
        expect(Buffer.from(bytes ?? new Uint8Array())).toEqual(after);
        expect(await host.getBlob('no-such-blob')).toBeNull();
    });

    // Polling must be cheap. `git diff` on the project directory is the most expensive part of a snapshot.
    it('a polling tick without edits does not read the diff', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const host = new LocalHost({
            prKey: 'local-git-app-0badc0de',
            vcs: scriptedVcs(fake.runner),
            projectDir: fake.projectDir,
            base: null,
            branch: fake.branch,
            threads: memoryThreadsStore(),
            iterations: memoryIterationsStore(),
            pollIntervalMs: 5,
        });

        const stop = host.watchIterations(() => undefined);
        await host.getDiff();
        const diffCalls = fake.countOf('diff');
        const statusCalls = fake.countOf('status');

        await waitUntil(() => fake.countOf('status') >= statusCalls + 3, 'three polling ticks');
        stop();

        expect(fake.countOf('diff')).toBe(diffCalls);
    });

    // Expanding untracked directories ourselves would ignore `.gitignore`. Dependencies
    // would enter the diff, and garbage would use up the file count limit.
    it('asks git for untracked files so ignored files stay out of the diff', async () => {
        fake.writeDisk(`${PREFIX}/app/index.ts`, 'export const app = 1;\n');
        fake.writeDisk(`${PREFIX}/app/node_modules/dep/index.js`, 'module.exports = 1;\n');
        fake.ignored.push(`${PREFIX}/app/node_modules/`);

        const diff = await makeHost().getDiff();

        expect(diff.files.map((file) => file.path)).toEqual(['app/index.ts']);
    });

    it('too many untracked files causes an error with an explanation instead of silent truncation', async () => {
        fs.mkdirSync(path.join(root, PREFIX), { recursive: true });
        const host = new LocalHost({
            prKey: 'local-git-app-0badc0de',
            vcs: scriptedVcs(floodedVcs(root, 1001)),
            projectDir: path.join(root, PREFIX),
            base: null,
            branch: 'feature',
            threads: memoryThreadsStore(),
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
        });

        await expect(host.getDiff()).rejects.toThrow('1001 untracked files');
    });

    it('an untracked file over the size limit enters the diff without content', async () => {
        fake.writeDisk(`${PREFIX}/dump.csv`, Buffer.alloc(MAX_FILE_BYTES + 1, 0x41));
        const host = makeHost();

        const file = (await host.getDiff()).files[0];
        expect(file?.path).toBe('dump.csv');
        expect(file?.binary).toBe(true);
        expect(file?.patch).toBeNull();
        expect(file?.additions).toBe(0);
        expect(await host.getFileContent(file?.fileId ?? '')).toBeNull();
    });

    // Content is read from disk now, so it must match the patch from the same iteration.
    it('getFileContent updates the snapshot and rejects an outdated fileId', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const host = makeHost();
        const stale = (await host.getDiff()).files[0]?.fileId ?? '';

        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 333;\n');
        await expect(host.getFileContent(stale)).rejects.toThrow('older diff');

        const fresh = (await host.getDiff()).files[0]?.fileId ?? '';
        expect((await host.getFileContent(fresh))?.newText).toBe('const a = 333;\n');
    });

    it('both concurrent drafts reach the file', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        const reviewPath = path.join(root, 'state', 'local-review.json');
        const host = makeHost({ threads: fileThreadsStore(reviewPath) });

        const [first, second] = await Promise.all([
            host.saveDraft({ body: 'one', parentId: null, anchor: null }),
            host.saveDraft({ body: 'two', parentId: null, anchor: null }),
        ]);

        expect(first.id).not.toBe(second.id);
        const revived = await makeHost({ threads: fileThreadsStore(reviewPath) }).getThreads();
        expect(revived.map((thread) => thread.root.body).sort()).toEqual(['one', 'two']);
    });

    // An explicit base is a ref, and refs move: compare against its current target.
    it('an explicit base resolves to a commit on every poll', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        fake.refs.set('main', 'a'.repeat(40));
        const host = new LocalHost({
            prKey: 'local-git-app-0badc0de',
            vcs: scriptedVcs(fake.runner),
            projectDir: fake.projectDir,
            base: 'main',
            branch: fake.branch,
            threads: memoryThreadsStore(),
            iterations: memoryIterationsStore(),
            pollIntervalMs: 5,
        });

        const stop = host.watchIterations(() => undefined);
        expect((await host.getDiff()).baseCommit).toBe('a'.repeat(40));

        fake.refs.set('main', 'b'.repeat(40));
        // Polling promises eventual convergence, not an instant response. Wait for a snapshot on the new base.
        await expect.poll(async () => (await host.getDiff()).baseCommit).toBe('b'.repeat(40));
        stop();
    });

    it('publishing opens a round with threads from own comments', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        const diff = await host.getDiff();
        const onA = await host.saveDraft(draftOnA(diff));
        // The second thread was published earlier, so it stays out of the new round.
        await host.saveDraft({ body: 'about B', parentId: null, anchor: null });
        await host.publishBatch('comment');

        const reply = await host.saveDraft({ body: 'what about here?', parentId: onA.id, anchor: null });
        await host.publishBatch('comment');

        const rounds = await host.pendingRounds();
        expect(rounds).toHaveLength(2);
        expect(rounds[0]?.verdict).toBe('comment');
        expect(rounds[0]?.threadIds.length).toBe(2);
        expect(rounds[1]).toMatchObject({ verdict: 'comment', threadIds: [onA.id] });
        expect(reply.draft).toBe(true);
    });

    it('publishing without any comments opens no round and writes nothing', async () => {
        seedTwoFiles(fake);
        const threads = memoryThreadsStore();
        const host = makeHost({ threads });

        expect(await host.publishBatch('comment')).toEqual({ publishedCommentIds: [], failed: [], verdictApplied: true });
        expect(await host.pendingRounds()).toEqual([]);
        expect(await threads.read()).toEqual(emptyReviewData());
    });

    it('round context includes the absolute path, line and patch excerpt', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        const diff = await host.getDiff();
        const comment = await host.saveDraft(draftOnA(diff));
        await host.publishBatch('comment');
        const round = (await host.pendingRounds())[0];

        const context = await host.roundContext(round?.id ?? '');

        expect(context.verdict).toBe('comment');
        expect(context.projectDir).toBe(fake.projectDir);
        const thread = context.threads[0];
        expect(thread?.threadId).toBe(comment.id);
        expect(thread?.file).toBe(path.join(fake.projectDir, 'src/a.ts'));
        expect(thread?.position).toEqual({ side: 'new', line: 1, size: 1 });
        expect(thread?.excerpt).toContain('+const a = 2;');
        expect(thread?.note).toBeNull();
        expect(thread?.comments[0]?.body).toBe('question about A');
    });

    it('an outdated thread enters the round with a marker instead of an excerpt', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        await host.saveDraft(draftOnA(await host.getDiff()));
        await host.publishBatch('comment');
        const round = (await host.pendingRounds())[0];

        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 42;\n');
        await host.refresh();

        const thread = (await host.roundContext(round?.id ?? '')).threads[0];
        expect(thread?.excerpt).toBeNull();
        expect(thread?.note).toContain('outdated');
    });

    // Round context is read when the task is queued, not when publishing: unpublished
    // thread text never leaves the host.
    it('a draft written after publication stays out of round context', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        const comment = await host.saveDraft(draftOnA(await host.getDiff()));
        await host.publishBatch('comment');
        await host.saveDraft({ body: 'not sent yet', parentId: comment.id, anchor: null });
        const round = (await host.pendingRounds())[0];

        const thread = (await host.roundContext(round?.id ?? '')).threads[0];

        expect(thread?.comments).toHaveLength(1);
        expect(thread?.comments[0]?.replies).toEqual([]);
    });

    it('an agent reply becomes a bot comment and the round closes', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        const comment = await host.saveDraft(draftOnA(await host.getDiff()));
        await host.publishBatch('comment');
        const round = (await host.pendingRounds())[0];
        const seen: Thread[][] = [];
        const stop = host.watchThreads((threads) => seen.push(threads));

        await host.completeRound(
            round?.id ?? '',
            { replies: [{ threadId: comment.id, body: 'extracted a constant' }], summary: 'fixed one thing' },
            { login: 'claude-code', displayName: 'Agent · claude-opus-5', bot: true },
        );
        stop();

        const thread = (await host.getThreads()).find((candidate) => candidate.id === comment.id);
        expect(thread?.root.replies).toHaveLength(1);
        expect(thread?.root.replies[0]).toMatchObject({
            body: 'extracted a constant',
            draft: false,
            author: { login: 'claude-code', displayName: 'Agent · claude-opus-5', bot: true },
        });
        expect(await host.pendingRounds()).toEqual([]);
        // The round summary is a PR-level discussion by the same author.
        const summary = (await host.getThreads()).find((candidate) => candidate.anchor === null);
        expect(summary?.root).toMatchObject({
            body: 'fixed one thing',
            draft: false,
            author: { login: 'claude-code', bot: true },
        });
        expect(summary?.pinnedTo).toBeNull();
        // Thread subscribers saw the reply without waiting for a polling tick.
        expect(seen.at(-1)?.find((candidate) => candidate.id === comment.id)?.root.replies).toHaveLength(1);
    });

    it('a published comment by the reviewer can be edited and physically deleted', async () => {
        seedTwoFiles(fake);
        const threads = memoryThreadsStore();
        const host = makeHost({ threads });
        const comment = await host.saveDraft(draftOnA(await host.getDiff()));
        await host.publishBatch('comment');

        await host.updateComment(comment.id, 'question about A, rewritten');
        const edited = (await host.getThreads()).find((candidate) => candidate.id === comment.id);
        expect(edited?.root.body).toBe('question about A, rewritten');
        expect(edited?.root.editedAt).not.toBeNull();

        await host.deleteComment(comment.id);
        expect((await host.getThreads()).some((candidate) => candidate.id === comment.id)).toBe(false);
        // Deletion is physical: the comment no longer exists in storage.
        expect((await threads.read()).threads).toEqual([]);
    });

    it('comments by others and drafts cannot be edited or deleted', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        const comment = await host.saveDraft(draftOnA(await host.getDiff()));

        await expect(host.updateComment(comment.id, 'draft edit')).rejects.toThrow('is a draft');

        await host.publishBatch('comment');
        const round = (await host.pendingRounds())[0];
        await host.completeRound(
            round?.id ?? '',
            { replies: [{ threadId: comment.id, body: 'fixed' }], summary: 'summary' },
            { login: 'claude-code', displayName: 'Agent', bot: true },
        );
        const reply = (await host.getThreads()).find((candidate) => candidate.id === comment.id)?.root.replies[0];

        await expect(host.deleteComment(reply?.id ?? '')).rejects.toThrow('belongs to claude-code');
    });

    it('rejects a reply to a thread outside the round', async () => {
        seedTwoFiles(fake);
        const host = makeHost();
        await host.saveDraft(draftOnA(await host.getDiff()));
        await host.publishBatch('comment');
        const round = (await host.pendingRounds())[0];

        await expect(
            host.completeRound(
                round?.id ?? '',
                { replies: [{ threadId: 'not-ours', body: 'reply' }], summary: 'summary' },
                { login: 'agent', displayName: 'Agent', bot: true },
            ),
        ).rejects.toThrow('is not in review round');
    });

    // A forced rebuild is requested for an edit the current pass has not yet seen.
    it('a forced rebuild does not share a pass already in progress', async () => {
        fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
        fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        let release: () => void = () => undefined;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        let reachedDiff = false;
        const gated: CommandRunner = async (args) => {
            if (args[0] === 'diff' && !reachedDiff) {
                reachedDiff = true;
                await blocked;
            }
            return fake.runner(args);
        };
        const host = new LocalHost({
            prKey: 'local-git-app-0badc0de',
            vcs: scriptedVcs(gated),
            projectDir: fake.projectDir,
            base: null,
            branch: fake.branch,
            threads: memoryThreadsStore(),
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
        });

        const first = host.getDiff();
        await waitUntil(() => reachedDiff, 'the first pass reached the diff');
        fake.writeDisk(`${PREFIX}/src/b.ts`, 'const b = 1;\n');
        const forced = host.refresh();
        release();
        await first;
        await forced;

        expect((await host.getDiff()).files.map((file) => file.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    });


});


/** Two changed files: one holds a thread, the other is edited to advance the iteration. */
function seedTwoFiles(fake: FakeVcs): void {
    fake.commit(`${PREFIX}/src/a.ts`, 'const a = 1;\n');
    fake.commit(`${PREFIX}/src/b.ts`, 'const b = 1;\n');
    fake.writeDisk(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
    fake.writeDisk(`${PREFIX}/src/b.ts`, 'const b = 2;\n');
}

function fileIdOf(diff: PrDiff, filePath: string): string {
    return diff.files.find((file) => file.path === filePath)?.fileId ?? '';
}

function draftOnA(diff: PrDiff): CommentDraft {
    return {
        body: 'question about A',
        parentId: null,
        anchor: {
            fileId: fileIdOf(diff, 'src/a.ts'),
            path: 'src/a.ts',
            position: { side: 'new', line: 1, size: 1 },
        },
    };
}

/**
 * A fake VCS with a directory full of untracked files. They need no disk space because
 * only the reaction to exceeding the limit is checked.
 */
function floodedVcs(root: string, count: number): CommandRunner {
    const untracked = Array.from({ length: count }, (_, index) => ({
        status: 'untracked',
        type: 'file',
        path: `${PREFIX}/scratch/file-${String(index)}.txt`,
    }));

    return (args) => {
        const answers: Record<string, string> = {
            root: `${root}\n`,
            info: JSON.stringify({ branch: 'feature', hash: '1'.repeat(40), user_login: 'reviewer' }),
            'merge-base': `${'0'.repeat(40)}\n`,
            status: JSON.stringify({ status: { untracked } }),
        };
        return Promise.resolve({ code: 0, stdout: Buffer.from(answers[args[0] ?? ''] ?? ''), stderr: '' });
    };
}
