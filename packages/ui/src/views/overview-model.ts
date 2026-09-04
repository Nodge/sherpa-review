import type { Comment, FileDiff, Lens, LensZone, ReviewUser, Thread } from '@sherpa/protocol';

import type { Translate } from '../i18n/index.js';
import type { ThreadSourceCounts, ThreadVisibility } from '../threads/model.js';
import { countThreadSources, threadIsVisible } from '../threads/model.js';

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



/** Groups the diff by lens zones, with path-prefix grouping as a fallback. */
export function ownershipSummary(
    files: readonly FileDiff[],
    ownership: Lens | null,
    segment: OwnershipSegment,
    t: Translate,
    fallbackNote = t('overview.ownership.fallbackNote'),
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
                ? groupsByPrefix(shown, available, minePaths, t)
                : groupsByZones(shown, ownership.zones, t),
    };
}

/** Keep the root segment as is and shorten other paths to their first two parts. */
export function ownershipGroupPath(path: string): string {
    return path.split('/').slice(0, 2).join('/');
}

function groupsByZones(files: readonly FileDiff[], zones: readonly LensZone[], t: Translate): OwnershipGroup[] {
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
                t(zone.mine ? 'overview.ownership.note.mineZone' : 'overview.ownership.note.otherZone'),
            ),
        );
    }

    const outside = files.filter((file) => !zoned.has(file.path));
    const uncovered = outside.filter((file) => !file.generated);
    const generated = outside.filter((file) => file.generated);
    if (uncovered.length > 0) {
        groups.push(
            groupOf(
                t('overview.ownership.outsideZones'),
                uncovered,
                'other',
                null,
                t('overview.ownership.note.uncovered'),
            ),
        );
    }
    if (generated.length > 0) {
        groups.push(
            groupOf(
                t('overview.ownership.generatedPath'),
                generated,
                'generated',
                null,
                t('overview.ownership.note.generated'),
            ),
        );
    }
    return groups;
}

function groupsByPrefix(
    files: readonly FileDiff[],
    available: boolean,
    minePaths: ReadonlySet<string>,
    t: Translate,
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
        return groupOf(path, grouped, ownership, null, prefixNote(ownership, t));
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

function prefixNote(ownership: OwnershipKind | null, t: Translate): string {
    switch (ownership) {
        case 'mine':
            return t('overview.ownership.note.prefixMine');
        case 'other':
            return t('overview.ownership.note.prefixOther');
        case 'mixed':
            return t('overview.ownership.note.prefixMixed');
        case 'generated':
            return t('overview.ownership.note.generated');
        case null:
            return t('overview.ownership.note.prefixUnknown');
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


/** Participant row in the discussion card (SPEC additions §1e item 3). */
export interface DiscussionParticipant {
    readonly login: string;
    readonly name: string;
    readonly bot: boolean;
    /** Threads they contributed to (root or reply) under the current chips: filters change both rows and counts. */
    readonly threads: number;
    readonly open: number;
    /** Latest comment in these threads. null means there is nothing to count from. */
    readonly lastActivity: string | null;
}

export interface DiscussionSummary {
    /** The card header counts all PR threads, unaffected by chips. */
    readonly total: number;
    readonly open: number;
    /** Chip counters use the same categories as the diff toolbar. */
    readonly counts: ThreadSourceCounts;
    readonly participants: readonly DiscussionParticipant[];
    /** Human threads absent from every line of the rendered diff. Bot threads never appear here. */
    readonly outside: readonly Thread[];
}

/**
 * Discussion card model (SPEC additions §1e). A participant row follows the same
 * rule as the author lens in Full diff (`threadHasAuthor`): include everyone who
 * wrote the root or any reply, so the row count matches its lens results. A bot
 * gets its own row with a counter, but its thread bodies never enter the card.
 */
export function discussionSummary(
    threads: readonly Thread[],
    fileIds: ReadonlySet<string>,
    show: ThreadVisibility,
): DiscussionSummary {
    const visible = threads.filter((thread) => threadIsVisible(thread, show));
    const byLogin = new Map<string, { participant: DiscussionParticipant; lastMs: number }>();

    for (const thread of visible) {
        const lastMs = lastActivityMs(thread.root);
        for (const author of threadAuthors(thread)) {
            const entry = byLogin.get(author.login);
            if (entry === undefined) {
                byLogin.set(author.login, {
                    participant: {
                        login: author.login,
                        name: author.displayName ?? author.login,
                        bot: author.bot,
                        threads: 1,
                        open: thread.resolved ? 0 : 1,
                        lastActivity: lastActivityIso(thread.root),
                    },
                    lastMs,
                });
                continue;
            }
            const fresher = lastMs > entry.lastMs;
            byLogin.set(author.login, {
                lastMs: fresher ? lastMs : entry.lastMs,
                participant: {
                    ...entry.participant,
                    threads: entry.participant.threads + 1,
                    open: entry.participant.open + (thread.resolved ? 0 : 1),
                    lastActivity: fresher ? lastActivityIso(thread.root) : entry.participant.lastActivity,
                },
            });
        }
    }

    const participants = [...byLogin.values()]
        .sort((left, right) => {
            if (left.participant.bot !== right.participant.bot) {
                return left.participant.bot ? 1 : -1;
            }
            if (left.participant.open !== right.participant.open) {
                return right.participant.open - left.participant.open;
            }
            if (left.lastMs !== right.lastMs) {
                return right.lastMs - left.lastMs;
            }
            return left.participant.login.localeCompare(right.participant.login);
        })
        .map((entry) => entry.participant);

    const outside = visible
        .filter((thread) => !thread.root.author.bot && !atCode(thread, fileIds))
        .sort((left, right) => Date.parse(right.root.createdAt) - Date.parse(left.root.createdAt));

    return {
        total: threads.length,
        open: threads.filter((thread) => !thread.resolved).length,
        counts: countThreadSources(threads),
        participants,
        outside,
    };
}

/** Everyone who wrote in the thread, in order of appearance. Repeated logins use the name from their first occurrence. */
function threadAuthors(thread: Thread): readonly ReviewUser[] {
    const byLogin = new Map<string, ReviewUser>();
    const visit = (comment: Comment): void => {
        if (!byLogin.has(comment.author.login)) {
            byLogin.set(comment.author.login, comment.author);
        }
        comment.replies.forEach(visit);
    };
    visit(thread.root);
    return [...byLogin.values()];
}

/** The thread is at code in the rendered diff: it has an anchor, and its file remains in this diff. */
function atCode(thread: Thread, fileIds: ReadonlySet<string>): boolean {
    return thread.anchor !== null && fileIds.has(thread.anchor.fileId);
}

function lastActivityMs(root: Comment): number {
    const own = Date.parse(root.editedAt ?? root.createdAt);
    const time = Number.isFinite(own) ? own : 0;
    return root.replies.reduce((latest, reply) => Math.max(latest, lastActivityMs(reply)), time);
}

function lastActivityIso(root: Comment): string | null {
    let best: string | null = null;
    let bestMs = Number.NEGATIVE_INFINITY;
    const visit = (comment: Comment): void => {
        const iso = comment.editedAt ?? comment.createdAt;
        const ms = Date.parse(iso);
        if (Number.isFinite(ms) && ms > bestMs) {
            bestMs = ms;
            best = iso;
        }
        comment.replies.forEach(visit);
    };
    visit(root);
    return best;
}

/** Card column width (360px) at 12px body size: roughly this many characters fit on one line. */
const CARD_LINE_CHARS = 48;
const CARD_BODY_LINES = 4;

/**
 * Thread bodies longer than four lines appear truncated with "expand" (§1e item 4).
 * Count from the source markdown: the layout cannot be measured before rendering, and the button
 * decision is also needed for static gallery rendering.
 */
export function bodyNeedsExpand(body: string, lineChars = CARD_LINE_CHARS): boolean {
    let lines = 0;
    let fenced = false;
    for (const raw of body.split('\n')) {
        const line = raw.trimEnd();
        if (line.startsWith('```')) {
            fenced = !fenced;
            lines += 1;
            continue;
        }
        // Code blocks do not wrap (§1e): the screen shows as many lines as the source.
        lines += fenced || line === '' ? 1 : Math.ceil(line.length / lineChars) || 1;
    }
    return lines > CARD_BODY_LINES;
}
