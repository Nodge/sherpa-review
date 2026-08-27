import type { FileDiff, Lens, LensZone, Thread } from '@sherpa/protocol';

export type OwnershipKind = 'mine' | 'other' | 'mixed' | 'generated';
export type OwnershipSegment = 'mine' | 'all';

export interface OwnershipGroup {
    readonly path: string;
    readonly files: number;
    readonly lines: number;
    readonly additions: number;
    readonly deletions: number;
    readonly ownership: OwnershipKind | null;
    readonly owner: string | null;
    readonly note: string;
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

const OUTSIDE_ZONES_PATH = 'Outside CODEOWNERS zones';
const GENERATED_PATH = 'Generated files';

/** Groups the diff by lens zones, with path-prefix grouping as a fallback. */
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

    return {
        available,
        note: available ? null : (ownership?.note ?? fallbackNote),
        mineFiles: mineFiles.length,
        totalFiles: files.length,
        mineLines: changedLines(mineFiles),
        totalLines: changedLines(files),
        groups:
            ownership?.zones === null || ownership === null
                ? groupsByPrefix(shown, available, minePaths)
                : groupsByZones(shown, ownership.zones),
    };
}

/** Keep the root segment as is and shorten other paths to their first two parts. */
export function ownershipGroupPath(path: string): string {
    return path.split('/').slice(0, 2).join('/');
}

function groupsByZones(files: readonly FileDiff[], zones: readonly LensZone[]): OwnershipGroup[] {
    const byPath = new Map(files.map((file) => [file.path, file] as const));
    const zoned = new Set<string>();
    const groups: OwnershipGroup[] = [];

    for (const zone of zones) {
        const grouped = zone.paths.flatMap((path) => {
            const file = byPath.get(path);
            return file === undefined ? [] : [file];
        });
        if (grouped.length === 0) {
            continue;
        }
        for (const file of grouped) {
            zoned.add(file.path);
        }
        groups.push(
            groupOf(
                zone.path,
                grouped,
                zone.mine ? 'mine' : 'other',
                zone.owner,
                zone.mine
                    ? 'Your ownership zone by CODEOWNERS.'
                    : 'Outside your CODEOWNERS zone.',
            ),
        );
    }

    const outside = files.filter((file) => !zoned.has(file.path));
    const uncovered = outside.filter((file) => !file.generated);
    const generated = outside.filter((file) => file.generated);
    if (uncovered.length > 0) {
        groups.push(
            groupOf(
                OUTSIDE_ZONES_PATH,
                uncovered,
                'other',
                null,
                'These files are not covered by CODEOWNERS zones.',
            ),
        );
    }
    if (generated.length > 0) {
        groups.push(
            groupOf(
                GENERATED_PATH,
                generated,
                'generated',
                null,
                'Generated files are dimmed and count as read by default.',
            ),
        );
    }
    return groups;
}

function groupsByPrefix(
    files: readonly FileDiff[],
    available: boolean,
    minePaths: ReadonlySet<string>,
): OwnershipGroup[] {
    const buckets = new Map<string, FileDiff[]>();
    for (const file of files) {
        const path = ownershipGroupPath(file.path);
        const bucket = buckets.get(path);
        if (bucket === undefined) {
            buckets.set(path, [file]);
        } else {
            bucket.push(file);
        }
    }

    return [...buckets].map(([path, grouped]) => {
        const ownership = available ? ownershipOf(grouped, minePaths) : null;
        return groupOf(path, grouped, ownership, null, prefixNote(ownership));
    });
}

function groupOf(
    path: string,
    files: readonly FileDiff[],
    ownership: OwnershipKind | null,
    owner: string | null,
    note: string,
): OwnershipGroup {
    return {
        path,
        files: files.length,
        lines: changedLines(files),
        additions: sum(files, 'additions'),
        deletions: sum(files, 'deletions'),
        ownership,
        owner,
        note,
    };
}

function prefixNote(ownership: OwnershipKind | null): string {
    switch (ownership) {
        case 'mine':
            return 'The files of this group are your responsibility by CODEOWNERS.';
        case 'other':
            return 'The files of this group are outside your CODEOWNERS zone.';
        case 'mixed':
            return 'The group mixes files inside and outside your CODEOWNERS zone.';
        case 'generated':
            return 'Generated files are dimmed and count as read by default.';
        case null:
            return 'The group is built by path prefix: zone boundaries are unavailable.';
    }
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
