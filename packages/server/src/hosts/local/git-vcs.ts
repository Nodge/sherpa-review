import os from 'node:os';

import type { CommandRunner, LocalVcs, NameStatusEntry, VcsStatus, VcsStatusEntry } from './vcs.js';
import { changeTypeOf, commandBytes, commandLine, commandText } from './vcs.js';

/**
 * `git` backend for local review. Commands explicitly override settings that break
 * parsing: user `core.quotePath`, `diff.noprefix`, external diff tools
 * and textconv filters change output that the snapshot treats as a format.
 */

/** Config values that must use our settings rather than user settings. */
const CONFIG = ['-c', 'core.quotePath=false'] as const;

/** Diff flags: the patch must be machine-readable with the usual `a/` and `b/` prefixes. */
const DIFF_FLAGS = [
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--src-prefix=a/',
    '--dst-prefix=b/',
] as const;

/** Branches used as the base when `origin/HEAD` is not set. */
const FALLBACK_BASE_BRANCHES = ['main', 'master'] as const;

export function gitVcs(run: CommandRunner): LocalVcs {
    const text = (args: readonly string[]): Promise<string> => commandText(run, 'git', [...CONFIG, ...args]);
    const line = (args: readonly string[]): Promise<string> => commandLine(run, 'git', [...CONFIG, ...args]);
    // The login stays fixed for the server lifetime, while the tree is polled every half minute. Ask once.
    let login: string | null = null;

    return {
        kind: 'git',
        checkoutLabel: 'a git checkout',

        root: async () => (await text(['rev-parse', '--show-toplevel'])).trim(),

        info: async () => {
            const branch = await line(['rev-parse', '--abbrev-ref', 'HEAD']);
            if (branch === 'HEAD') {
                throw new Error('detached HEAD: check out a branch');
            }
            login ??= await gitLogin(run);
            return { branch, head: await line(['rev-parse', 'HEAD']), login };
        },

        defaultBaseRef: () => defaultBaseRef(run),

        mergeBase: (ref) => line(['merge-base', ref, 'HEAD']),

        // `^{commit}` requires a commit: tags and trees cannot be the comparison base.
        revParse: (ref) => line(['rev-parse', '--verify', `${ref}^{commit}`]),

        // `--untracked-files=all` expands untracked directories into files and excludes
        // ignored files (`.gitignore`). Git prints paths relative to the repository root, not cwd.
        // Only nested repositories remain directories (see parsing).
        status: async (projectDir) =>
            parseGitStatus(
                await text([
                    'status',
                    '--porcelain=v2',
                    '-z',
                    '--untracked-files=all',
                    '--no-renames',
                    '--',
                    projectDir,
                ]),
            ),

        // `--relative` without an argument is relative to the command cwd, the project directory.
        diff: (base) => text(['diff', ...DIFF_FLAGS, '--relative', base, '--', '.']),

        nameStatus: async (base) =>
            parseGitNameStatus(
                await text(['diff', ...DIFF_FLAGS, '--name-status', '-z', '--relative', base, '--', '.']),
            ),

        // Git resolves `<rev>:<path>` from the repository root, exactly how the snapshot addresses files.
        show: (ref, rootPath) => commandBytes(run, 'git', [...CONFIG, 'cat-file', 'blob', `${ref}:${rootPath}`]),
    };
}

/**
 * Comment author login: the name from `user.name`, or the system user if absent.
 * The schema rejects empty logins, and there is no reason to guess from `user.email`.
 */
async function gitLogin(run: CommandRunner): Promise<string> {
    const outcome = await run([...CONFIG, 'config', 'user.name']);
    const name = outcome.code === 0 ? outcome.stdout.toString('utf8').trim() : '';
    return name === '' ? os.userInfo().username : name;
}

/**
 * Default base: the branch `origin/HEAD` points to, otherwise local `main` or `master`.
 * If none exists, asks for a base. Sherpa does not guess where the branch forked from.
 */
async function defaultBaseRef(run: CommandRunner): Promise<string> {
    const origin = await run([...CONFIG, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
    const named = origin.code === 0 ? origin.stdout.toString('utf8').trim() : '';
    if (named !== '') {
        return named;
    }

    for (const branch of FALLBACK_BASE_BRANCHES) {
        const local = await run([...CONFIG, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`]);
        if (local.code === 0) {
            return branch;
        }
    }
    throw new Error('cannot pick the base branch of this git repository; pass `--base <ref>`');
}

/**
 * Parses `git status --porcelain=v2 -z`. NUL-separated records: `1`/`u` is a changed file,
 * `2` is a rename (path and previous path in two parts), `?` is an untracked file
 * (or a nested repository with a trailing `/`, which is discarded), `#` is a header.
 */
export function parseGitStatus(stdout: string): VcsStatus {
    const records = stdout.split('\0');
    const changed: VcsStatusEntry[] = [];
    const untracked: string[] = [];

    for (let index = 0; index < records.length; index += 1) {
        const record = records[index] ?? '';
        if (record === '') {
            continue;
        }
        const kind = record.slice(0, 2);

        if (kind === '# ') {
            continue;
        }
        if (kind === '? ') {
            const untrackedPath = record.slice(2);
            // Git lists a nested repository as one entry with a trailing `/`. The diff does not need it:
            // without a gitlink, even `git add` would reject it, and a directory cannot be read as a file.
            if (!untrackedPath.endsWith('/')) {
                untracked.push(untrackedPath);
            }
            continue;
        }
        if (kind === '2 ') {
            // The previous path is a separate part. Consume it along with the record.
            index += 1;
        }
        if (kind === '1 ' || kind === '2 ' || kind === 'u ') {
            const fields = record.split(' ');
            const status = fields[1] ?? '';
            // The path follows the fixed fields, with spaces inside it preserved:
            // `1` has eight fields before the path, `2` has nine (with a rename score), `u` has ten.
            const head = kind === 'u ' ? 10 : kind === '2 ' ? 9 : 8;
            const path = fields.slice(head).join(' ');
            if (path !== '') {
                changed.push({ status, path });
            }
        }
    }
    return { changed, untracked };
}

/**
 * Parses `git diff --name-status -z`: status letter and path in separate NUL-delimited parts,
 * with two paths for `R`/`C`, old and new (these do not occur with `--no-renames`).
 */
export function parseGitNameStatus(stdout: string): NameStatusEntry[] {
    const parts = stdout.split('\0').filter((part) => part !== '');
    const entries: NameStatusEntry[] = [];

    for (let index = 0; index < parts.length; index += 1) {
        const letter = (parts[index] ?? '').slice(0, 1).toUpperCase();
        const renamed = letter === 'R' || letter === 'C';
        const first = parts[index + 1];
        if (first === undefined) {
            break;
        }
        const second = renamed ? parts[index + 2] : undefined;
        index += renamed ? 2 : 1;
        if (renamed && second === undefined) {
            break;
        }

        entries.push({
            changeType: changeTypeOf(letter),
            path: second ?? first,
            oldPath: letter === 'R' ? first : null,
        });
    }
    return entries;
}
