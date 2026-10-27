import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GitFixture } from './git-fixture.js';
import { gitAvailable } from './git-fixture.js';
import { GIT_USER_NAME } from './git-fixture.js';
import { disposeGitProjectTemplate, GIT_PR_KEY, GitProject, PROJECT_PREFIX } from './git-project.js';
import { gitVcs } from './git-vcs.js';
import type { LocalHost, LocalHostOptions } from './local-host.js';
import { isBinaryContent, synthesizeAddPatch } from './patch.js';
import { MAX_FILE_BYTES } from './snapshot.js';
import type { CommandRunner } from './vcs.js';

/**
 * Local host over a working-tree snapshot: diff contents, iterations, branch and base, polling.
 * Backend uses real `git` (`git-project.ts`). Threads are in `local-host-threads.test.ts`, publishing rounds
 * in `local-host-rounds.test.ts`, and git-specific behaviour in `local-git-host.test.ts`.
 */

const PREFIX = PROJECT_PREFIX;

/** Each host endpoint invokes `git` several times. The default five-second timeout is too short. */
const TIMEOUT_MS = 30_000;

/** A polling tick invokes `git` several times, so it takes seconds to wait for it. */
const WAIT_MS = 15_000;

/** `git` subcommand in backend arguments, preceded by `-c <config>` pairs. */
function gitSubcommand(args: readonly string[]): string {
    let index = 0;
    while (args[index] === '-c') {
        index += 2;
    }
    return args[index] ?? '';
}

/** Waits for a condition: polling has its own timer, so a fixed delay would be a guess. */
async function waitUntil(condition: () => boolean, what: string, timeoutMs = WAIT_MS): Promise<void> {
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

afterAll(() => {
    disposeGitProjectTemplate();
});

describe.skipIf(!gitAvailable)('local host on a working tree', { timeout: TIMEOUT_MS }, () => {
    let project: GitProject;
    let repo: GitFixture;
    let projectDir: string;

    beforeEach(() => {
        project = new GitProject('sherpa-local-unit-');
        repo = project.repo;
        projectDir = project.dir;
    });

    afterEach(() => {
        project.cleanup();
    });

    function makeHost(overrides: Partial<LocalHostOptions> = {}): LocalHost {
        return project.makeHost(overrides);
    }

    it('the diff includes an edit and an untracked file, but excludes another directory', async () => {
        repo.commitBase({ [`${PREFIX}/src/a.ts`]: 'const a = 1;\n', 'other/b.ts': 'const b = 1;\n' });
        repo.write(`${PREFIX}/src/a.ts`, 'const a = 2;\n');
        repo.write(`${PREFIX}/scratch/notes.md`, '# notes\n');
        repo.write('other/b.ts', 'const b = 2;\n');

        const diff = await makeHost().getDiff();

        expect(diff.files.map((file) => file.path).sort()).toEqual(['scratch/notes.md', 'src/a.ts']);
        const untracked = diff.files.find((file) => file.path === 'scratch/notes.md');
        expect(untracked?.changeType).toBe('add');
        expect(untracked?.additions).toBe(1);
        expect(untracked?.patch).toContain('+# notes');
        expect(diff.files.every((file) => file.fileId.startsWith(`${diff.diffId}:`))).toBe(true);
    });

    it('all diff files belong to the reviewer ownership zone', async () => {
        project.seedOneFile();
        repo.write(`${PREFIX}/scratch/notes.md`, '# notes\n');
        const host = makeHost();

        const lens = await host.ownershipLens();

        expect(host.ownershipSource).toBe('git diff');
        expect(lens).toMatchObject({ id: 'mine', available: true, zones: null });
        expect([...lens.paths].sort()).toEqual(['scratch/notes.md', 'src/a.ts']);
    });

    it('a removed file is sent as delete, with null new-side content', async () => {
        repo.commitBase({ [`${PREFIX}/src/gone.ts`]: 'export const gone = 1;\n' });
        repo.remove(`${PREFIX}/src/gone.ts`);
        const host = makeHost();

        const diff = await host.getDiff();
        const file = diff.files.find((candidate) => candidate.path === 'src/gone.ts');
        expect(file?.changeType).toBe('delete');

        const content = await host.getFileContent(file?.fileId ?? '');
        expect(content?.oldText).toBe('export const gone = 1;\n');
        expect(content?.newText).toBeNull();
    });

    it('an unchanged diff keeps the iteration, a changed diff creates a new one', async () => {
        project.seedOneFile();
        const host = makeHost();
        const first = await host.getDiff();

        await host.refresh();
        expect((await host.getDiff()).diffId).toBe(first.diffId);

        repo.write(`${PREFIX}/src/a.ts`, 'const a = 3;\n');
        await host.refresh();
        expect((await host.getDiff()).diffId).not.toBe(first.diffId);
    });

    it('review metadata describes the directory and branch, with no verdicts before publishing', async () => {
        project.seedOneFile();

        const pr = await makeHost().getPr();

        expect(pr).toMatchObject({
            id: GIT_PR_KEY,
            url: `file://${projectDir}`,
            title: 'feature',
            fromBranch: 'feature',
            toBranch: 'main',
            statusLabel: 'local',
            verdicts: [],
        });
        expect(pr.author.login).toBe(GIT_USER_NAME);
        // The local tree is read by its owner.
        expect(pr.viewer).toEqual({ login: GIT_USER_NAME, displayName: null, bot: false, avatarUrl: null });
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

    it('switching the checkout branch makes all host endpoints fail', async () => {
        project.seedOneFile();
        const host = makeHost();
        await host.getDiff();

        repo.git('checkout', '-b', 'another');
        await expect(host.refresh()).rejects.toThrow(
            `checkout switched to branch another; run \`sherpa up --local ${projectDir}\` again`,
        );
        await expect(host.getDiff()).rejects.toThrow('checkout switched to branch another');

        // Back on the review branch: the next poll clears the failure.
        repo.git('checkout', 'feature');
        await host.refresh();
        expect((await host.getDiff()).files).toHaveLength(1);
    });

    it('the first snapshot fixes the key branch when it is not yet known', async () => {
        project.seedOneFile();
        const resolved: string[] = [];
        const host = makeHost({ branch: null, onBranchResolved: (branch) => resolved.push(branch) });

        await host.getDiff();
        expect(resolved).toEqual(['feature']);

        repo.git('checkout', '-b', 'another');
        await expect(host.refresh()).rejects.toThrow('checkout switched to branch another');
    });

    it('image bytes are returned by blobId, with distinct sides', async () => {
        const before = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
        const after = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02, 0x03]);
        repo.commitBase({ [`${PREFIX}/logo.png`]: before });
        repo.write(`${PREFIX}/logo.png`, after);
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

    // Polling must be cheap: the project directory diff is the most expensive part of a snapshot.
    it('a polling tick without edits does not read the diff', async () => {
        project.seedOneFile();
        const calls: string[] = [];
        const live = project.runner();
        const counting: CommandRunner = (args) => {
            calls.push(gitSubcommand(args));
            return live(args);
        };
        const countOf = (command: string): number => calls.filter((call) => call === command).length;
        const host = makeHost({ vcs: gitVcs(counting), pollIntervalMs: 5 });

        const stop = host.watchIterations(() => undefined);
        await host.getDiff();
        const diffCalls = countOf('diff');
        const statusCalls = countOf('status');

        await waitUntil(() => countOf('status') >= statusCalls + 3, 'three polling ticks');
        stop();

        expect(countOf('diff')).toBe(diffCalls);
    });

    // Expanding untracked directories ourselves would miss ignore rules: node_modules and build output
    // would enter the diff, and garbage would use up the file count limit.
    it('the VCS supplies the untracked file list: ignored files stay out of the diff', async () => {
        repo.write(`${PREFIX}/app/index.ts`, 'export const app = 1;\n');
        repo.write(`${PREFIX}/app/node_modules/dep/index.js`, 'module.exports = 1;\n');
        repo.commitBase({ '.gitignore': 'node_modules/\n' });

        const diff = await makeHost().getDiff();

        expect(diff.files.map((file) => file.path)).toEqual(['app/index.ts']);
    });

    it('too many untracked files causes an error with an explanation instead of silent truncation', async () => {
        for (let index = 0; index < 1001; index += 1) {
            repo.write(`${PREFIX}/scratch/file-${String(index)}.txt`, `${String(index)}\n`);
        }

        await expect(makeHost().getDiff()).rejects.toThrow('1001 untracked files');
    });

    it('an untracked file over the size limit enters the diff without content', async () => {
        repo.write(`${PREFIX}/dump.csv`, Buffer.alloc(MAX_FILE_BYTES + 1, 0x41));
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
        project.seedOneFile();
        const host = makeHost();
        const stale = (await host.getDiff()).files[0]?.fileId ?? '';

        repo.write(`${PREFIX}/src/a.ts`, 'const a = 333;\n');
        await expect(host.getFileContent(stale)).rejects.toThrow('older diff');

        const fresh = (await host.getDiff()).files[0]?.fileId ?? '';
        expect((await host.getFileContent(fresh))?.newText).toBe('const a = 333;\n');
    });

    // An explicit base is a ref, and refs move: compare against its current target.
    it('an explicit base resolves to a commit on every poll', async () => {
        project.seedOneFile();
        const first = repo.git('rev-parse', 'HEAD').trim();
        const second = repo.git('rev-parse', 'HEAD~1').trim();
        repo.git('branch', 'pinned', first);
        const host = makeHost({ base: 'pinned', pollIntervalMs: 5 });

        const stop = host.watchIterations(() => undefined);
        expect((await host.getDiff()).baseCommit).toBe(first);

        repo.git('branch', '-f', 'pinned', second);
        // Polling promises eventual convergence, not an instant response. Wait for a snapshot on the new base.
        await expect.poll(async () => (await host.getDiff()).baseCommit, { timeout: WAIT_MS }).toBe(second);
        stop();
    });

    // A forced rebuild is requested for an edit the current pass has not yet seen.
    it('a forced rebuild does not share a pass already in progress', async () => {
        project.seedOneFile();
        let release: () => void = () => undefined;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        let reachedDiff = false;
        const live = project.runner();
        const gated: CommandRunner = async (args) => {
            if (gitSubcommand(args) === 'diff' && !reachedDiff) {
                reachedDiff = true;
                await blocked;
            }
            return live(args);
        };
        const host = makeHost({ vcs: gitVcs(gated) });

        const first = host.getDiff();
        await waitUntil(() => reachedDiff, 'the first pass reached the diff');
        repo.write(`${PREFIX}/src/b.ts`, 'const b = 1;\n');
        const forced = host.refresh();
        release();
        await first;
        await forced;

        expect((await host.getDiff()).files.map((file) => file.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    });
});
