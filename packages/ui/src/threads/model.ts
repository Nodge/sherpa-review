import type { Comment, Thread } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';

/** Flat reply tree row: unlimited depth, with visual indentation capped at four levels. */
export interface FlatComment {
    readonly comment: Comment;
    readonly parent: Comment | null;
    /** The root is 1, its replies are 2, and so on. */
    readonly depth: number;
    /** Left reply indentation in pixels: 27 per level (the parent text column), capped at 108. */
    readonly indent: number;
    /** Parent author beyond the fourth reply level: the view builds the "↳ to" label. */
    readonly replyHintAuthor: string | null;
    readonly subtreeReplies: number;
}

/** Message text column: avatar 18 + gap 9. Also the reply indentation step. */
const INDENT_STEP = 27;
/** Indentation stops growing here. The header shows "↳ to" for deeper replies instead. */
const INDENT_MAX_LEVEL = 4;

export interface ThreadGroups {
    readonly byFile: ReadonlyMap<string, readonly Thread[]>;
    readonly outside: readonly Thread[];
}

/**
 * The iteration whose diff is currently rendered, when it is not the active PR iteration.
 * `fileId` belongs to an iteration (`makeFileId(diffId, path)` in fixtures, an
 * opaque id on the host), while threads arrive once for the active iteration. In an old iteration, the thread file is found
 * by `anchor.path`, and a thread sits at its lines only in the iteration it is pinned to.
 */
export interface IterationLayout {
    readonly diffId: string;
    readonly fileIdByPath: ReadonlyMap<string, string>;
}

/**
 * The thread sits at its lines instead of under the file header. In the active iteration (`layout === null`),
 * an outdated anchor moves the thread under the header (docs/design/SPEC-elements.md §2.17). In a previous iteration, the pin decides:
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

/** A PR-level thread is anchored to neither a file nor a line. */
export function isPrLevelThread(thread: Thread): boolean {
    return thread.anchor === null;
}

/**
 * PR-level threads from people and bots are shown in full in the "Comments on the PR" modal
 * (docs/design/SPEC-changes-2026-09-20.md §4). Bot threads also appear in the "outside the diff" group.
 */
export function prLevelThreads(threads: readonly Thread[]): Thread[] {
    return threads.filter(isPrLevelThread);
}

/** First nonempty body line: collapsed thread preview in the code marker and the modal row. */
export function commentFirstLine(body: string, limit = 0): string {
    const trimmed = (body.split('\n').find((candidate) => candidate.trim() !== '') ?? '').trim();
    return limit > 0 && trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
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
            indent: Math.min(depth - 1, INDENT_MAX_LEVEL) * INDENT_STEP,
            replyHintAuthor: depth - 1 > INDENT_MAX_LEVEL && parent !== null ? authorName(parent) : null,
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

/**
 * The participant lens from the Discussion card is the only remaining thread filter:
 * collapsing into a marker removes the noise of bots and resolved remarks (docs/design/SPEC-changes-2026-09-20.md §3).
 * `author === null` means no lens, so every thread is visible.
 */
export function threadIsVisible(thread: Thread, author: string | null = null): boolean {
    return author === null || threadHasAuthor(thread, author);
}

/** Message count across all thread levels, shown on the marker beside the line. */
export function threadCommentCount(thread: Thread): number {
    return flattenThread(thread.root).length;
}

/** The thread contains my unpublished draft as the root or a reply. */
export function threadHasDraft(thread: Thread): boolean {
    return flattenThread(thread.root).some((row) => row.comment.draft);
}

/**
 * Per-comment resolution: a thread is resolved if it has at least one comment
 * with issue set and all such comments are resolved. `null` means the host does not track per-comment resolution (`Comment.resolved`
 * is `null` for all comments), so only `Thread.resolved` from the adapter determines the thread state.
 *
 * On the server, the adapter applies the same rule (`docs/decisions.md`, "Threads, issue and composer").
 * Here it is needed only for the optimistic frame between clicking Resolve and receiving the host response.
 */
export function threadResolvedByIssues(thread: Thread): boolean | null {
    const rows = flattenThread(thread.root);
    if (rows.every((row) => row.comment.resolved === null)) {
        return null;
    }
    const issues = rows.filter((row) => row.comment.issue === true);
    return issues.length > 0 && issues.every((row) => row.comment.resolved === true);
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
