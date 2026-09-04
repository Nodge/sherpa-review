import type { Comment, Thread } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';

/** Flat reply tree row: unlimited depth, with visual indentation capped at four levels. */
export interface FlatComment {
    readonly comment: Comment;
    readonly parent: Comment | null;
    readonly depth: number;
    readonly indent: number;
    /** Parent author beyond depth four. The view builds the "↳ reply to X" label. */
    readonly replyHintAuthor: string | null;
    readonly subtreeReplies: number;
}

export interface ThreadGroups {
    readonly byFile: ReadonlyMap<string, readonly Thread[]>;
    readonly outside: readonly Thread[];
}

/**
 * The iteration whose diff is rendered, when it is not the active PR iteration (M4-T10).
 * `fileId` belongs to an iteration (fixtures use `makeFileId(diffId, path)`, the review host uses `entry_id`
 * from the diff set). Threads arrive once for the active iteration. In a previous iteration, the thread file is found
 * by `anchor.path`, and a thread sits at its lines only in the iteration it is pinned to.
 */
export interface IterationLayout {
    readonly diffId: string;
    readonly fileIdByPath: ReadonlyMap<string, string>;
}

/**
 * The thread sits at its lines instead of under the file header. In the active iteration (`layout === null`),
 * an outdated anchor moves it under the header (SPEC §2.17). In a previous iteration, the pin decides:
 * "view at the old commit" shows the thread beside the code it was written about.
 */
export function threadAtLines(thread: Thread, layout: IterationLayout | null): boolean {
    if (thread.anchor?.position == null) {
        return false;
    }
    return layout === null ? !thread.outdated : thread.pinnedTo?.diffId === layout.diffId;
}

/** The file in the rendered diff that the thread belongs to. null means the file is absent from this diff. */
export function threadFileId(thread: Thread, layout: IterationLayout | null): string | null {
    const anchor = thread.anchor;
    if (anchor === null) {
        return null;
    }
    return layout === null ? anchor.fileId : (layout.fileIdByPath.get(anchor.path) ?? null);
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
            replyHintAuthor: depth > 4 && parent !== null ? authorName(parent) : null,
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
export function groupThreads(
    threads: readonly Thread[],
    fileIds: ReadonlySet<string>,
    layout: IterationLayout | null = null,
): ThreadGroups {
    const byFile = new Map<string, Thread[]>();
    const outside: Thread[] = [];

    for (const thread of threads) {
        if (thread.anchor === null) {
            if (thread.root.author.bot) {
                outside.push(thread);
            }
            continue;
        }
        const fileId = threadFileId(thread, layout);
        if (fileId === null || !fileIds.has(fileId)) {
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

/**
 * `author` is the participant lens from the discussion card (M5-T16): a thread stays if this
 * login wrote the root or any reply. Source chips apply on top of the lens, rather than replacing it.
 */
export function threadIsVisible(thread: Thread, show: ThreadVisibility, author: string | null = null): boolean {
    if (author !== null && !threadHasAuthor(thread, author)) {
        return false;
    }
    if (thread.resolved) {
        return show.resolved;
    }
    return thread.root.author.bot ? show.bots : show.people;
}

/** The login appears in the thread root or any reply at any depth. */
export function threadHasAuthor(thread: Thread, login: string): boolean {
    const visit = (comment: Comment): boolean =>
        comment.author.login === login || comment.replies.some(visit);
    return visit(thread.root);
}

/** Author name by login from loaded threads. An unknown login stays as a login. */
export function authorDisplayName(threads: readonly Thread[], login: string): string {
    for (const thread of threads) {
        const rows = flattenThread(thread.root);
        for (const row of rows) {
            if (row.comment.author.login === login) {
                return row.comment.author.displayName ?? login;
            }
        }
    }
    return login;
}

export function authorName(comment: Comment): string {
    return comment.author.displayName ?? comment.author.login;
}

export function positionLastLine(position: { readonly line: number; readonly size: number }): number {
    return position.line + Math.max(position.size, 1) - 1;
}

export interface ThreadPlacement {
    readonly byLine: ReadonlyMap<string, readonly Thread[]>;
    /** Line-anchored threads with no visible lines on their side in the model. */
    readonly unplaced: readonly Thread[];
}

/**
 * Places line-anchored threads at visible lines. Hidden context pulls them to the nearest line.
 * The caller decides which threads do not belong at their lines (outdated anchor, different iteration): `threadAtLines`.
 */
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
        if (position === null || position === undefined) {
            unplaced.push(thread);
            continue;
        }
        const candidates = [...visible[position.side]];
        if (candidates.length === 0) {
            unplaced.push(thread);
            continue;
        }
        const lastLine = positionLastLine(position);
        const line = visible[position.side].has(lastLine)
            ? lastLine
            : candidates.reduce((nearest, candidate) =>
                  Math.abs(candidate - lastLine) < Math.abs(nearest - lastLine) ? candidate : nearest,
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
