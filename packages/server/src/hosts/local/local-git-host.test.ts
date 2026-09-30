import path from 'node:path';

import type { FileDiff } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GitFixture } from './git-fixture.js';
import { gitAvailable, makeGitRepo } from './git-fixture.js';
import { gitVcs } from './git-vcs.js';
import { memoryIterationsStore } from './iterations-store.js';
import { LocalHost } from './local-host.js';
import { memoryThreadsStore } from './threads-store.js';
import { commandRunnerIn } from './vcs.js';

/**
 * Local host on real `git`: the working-tree snapshot is read through the git
 * backend. Checks diff contents, review metadata and reading file sides.
 */

const PR_KEY = 'local-git-app-0badc0de';

/** Each host endpoint invokes `git` several times. The default five-second timeout is too short. */
const TIMEOUT_MS = 30_000;

describe.skipIf(!gitAvailable)('local host on a git repository', { timeout: TIMEOUT_MS }, () => {
    let repo: GitFixture;

    beforeEach(() => {
        repo = makeGitRepo('sherpa-git-host-');
    });

    afterEach(() => {
        repo.cleanup();
    });

    function makeHost(options: { projectDir?: string; base?: string | null } = {}): LocalHost {
        const projectDir = options.projectDir ?? repo.root;
        return new LocalHost({
            prKey: PR_KEY,
            vcs: gitVcs(commandRunnerIn('git', projectDir)),
            projectDir,
            base: options.base ?? null,
            branch: 'feature',
            threads: memoryThreadsStore(),
            iterations: memoryIterationsStore(),
            pollIntervalMs: 600_000,
        });
    }

    /** Base commit on `main` with a `feature` branch on top. */
    function seedBranch(): string {
        repo.write('src/a.ts', 'const a = 1;\n');
        repo.write('src/legacy.ts', 'export const legacy = true;\n');
        repo.write('.gitignore', 'dist/\n');
        const base = repo.commitAll('base');
        repo.git('checkout', '-b', 'feature');
        return base;
    }

    function fileOf(files: readonly FileDiff[], filePath: string): FileDiff {
        const file = files.find((candidate) => candidate.path === filePath);
        if (file === undefined) {
            throw new Error(`no file ${filePath} in the diff`);
        }
        return file;
    }

    it('the diff includes the commit after the base, staged, unstaged and untracked changes', async () => {
        seedBranch();
        repo.write('src/a.ts', 'const a = 2;\n');
        repo.commitAll('work');
        repo.write('src/a.ts', 'const a = 3;\n');
        repo.write('src/fresh.ts', 'export const fresh = 1;\n');
        repo.git('add', 'src/fresh.ts');
        repo.remove('src/legacy.ts');
        repo.write('notes.md', '# notes\n');
        repo.write('dist/bundle.js', 'console.log(1);\n');

        const diff = await makeHost().getDiff();

        // Ignored files (`dist/`) stay out of the diff: git handles the rules.
        expect(diff.files.map((file) => file.path).sort()).toEqual([
            'notes.md',
            'src/a.ts',
            'src/fresh.ts',
            'src/legacy.ts',
        ]);
        expect(fileOf(diff.files, 'src/a.ts').patch).toContain('+const a = 3;');
        expect(fileOf(diff.files, 'src/fresh.ts').changeType).toBe('add');
        expect(fileOf(diff.files, 'src/legacy.ts').changeType).toBe('delete');
        // An untracked file appears as a patch synthesized by the adapter.
        expect(fileOf(diff.files, 'notes.md')).toMatchObject({ changeType: 'add', additions: 1 });
    });

    it('review metadata names the git base branch', async () => {
        seedBranch();
        repo.write('src/a.ts', 'const a = 2;\n');

        const pr = await makeHost().getPr();

        expect(pr).toMatchObject({
            id: PR_KEY,
            url: `file://${repo.root}`,
            fromBranch: 'feature',
            toBranch: 'main',
            statusLabel: 'local',
        });
        expect(pr.author.login).toBe('Sherpa Tester');
    });

    it('the reviewer owns the whole diff, with `git diff` as the ownership source', async () => {
        seedBranch();
        repo.write('src/a.ts', 'const a = 2;\n');
        repo.write('notes.md', '# notes\n');
        const host = makeHost();

        const lens = await host.ownershipLens();

        expect(host.ownershipSource).toBe('git diff');
        expect([...lens.paths].sort()).toEqual(['notes.md', 'src/a.ts']);
    });

    it('an explicit base compares against the specified commit', async () => {
        const base = seedBranch();
        repo.write('src/a.ts', 'const a = 2;\n');
        const middle = repo.commitAll('middle');
        repo.write('src/a.ts', 'const a = 3;\n');

        const fromBase = await makeHost({ base }).getDiff();
        expect(fromBase.baseCommit).toBe(base);
        expect(fileOf(fromBase.files, 'src/a.ts').patch).toContain('-const a = 1;');

        const hostFromMiddle = makeHost({ base: middle });
        const fromMiddle = await hostFromMiddle.getDiff();
        expect(fromMiddle.baseCommit).toBe(middle);
        expect(fileOf(fromMiddle.files, 'src/a.ts').patch).toContain('-const a = 2;');
        // Metadata shows an explicit base as supplied, abbreviating a full sha.
        expect((await hostFromMiddle.getPr()).toBranch).toBe(middle.slice(0, 12));
    });

    it('the project directory is a repository subdirectory: unrelated changes stay out of the diff', async () => {
        repo.write('app/src/a.ts', 'const a = 1;\n');
        repo.write('other/b.ts', 'const b = 1;\n');
        repo.commitAll('base');
        repo.git('checkout', '-b', 'feature');
        repo.write('app/src/a.ts', 'const a = 2;\n');
        repo.write('other/b.ts', 'const b = 2;\n');
        repo.write('app/notes.md', 'local\n');

        const diff = await makeHost({ projectDir: path.join(repo.root, 'app') }).getDiff();

        expect(diff.files.map((file) => file.path).sort()).toEqual(['notes.md', 'src/a.ts']);
    });

    it('a binary file has no patch, an image has blobs for its sides', async () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
        repo.write('assets/logo.png', png);
        repo.write('assets/data.bin', Buffer.from([0x01, 0x00, 0x02]));
        repo.commitAll('base');
        repo.git('checkout', '-b', 'feature');
        repo.write('assets/logo.png', Buffer.concat([png, Buffer.from([0x02])]));
        repo.write('assets/data.bin', Buffer.from([0x01, 0x00, 0x03]));
        const host = makeHost();

        const diff = await host.getDiff();
        const binary = fileOf(diff.files, 'assets/data.bin');
        expect(binary).toMatchObject({ binary: true, patch: null });

        const image = fileOf(diff.files, 'assets/logo.png').image;
        expect(image?.mime).toBe('image/png');
        const before = image?.before?.blobId ?? '';
        expect(Buffer.from((await host.getBlob(before)) ?? new Uint8Array())).toEqual(png);
    });

    it('file content on both sides is read from the repository', async () => {
        seedBranch();
        repo.write('src/a.ts', 'const a = 2;\n');
        const host = makeHost();

        const file = fileOf((await host.getDiff()).files, 'src/a.ts');
        expect(await host.getFileContent(file.fileId)).toEqual({
            oldText: 'const a = 1;\n',
            newText: 'const a = 2;\n',
        });
    });

    it('an edit creates the next iteration and keeps the previous one in the list', async () => {
        seedBranch();
        repo.write('src/a.ts', 'const a = 2;\n');
        const host = makeHost();
        const first = (await host.getDiff()).diffId;

        repo.write('src/a.ts', 'const a = 3;\n');
        await host.refresh();

        const iterations = await host.listIterations();
        expect(iterations.map((iteration) => iteration.status)).toEqual(['previous', 'active']);
        expect(iterations[0]?.diffId).toBe(first);
    });

    it('a path with spaces and non-ASCII characters reaches the diff unchanged', async () => {
        repo.write('docs/café notes.md', '# café\n');
        seedBranch();
        repo.write('docs/café notes.md', '# café\n\ndeuxième ligne\n');
        repo.write('docs/crème notes.md', '# crème\n');

        const diff = await makeHost().getDiff();

        // Tracked path with a space: `git` prints an unquoted header, so only the paths from
        // name-status allow parsing it. Otherwise the entire file patch would be lost.
        expect(fileOf(diff.files, 'docs/café notes.md')).toMatchObject({ changeType: 'modify', additions: 2 });
        expect(fileOf(diff.files, 'docs/café notes.md').patch).toContain('+deuxième ligne');
        expect(fileOf(diff.files, 'docs/crème notes.md').changeType).toBe('add');
    });

    it('a detached HEAD makes endpoints fail instead of reviewing an empty diff', async () => {
        seedBranch();
        repo.write('src/a.ts', 'const a = 2;\n');
        repo.git('checkout', '--detach');

        await expect(makeHost().getDiff()).rejects.toThrow('detached HEAD');
    });

    it('a repository without main, master or origin asks for a base', async () => {
        seedBranch();
        repo.git('branch', '-m', 'main', 'develop');
        repo.write('src/a.ts', 'const a = 2;\n');

        await expect(makeHost().getDiff()).rejects.toThrow('pass `--base <ref>`');
    });
});
