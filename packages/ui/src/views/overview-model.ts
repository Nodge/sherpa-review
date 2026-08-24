import type { FileDiff, Lens, Thread } from '@sherpa/protocol';

export type OwnershipKind = 'mine' | 'other' | 'mixed' | 'generated';
export type OwnershipSegment = 'mine' | 'all';

export interface OwnershipGroup {
    readonly path: string;
    readonly files: number;
    readonly lines: number;
    readonly additions: number;
    readonly deletions: number;
    readonly ownership: OwnershipKind | null;
}

export interface OwnershipSummary {
    readonly available: boolean;
    readonly note: string | null;
    readonly mineFiles: number;
    readonly totalFiles: number;
    readonly mineLines: number;
    readonly totalLines: number;
    readonly groups: readonly OwnershipGroup[];
}

/** Aggregates the diff by its first two path segments and marks each directory relative to the ownership lens. */
export function ownershipSummary(
    files: readonly FileDiff[],
    ownership: Lens | null,
    segment: OwnershipSegment,
    fallbackNote = 'The ownership zone is unavailable for this PR.',
): OwnershipSummary {
    const available = ownership?.available === true;
    const minePaths = new Set(available ? ownership.paths : []);
    const mineFiles = available ? files.filter((file) => minePaths.has(file.path)) : [];
    const shown = segment === 'mine' && available ? mineFiles : files;
    const buckets = new Map<string, FileDiff[]>();

    for (const file of shown) {
        const path = ownershipGroupPath(file.path);
        const bucket = buckets.get(path);
        if (bucket === undefined) {
            buckets.set(path, [file]);
        } else {
            bucket.push(file);
        }
    }

    return {
        available,
        note: available ? null : (ownership?.note ?? fallbackNote),
        mineFiles: mineFiles.length,
        totalFiles: files.length,
        mineLines: changedLines(mineFiles),
        totalLines: changedLines(files),
        groups: [...buckets].map(([path, grouped]) => ({
            path,
            files: grouped.length,
            lines: changedLines(grouped),
            additions: sum(grouped, 'additions'),
            deletions: sum(grouped, 'deletions'),
            ownership: available ? ownershipOf(grouped, minePaths) : null,
        })),
    };
}

/** Keep the root segment as is and shorten other paths to their first two parts. */
export function ownershipGroupPath(path: string): string {
    return path.split('/').slice(0, 2).join('/');
}

export interface DiscussionStats {
    readonly open: number;
    readonly resolved: number;
    readonly bots: number;
}

/** Overview counters: open and resolved are mutually exclusive, while bot is an independent source flag. */
export function discussionStats(threads: readonly Thread[]): DiscussionStats {
    let open = 0;
    let resolved = 0;
    let bots = 0;
    for (const thread of threads) {
        if (thread.resolved) {
            resolved += 1;
        } else {
            open += 1;
        }
        if (thread.root.author.bot) {
            bots += 1;
        }
    }
    return { open, resolved, bots };
}

function ownershipOf(files: readonly FileDiff[], minePaths: ReadonlySet<string>): OwnershipKind {
    if (files.every((file) => file.generated)) {
        return 'generated';
    }
    const mine = files.filter((file) => minePaths.has(file.path)).length;
    if (mine === files.length) {
        return 'mine';
    }
    return mine === 0 ? 'other' : 'mixed';
}

function changedLines(files: readonly FileDiff[]): number {
    return files.reduce((total, file) => total + file.additions + file.deletions, 0);
}

function sum(files: readonly FileDiff[], key: 'additions' | 'deletions'): number {
    return files.reduce((total, file) => total + file[key], 0);
}
