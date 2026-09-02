import type { Comment, FileAnchor, HostId, Lens, LensZone, ReviewUser, Thread } from '@sherpa/protocol';

import { makeFileId } from './patch.js';

/**
 * Small domain-object builders for fixtures: threads, comments, anchors, lenses.
 * Everything is deterministic. No `Date.now()`/`Math.random()`, only supplied values.
 */

export function human(login: string, displayName: string | null = null): ReviewUser {
    return { login, displayName, bot: false };
}

/**
 * Bot source. `displayName` is a label such as "AI Review (security)": the host
 * supplies it, and the UI shows it as a source chip (brief F4).
 */
export function bot(login: string, displayName: string): ReviewUser {
    return { login, displayName, bot: true };
}

export interface CommentSpec {
    id: HostId;
    author: ReviewUser;
    body: string;
    createdAt: string;
    editedAt?: string;
    draft?: boolean;
    /** No status by default, as with a comment created outside Sherpa. */
    issue?: boolean;
    replies?: readonly Comment[];
}

export function comment(spec: CommentSpec): Comment {
    return {
        id: spec.id,
        author: spec.author,
        body: spec.body,
        draft: spec.draft ?? false,
        issue: spec.issue ?? null,
        createdAt: spec.createdAt,
        editedAt: spec.editedAt ?? null,
        replies: [...(spec.replies ?? [])],
    };
}

export interface ThreadSpec {
    /** Defaults to the root comment id: the host identifies a thread by its root. */
    id?: HostId;
    anchor: FileAnchor | null;
    resolved?: boolean;
    resolvedBy?: string;
    outdated?: boolean;
    root: Comment;
}

export function thread(spec: ThreadSpec): Thread {
    return {
        id: spec.id ?? spec.root.id,
        anchor: spec.anchor,
        resolved: spec.resolved ?? false,
        resolvedBy: spec.resolvedBy ?? null,
        outdated: spec.outdated ?? false,
        // Pin to the anchor's iteration in M4-T3.
        pinnedTo: null,
        root: spec.root,
    };
}

/** Anchor to a file line. Without `line`, the comment applies to the whole file. */
export function anchor(
    diffId: HostId,
    path: string,
    position: { side: 'old' | 'new'; line: number; size?: number } | null = null,
): FileAnchor {
    return {
        fileId: makeFileId(diffId, path),
        path,
        position: position === null ? null : { side: position.side, line: position.line, size: position.size ?? 1 },
    };
}

export interface LensSpec {
    id: string;
    label: string;
    paths?: readonly string[];
    available?: boolean;
    note?: string;
    zones?: readonly LensZone[] | null;
}

export function lens(spec: LensSpec): Lens {
    return {
        id: spec.id,
        label: spec.label,
        paths: [...(spec.paths ?? [])],
        available: spec.available ?? true,
        note: spec.note ?? null,
        zones: spec.zones?.map((zone) => ({ ...zone, paths: [...zone.paths] })) ?? null,
    };
}
