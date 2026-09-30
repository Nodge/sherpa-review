import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GitFixture } from './git-fixture.js';
import { gitAvailable, makeGitRepo } from './git-fixture.js';
import { gitVcs } from './git-vcs.js';
import type { LocalVcs } from './vcs.js';
import { commandRunnerIn } from './vcs.js';

/**
 * `git` backend using real `git` in a temporary repository: commands and output parsing.
 * Repository setup uses an isolated environment, while the backend runs as in production,
 * with the config present on the machine.
 */

/** Each scenario invokes `git` about ten times. The default five-second timeout is too short. */
const TIMEOUT_MS = 30_000;

describe.skipIf(!gitAvailable)('git backend', { timeout: TIMEOUT_MS }, () => {
    let repo: GitFixture;

    beforeEach(() => {
        repo = makeGitRepo();
    });

    afterEach(() => {
        repo.cleanup();
    });

    /** Backend operating in the project directory, which defaults to the repository root. */
    function open(projectDir: string = repo.root): LocalVcs {
        return gitVcs(commandRunnerIn('git', projectDir));
    }

    /** Base commit on `main` with a `feature` branch on top. */
    function seedBranch(): string {
        repo.write('src/a.ts', 'const a = 1;\n');
        repo.write('README.md', '# app\n');
        const base = repo.commitAll('base');
        repo.git('checkout', '-b', 'feature');
        return base;
    }

    it('checkout root, branch, HEAD and login', async () => {
        seedBranch();
        repo.write('src/a.ts', 'const a = 2;\n');
        const head = repo.commitAll('work');
        const vcs = open();

        expect(await vcs.root()).toBe(repo.root);
        const info = await vcs.info();
        expect(info).toEqual({ branch: 'feature', head, login: 'Sherpa Tester' });
    });

    // A review belongs to a branch: reject a detached HEAD instead of treating HEAD as a branch name.
    it('detached HEAD fails with a clear error', async () => {
        seedBranch();
        repo.git('checkout', '--detach');

        await expect(open().info()).rejects.toThrow('detached HEAD');
    });

    it('the default base is the branch origin/HEAD points to', async () => {
        seedBranch();
        // No remote or network needed: create refs directly in the repository.
        repo.git('update-ref', 'refs/remotes/origin/main', 'main');
        repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

        expect(await open().defaultBaseRef()).toBe('origin/main');
    });

    it('without origin the default base is local main, otherwise master', async () => {
        seedBranch();
        expect(await open().defaultBaseRef()).toBe('main');

        repo.git('branch', '-m', 'main', 'master');
        expect(await open().defaultBaseRef()).toBe('master');
    });

    it('without origin, main or master, asks for an explicit base', async () => {
        seedBranch();
        repo.git('branch', '-m', 'main', 'develop');

        await expect(open().defaultBaseRef()).rejects.toThrow('pass `--base <ref>`');
    });

    it('merge-base and an explicit base resolve to commits', async () => {
        const base = seedBranch();
        repo.write('src/a.ts', 'const a = 2;\n');
        const head = repo.commitAll('work');
        const vcs = open();

        expect(await vcs.mergeBase('main')).toBe(base);
        expect(await vcs.revParse('main')).toBe(base);
        expect(await vcs.revParse('HEAD')).toBe(head);
        await expect(vcs.revParse('no-such-ref')).rejects.toThrow('failed');
    });

    // Base against working tree: commits after the base, staged and unstaged changes in one patch.
    it('the diff includes the commit after the base and working-tree changes', async () => {
        const base = seedBranch();
        repo.write('src/a.ts', 'const a = 2;\n');
        repo.commitAll('work');
        repo.write('src/a.ts', 'const a = 3;\n');
        const vcs = open();

        const patch = await vcs.diff(base);
        expect(patch).toContain('diff --git a/src/a.ts b/src/a.ts');
        expect(patch).toContain('-const a = 1;');
        expect(patch).toContain('+const a = 3;');
        expect(await vcs.nameStatus(base)).toEqual([{ changeType: 'modify', path: 'src/a.ts', oldPath: null }]);
    });

    it('staged addition, deletion and untracked file', async () => {
        const base = seedBranch();
        repo.write('src/fresh.ts', 'export const fresh = 1;\n');
        repo.git('add', 'src/fresh.ts');
        repo.remove('README.md');
        repo.write('notes.md', 'local only\n');
        const vcs = open();

        const status = await vcs.status(repo.root);
        expect(status.changed.map((entry) => entry.path).sort()).toEqual(['README.md', 'src/fresh.ts']);
        expect(status.untracked).toEqual(['notes.md']);
        expect((await vcs.nameStatus(base)).sort((left, right) => left.path.localeCompare(right.path))).toEqual([
            { changeType: 'delete', path: 'README.md', oldPath: null },
            { changeType: 'add', path: 'src/fresh.ts', oldPath: null },
        ]);
    });

    // Git expands directories and applies ignore rules. The snapshot does not walk them itself.
    it('files ignored by .gitignore do not appear in status', async () => {
        seedBranch();
        repo.write('.gitignore', 'node_modules/\ndist/\n');
        repo.commitAll('ignore rules');
        repo.write('node_modules/pkg/index.js', 'module.exports = 1;\n');
        repo.write('dist/app.js', 'console.log(1);\n');
        repo.write('src/new/deep.ts', 'export const deep = 1;\n');

        expect((await open().status(repo.root)).untracked).toEqual(['src/new/deep.ts']);
    });

    it('a nested repository among untracked files is excluded', async () => {
        seedBranch();
        repo.write('vendor/lib/index.js', 'module.exports = 1;\n');
        repo.git('-C', 'vendor/lib', 'init');
        repo.write('src/new.ts', 'export const fresh = 1;\n');

        expect((await open().status(repo.root)).untracked).toEqual(['src/new.ts']);
    });

    it('paths with spaces and non-ASCII characters pass through unchanged', async () => {
        const base = seedBranch();
        repo.write('docs/café notes.md', '# café\n');
        repo.git('add', '--', 'docs/café notes.md');
        const vcs = open();

        expect((await vcs.status(repo.root)).changed.map((entry) => entry.path)).toEqual([
            'docs/café notes.md',
        ]);
        expect(await vcs.nameStatus(base)).toEqual([
            { changeType: 'add', path: 'docs/café notes.md', oldPath: null },
        ]);
        expect(await vcs.diff(base)).toContain('diff --git a/docs/café notes.md b/docs/café notes.md');
    });

    // Machine config is outside our control, but it must not break output parsing.
    it('user diff.noprefix and core.quotePath settings do not break parsing', async () => {
        const base = seedBranch();
        repo.git('config', 'diff.noprefix', 'true');
        repo.git('config', 'core.quotePath', 'true');
        repo.write('src/naïve.ts', 'export const value = 1;\n');
        repo.git('add', '--', 'src/naïve.ts');
        const vcs = open();

        expect(await vcs.diff(base)).toContain('diff --git a/src/naïve.ts b/src/naïve.ts');
        expect(await vcs.nameStatus(base)).toEqual([
            { changeType: 'add', path: 'src/naïve.ts', oldPath: null },
        ]);
        expect((await vcs.status(repo.root)).changed.map((entry) => entry.path)).toEqual(['src/naïve.ts']);
    });

    it('the project directory is a repository subdirectory', async () => {
        repo.write('app/src/a.ts', 'const a = 1;\n');
        repo.write('other/b.ts', 'const b = 1;\n');
        const base = repo.commitAll('base');
        repo.git('checkout', '-b', 'feature');
        repo.write('app/src/a.ts', 'const a = 2;\n');
        repo.write('other/b.ts', 'const b = 2;\n');
        repo.write('app/notes.md', 'local\n');
        const projectDir = path.join(repo.root, 'app');
        const vcs = open(projectDir);

        // Status paths are relative to the repository root, but include only the project directory.
        const status = await vcs.status(projectDir);
        expect(status.changed.map((entry) => entry.path)).toEqual(['app/src/a.ts']);
        expect(status.untracked).toEqual(['app/notes.md']);
        // Diff paths are relative to the project directory.
        expect(await vcs.nameStatus(base)).toEqual([{ changeType: 'modify', path: 'src/a.ts', oldPath: null }]);
        expect(await vcs.diff(base)).toContain('diff --git a/src/a.ts b/src/a.ts');
    });

    it('show returns the old side and throws on failure instead of returning empty content', async () => {
        const base = seedBranch();
        repo.write('src/a.ts', 'const a = 2;\n');
        const vcs = open();

        expect((await vcs.show(base, 'src/a.ts')).toString('utf8')).toBe('const a = 1;\n');
        await expect(vcs.show(base, 'src/gone.ts')).rejects.toThrow('failed');
    });

    it('a binary file is returned as a blob, byte for byte', async () => {
        const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x01]);
        repo.write('assets/logo.png', image);
        const base = repo.commitAll('base');
        repo.git('checkout', '-b', 'feature');
        repo.write('assets/logo.png', Buffer.concat([image, Buffer.from([0x02])]));
        const vcs = open();

        expect(await vcs.show(base, 'assets/logo.png')).toEqual(image);
        expect(await vcs.diff(base)).toContain('Binary files a/assets/logo.png and b/assets/logo.png differ');
        expect(fs.existsSync(path.join(repo.root, 'assets/logo.png'))).toBe(true);
    });
});
