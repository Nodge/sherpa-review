import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Temporary git repository for backend tests: real `git` in a temporary directory, never
 * inside another checkout. Setup uses an isolated environment and explicit config so
 * machine settings do not affect the result. The backend runs as in production, without them.
 */

/** `user.name` in temporary repositories: the local host author and viewer login in tests. */
export const GIT_USER_NAME = 'Sherpa Tester';

/** Setup environment excludes user and system config. */
const SETUP_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** Setup config: without it, `git` on another machine may refuse to commit or name the branch differently. */
const SETUP_CONFIG = [
    '-c',
    `user.name=${GIT_USER_NAME}`,
    '-c',
    'user.email=sherpa@example.com',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'init.defaultBranch=main',
] as const;

/** Checks whether `git` is installed. All git tests are skipped without it. */
export const gitAvailable = ((): boolean => {
    try {
        execFileSync('git', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
})();

export class GitFixture {
    /** Repository root resolved through realpath: `/var` is a symlink on macOS. */
    readonly root: string;

    constructor(root: string) {
        this.root = root;
    }

    /** Setup command. Returns text output and fails the test on error. */
    git(...args: readonly string[]): string {
        // Capture stderr: `git` also writes normal messages there, such as "Switched to a new branch".
        return execFileSync('git', [...SETUP_CONFIG, ...args], {
            cwd: this.root,
            env: SETUP_ENV,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }

    write(rootPath: string, content: string | Buffer): void {
        const absolute = path.join(this.root, rootPath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, content);
    }

    remove(rootPath: string): void {
        fs.rmSync(path.join(this.root, rootPath), { force: true });
    }

    /** Stages and commits the entire working tree. Returns the sha. */
    commitAll(message: string): string {
        this.git('add', '-A');
        this.git('commit', '-m', message);
        return this.git('rev-parse', 'HEAD').trim();
    }

    /**
     * Files in the review base: commits only these paths and moves `main` to that commit, so
     * the default base (merge-base with `main`) is this commit. Other tree changes stay uncommitted.
     * Used with `makeFeatureRepo`.
     */
    commitBase(files: Readonly<Record<string, string | Buffer>>): void {
        const paths = Object.keys(files);
        for (const rootPath of paths) {
            this.write(rootPath, files[rootPath] ?? '');
        }
        this.git('add', '--', ...paths);
        this.git('commit', '-m', 'base', '--', ...paths);
        this.git('branch', '-f', 'main', 'HEAD');
    }

    cleanup(): void {
        fs.rmSync(this.root, { recursive: true, force: true });
    }
}

/** Empty repository in the system temporary directory. */
export function makeGitRepo(prefix = 'sherpa-git-'): GitFixture {
    const root = tempRoot(prefix);
    const fixture = new GitFixture(root);
    fixture.git('init');
    // Set the author name in repository config: the backend reads it too, so the login is machine-independent.
    fixture.git('config', 'user.name', GIT_USER_NAME);
    return fixture;
}

/**
 * Repository on `feature`, branched from an empty `main` commit: tests set the base with
 * `commitBase` and make changes by writing to the tree, in either order.
 */
export function makeFeatureRepo(prefix = 'sherpa-git-'): GitFixture {
    const fixture = makeGitRepo(prefix);
    fixture.git('commit', '--allow-empty', '-m', 'init');
    fixture.git('checkout', '-b', 'feature');
    return fixture;
}

/**
 * Copy of a prepared repository with its history. One `git` invocation costs about a hundred milliseconds,
 * so a suite that needs the same tree for each test can copy the directory more cheaply
 * than creating the repository again.
 */
export function copyGitRepo(template: GitFixture, prefix = 'sherpa-git-'): GitFixture {
    const root = tempRoot(prefix);
    fs.cpSync(template.root, root, { recursive: true });
    return new GitFixture(root);
}

function tempRoot(prefix: string): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
