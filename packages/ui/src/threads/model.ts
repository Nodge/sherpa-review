import type { Comment, Thread } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';

/** Flat reply tree row: unlimited depth, with visual indentation capped at four levels. */
export interface FlatComment {
    readonly comment: Comment;
    readonly parent: Comment | null;
    readonly depth: number;
    readonly indent: number;
    readonly replyHint: string | null;
    readonly subtreeReplies: number;
}

export interface ThreadGroups {
    readonly byFile: ReadonlyMap<string, readonly Thread[]>;
    readonly outside: readonly Thread[];
}

export interface ThreadSourceCounts {
    readonly people: number;
    readonly bots: number;
    readonly resolved: number;
}

export interface ThreadVisibility {
    readonly people: boolean;
    readonly bots: boolean;
    readonly resolved: boolean;
}

/** A PR-level thread is anchored to neither a file nor a line. */
export function isPrLevelThread(thread: Thread): boolean {
    return thread.anchor === null;
}

/** Human root comments at PR level. Replies and bot threads stay in the regular reader. */
export function prLevelHumanThreads(threads: readonly Thread[]): Thread[] {
    return threads.filter((thread) => isPrLevelThread(thread) && !thread.root.author.bot);
}

/** Flattens a branching tree into depth-first order and counts the full subtree of each reply. */
export function flattenThread(root: Comment): FlatComment[] {
    const rows: FlatComment[] = [];

    const visit = (comment: Comment, parent: Comment | null, depth: number): number => {
        const index = rows.length;
        rows.push({
            comment,
            parent,
            depth,
            indent: Math.min(Math.max(depth - 1, 0), 3) * 15,
            replyHint: depth > 4 && parent !== null ? `reply to ${authorName(parent)}` : null,
            subtreeReplies: 0,
        });

        let descendants = 0;
        for (const reply of comment.replies) {
            descendants += 1 + visit(reply, comment, depth + 1);
        }
        const row = rows[index];
        if (row !== undefined) {
            rows[index] = { ...row, subtreeReplies: descendants };
        }
        return descendants;
    };

    visit(root, null, 1);
    return rows;
}

/** Threads in the known diff go to files. outside keeps PR-level bots and missing files. */
export function groupThreads(threads: readonly Thread[], fileIds: ReadonlySet<string>): ThreadGroups {
    const byFile = new Map<string, Thread[]>();
    const outside: Thread[] = [];

    for (const thread of threads) {
        const fileId = thread.anchor?.fileId ?? null;
        if (fileId === null) {
            if (thread.root.author.bot) {
                outside.push(thread);
            }
            continue;
        }
        if (!fileIds.has(fileId)) {
            outside.push(thread);
            continue;
        }
        const bucket = byFile.get(fileId);
        if (bucket === undefined) {
            byFile.set(fileId, [thread]);
        } else {
            bucket.push(thread);
        }
    }

    return { byFile, outside };
}

/** Chip categories do not overlap. Resolved threads are not counted again as human or bot threads. */
export function countThreadSources(threads: readonly Thread[]): ThreadSourceCounts {
    let people = 0;
    let bots = 0;
    let resolved = 0;
    for (const thread of threads) {
        if (thread.resolved) {
            resolved += 1;
        } else if (thread.root.author.bot) {
            bots += 1;
        } else {
            people += 1;
        }
    }
    return { people, bots, resolved };
}

export function threadIsVisible(thread: Thread, show: ThreadVisibility): boolean {
    if (thread.resolved) {
        return show.resolved;
    }
    return thread.root.author.bot ? show.bots : show.people;
}

export function authorName(comment: Comment): string {
    return comment.author.displayName ?? comment.author.login;
}

export interface ThreadPlacement {
    readonly byLine: ReadonlyMap<string, readonly Thread[]>;
    /** Line-anchored threads with no visible lines on their side in the model. */
    readonly unplaced: readonly Thread[];
}

/** Places anchored threads on visible lines. Threads in hidden context attach to the nearest visible line. */
export function placeThreadsOnVisibleLines(
    model: DiffFileModel | null,
    threads: readonly Thread[],
): ThreadPlacement {
    const byLine = new Map<string, Thread[]>();
    if (model?.content.kind !== 'text') {
        return { byLine, unplaced: threads };
    }

    const visible = { old: new Set<number>(), new: new Set<number>() };
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            if (line.oldLine !== null) {
                visible.old.add(line.oldLine);
            }
            if (line.newLine !== null) {
                visible.new.add(line.newLine);
            }
        }
    }

    const unplaced: Thread[] = [];
    for (const thread of threads) {
        const position = thread.anchor?.position;
        if (position === null || position === undefined || thread.outdated) {
            unplaced.push(thread);
            continue;
        }
        const candidates = [...visible[position.side]];
        if (candidates.length === 0) {
            unplaced.push(thread);
            continue;
        }
        const line = visible[position.side].has(position.line)
            ? position.line
            : candidates.reduce((nearest, candidate) =>
                  Math.abs(candidate - position.line) < Math.abs(nearest - position.line) ? candidate : nearest,
              );
        const key = `${position.side}:${String(line)}`;
        const bucket = byLine.get(key);
        if (bucket === undefined) {
            byLine.set(key, [thread]);
        } else {
            bucket.push(thread);
        }
    }
    return { byLine, unplaced };
}
