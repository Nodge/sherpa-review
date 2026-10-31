import type { Comment, CommentDraft, DraftBufferEntry, HostId, ReviewHost, Thread } from '@sherpa/protocol';
import { commentDraftSchema } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import type { ReviewFeed } from './review-feed.js';

/**
 * Draft buffer (docs/architecture.md §6 "drafts are never lost").
 *
 * Storage is the `draft_buffer` table for this PR. A record appears on every save/update and
 * disappears once the host accepts it. A failed "server → host" step no longer loses text:
 * the record stays in the buffer, and `DraftBufferWriter` delivers it automatically on a timer, on the
 * "retry" button and at the next server start.
 *
 * This is persisted composer state, not a phantom comment. Buffered records are never
 * mixed into thread snapshots, have no local comment IDs, and cannot be removed by thread polling.
 */

/** Retry delay by attempt number: 10 s → 30 s → one minute, then every minute. */
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000] as const;

export function retryDelayMs(attempts: number): number {
    return RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 60_000;
}

interface BufferRow extends SqlRow {
    id: string;
    comment_id: string | null;
    draft_json: string;
    state: string;
    error: string | null;
    attempts: number;
    idempotency_key: string;
    created_at: string;
    updated_at: string;
}

/** Host write: `commentId === null` creates a draft, otherwise updates an existing draft owned by the reviewer. */
export interface DraftBufferInput {
    /** The composer `clientKey`, also the primary key of the buffer record. */
    readonly id: string;
    readonly draft: CommentDraft;
    readonly commentId: HostId | null;
}

export interface DraftBufferStoreOptions {
    readonly db: SherpaDatabase;
    /** Injectable clock, as in other stores, so tests do not need real time. */
    readonly now?: () => Date;
    /**
     * Record idempotency key. Defaults to its `clientKey`.
     *
     * The key is derived from the id instead of chosen at random. A write response may be lost after
     * the host succeeds, and retrying the same `clientKey` recreates the record. A random key would
     * then produce a second comment, while a key derived from the id returns the same one.
     */
    readonly newKey?: (id: string) => string;
}

/**
 * Buffer records in this PR's SQLite database. The idempotency key is issued once on insertion
 * and never regenerated. Attempts for one record must reach the host under the same key.
 */
export class DraftBufferStore {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly newKey: (id: string) => string;

    constructor(options: DraftBufferStoreOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
        this.newKey = options.newKey ?? ((id: string): string => id);
    }

    list(): DraftBufferEntry[] {
        const rows = this.db
            .prepare('SELECT * FROM draft_buffer ORDER BY created_at, rowid')
            .all() as BufferRow[];
        return rows.flatMap((row) => {
            const entry = toEntry(row);
            return entry === null ? [] : [entry];
        });
    }

    get(id: string): DraftBufferEntry | null {
        const row = this.db.prepare('SELECT * FROM draft_buffer WHERE id = ?').get(id) as BufferRow | undefined;
        return row === undefined ? null : toEntry(row);
    }

    /** Record idempotency key. `null` means the record is absent. */
    idempotencyKeyOf(id: string): string | null {
        const row = this.db.prepare('SELECT idempotency_key FROM draft_buffer WHERE id = ?').get(id) as
            | { idempotency_key: string }
            | undefined;
        return row?.idempotency_key ?? null;
    }

    /**
     * Inserts (or updates) a composer record and sets it to `pending`.
     *
     * A record not yet created in the host (`comment_id IS NULL`) remains a creation even
     * if received as an update. The composer keeps one `clientKey` until creation succeeds, and editing its
     * text edits an unsent draft, rather than calling `updateDraft` with another id.
     */
    upsert(input: DraftBufferInput): DraftBufferEntry {
        const parsed = commentDraftSchema.parse(input.draft);
        const at = this.now().toISOString();
        const existing = this.get(input.id);
        // An update without issue means "leave issue unchanged". The record remembers a toggle that has not
        // been written yet, so replacing the whole record would lose it.
        const draft =
            existing !== null &&
            existing.commentId !== null &&
            parsed.issue === undefined &&
            existing.draft.issue !== undefined
                ? { ...parsed, issue: existing.draft.issue }
                : parsed;
        if (existing === null) {
            this.db
                .prepare(
                    `INSERT INTO draft_buffer (
                        id, comment_id, draft_json, state, error, attempts, idempotency_key, created_at, updated_at
                     ) VALUES (?, ?, ?, 'pending', NULL, 0, ?, ?, ?)`,
                )
                .run(input.id, input.commentId, JSON.stringify(draft), this.newKey(input.id), at, at);
        } else {
            this.db
                .prepare(
                    `UPDATE draft_buffer
                        SET comment_id = ?, draft_json = ?, state = 'pending', updated_at = ?
                      WHERE id = ?`,
                )
                .run(existing.commentId, JSON.stringify(draft), at, input.id);
        }
        const stored = this.get(input.id);
        if (stored === null) {
            throw new Error(`buffer record ${input.id} was not saved`);
        }
        return stored;
    }

    /**
     * Remembers the draft created for this record. The pair outlives the record itself. Without it,
     * writing again with the same key would reach the host as a creation, and the host would use the idempotency key
     * to return the first comment with the old text. The new text would be silently lost.
     */
    markSaved(id: string, commentId: HostId): void {
        this.db
            .prepare(
                `INSERT INTO draft_buffer_saved (id, comment_id, created_at) VALUES (?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET comment_id = excluded.comment_id`,
            )
            .run(id, commentId, this.now().toISOString());
    }

    /**
     * Binds a live record to an already created draft, so later attempts update it instead of
     * creating it again. Needed when the host accepted creation but its response never reached the server.
     */
    attachComment(id: string, commentId: HostId): void {
        this.db
            .prepare('UPDATE draft_buffer SET comment_id = ?, updated_at = ? WHERE id = ?')
            .run(commentId, this.now().toISOString(), id);
        this.markSaved(id, commentId);
    }

    /** Draft created for this key. `null` means nothing has been created for it yet. */
    savedCommentId(id: string): HostId | null {
        const row = this.db.prepare('SELECT comment_id FROM draft_buffer_saved WHERE id = ?').get(id) as
            | { comment_id: string }
            | undefined;
        return row?.comment_id ?? null;
    }

    /**
     * Forgets everything about a deleted draft: its buffer record and key pair. Otherwise retries would keep
     * failing with "comment not found" forever and block ship for this PR (the record keeps the guard active).
     * Returns the keys of removed records so their retry timers can be cancelled.
     */
    forgetComment(commentId: HostId): string[] {
        const ids = (
            this.db.prepare('SELECT id FROM draft_buffer WHERE comment_id = ?').all(commentId) as { id: string }[]
        ).map((row) => row.id);
        this.db.prepare('DELETE FROM draft_buffer WHERE comment_id = ?').run(commentId);
        this.db.prepare('DELETE FROM draft_buffer_saved WHERE comment_id = ?').run(commentId);
        return ids;
    }

    /** Marks an attempt as failed: `failed` state, error text and +1 to the attempt counter. */
    markFailed(id: string, error: string): DraftBufferEntry | null {
        this.db
            .prepare(
                `UPDATE draft_buffer
                    SET state = 'failed', error = ?, attempts = attempts + 1, updated_at = ?
                  WHERE id = ?`,
            )
            .run(error, this.now().toISOString(), id);
        return this.get(id);
    }

    /** `false` means the record was already gone (delivered to the host or discarded). */
    remove(id: string): boolean {
        return this.db.prepare('DELETE FROM draft_buffer WHERE id = ?').run(id).changes > 0;
    }
}

/** Draft write result. `comment` is present only on successful creation. */
export type DraftBufferWriteResult =
    | { readonly outcome: 'saved'; readonly comment: Comment | null }
    | { readonly outcome: 'buffered'; readonly entry: DraftBufferEntry };

export interface DraftBufferTimers {
    readonly setTimeout: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
    readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface DraftBufferWriterOptions {
    /** null means the PR has no host adapter. There is nowhere to write, so the buffer stays empty. */
    readonly host: ReviewHost | null;
    readonly store: DraftBufferStore;
    /** Every buffer change bumps the thread revision. Tabs reread the buffer over SSE. */
    readonly reviewFeed: Pick<ReviewFeed, 'bumpLocalWrite'> | null;
    /** Retry timers, replaced in tests. */
    readonly timers?: DraftBufferTimers;
    readonly log?: (message: string) => void;
}

/**
 * Buffer writer: one attempt per record at a time, with increasing retry delays (`retryDelayMs`).
 *
 * The retry timer uses `unref()`: the server shuts down when idle (see `idle.ts`) and does not stay
 * alive for an undelivered draft. `start()` picks up the remaining records on the next launch.
 */
export class DraftBufferWriter {
    private readonly host: ReviewHost | null;
    private readonly store: DraftBufferStore;
    private readonly reviewFeed: Pick<ReviewFeed, 'bumpLocalWrite'> | null;
    private readonly timers: DraftBufferTimers;
    private readonly log: (message: string) => void;
    /** Records for the same destination reach the host in order, even if the previous one failed. */
    private readonly queues = new Map<string, Promise<unknown>>();
    private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
    /** Discarded records: an in-flight attempt checks this set when it returns. */
    private readonly discarded = new Set<string>();
    private closed = false;

    constructor(options: DraftBufferWriterOptions) {
        this.host = options.host;
        this.store = options.store;
        this.reviewFeed = options.reviewFeed;
        this.timers = options.timers ?? {
            setTimeout: (handler, ms) => setTimeout(handler, ms),
            clearTimeout: (timer) => {
                clearTimeout(timer);
            },
        };
        this.log =
            options.log ??
            ((message: string): void => {
                process.stderr.write(`sherpa-review-server: ${message}\n`);
            });
    }

    list(): DraftBufferEntry[] {
        return this.store.list();
    }

    /**
     * Saves a draft: upserts it into the buffer, tries the host, then either removes the row (`saved`)
     * or leaves it waiting for a retry (`buffered`).
     *
     * A write with a key that already created a draft updates that draft instead of creating another
     * one: the host would return the first comment for the idempotency key, silently losing the new text
     * (the composer keeps `clientKey` until it learns that the save succeeded).
     */
    write(input: DraftBufferInput): Promise<DraftBufferWriteResult> {
        return this.enqueue(input.commentId ?? input.id, () => {
            // Resolve the destination here, not when enqueuing: while this record waited for its
            // turn, the attempt ahead of it may have completed creation. This now updates
            // the created draft. Checking earlier would send a create request to the host and return
            // the old comment for the idempotency key instead of the new text.
            const commentId = input.commentId ?? this.store.savedCommentId(input.id);
            this.store.upsert({ ...input, commentId });
            return this.attempt(input.id, input.commentId === null && commentId !== null);
        });
    }

    /** Retries immediately (the "retry" button) and resets the timer delay. */
    async retry(id: string): Promise<void> {
        const entry = this.store.get(id);
        if (entry === null) {
            return;
        }
        this.cancelRetry(id);
        await this.enqueue(entry.commentId ?? id, () => this.attempt(id));
    }

    /**
     * Discards a record: the reviewer no longer needs the text, so there is nothing to deliver. Uses the same queue
     * as attempts, otherwise the discard could race with a call already sent to the host. An attempt
     * that finds its record discarded removes the draft it created (see `attempt`).
     */
    async discard(id: string): Promise<void> {
        this.discarded.add(id);
        this.cancelRetry(id);
        const entry = this.store.get(id);
        const key = entry?.commentId ?? this.store.savedCommentId(id) ?? id;
        await this.enqueue(key, () => {
            const removed = this.store.remove(id);
            this.discarded.delete(id);
            if (removed) {
                this.reviewFeed?.bumpLocalWrite();
            }
            return Promise.resolve();
        });
    }

    /**
     * The host draft was deleted: its record has nowhere to go, and the key no longer points to anything.
     * Without this, an undeliverable record would stay forever and prevent shipping the PR.
     */
    forgetComment(commentId: HostId): void {
        const ids = this.store.forgetComment(commentId);
        for (const id of ids) {
            this.cancelRetry(id);
        }
        if (ids.length > 0) {
            this.reviewFeed?.bumpLocalWrite();
        }
    }

    /**
     * Enqueues retries for everything left in the buffer from the previous launch, including `pending`
     * rows: the process may have been killed between the upsert and the host response, leaving no one to await them.
     */
    start(): void {
        for (const entry of this.store.list()) {
            this.scheduleRetry(entry.id, entry.attempts);
        }
    }

    /** Clears retry timers so nothing wakes up against a closed database after the server stops. */
    close(): void {
        this.closed = true;
        for (const timer of this.retries.values()) {
            this.timers.clearTimeout(timer);
        }
        this.retries.clear();
    }

    /**
     * One attempt to deliver a record to the host. A missing record counts as delivered.
     * `wantComment` means the caller needs the comment itself, but the record updated an already
     * created draft, so the comment is looked up in the host threads.
     */
    private async attempt(id: string, wantComment = false): Promise<DraftBufferWriteResult> {
        const entry = this.store.get(id);
        if (entry === null) {
            return { outcome: 'saved', comment: null };
        }
        // The delay starts at this attempt: its outcome determines the next retry.
        this.cancelRetry(id);
        const host = this.host;
        if (host === null) {
            const failed = this.store.markFailed(id, 'This PR has no host adapter: there is nowhere to save the draft.');
            this.reviewFeed?.bumpLocalWrite();
            return { outcome: 'buffered', entry: failed ?? entry };
        }

        try {
            const comment = await this.callHost(host, entry, id, wantComment);
            this.cancelRetry(id);
            this.store.remove(id);
            if (comment !== null && this.discarded.has(id)) {
                // The record was discarded while this attempt was in flight. The host draft already exists,
                // and must be removed because the reviewer discarded it.
                await this.deleteCreated(host, comment.id);
                this.reviewFeed?.bumpLocalWrite();
                return { outcome: 'saved', comment: null };
            }
            if (comment !== null) {
                this.store.markSaved(id, comment.id);
            }
            this.reviewFeed?.bumpLocalWrite();
            return { outcome: 'saved', comment };
        } catch (error) {
            const message = messageOf(error);
            const failed = this.store.markFailed(id, message);
            this.reviewFeed?.bumpLocalWrite();
            this.log(`draft ${id} remains buffered: ${message}`);
            this.scheduleRetry(id, failed?.attempts ?? 1);
            return { outcome: 'buffered', entry: failed ?? entry };
        }
    }

    private async callHost(
        host: ReviewHost,
        entry: DraftBufferEntry,
        id: string,
        wantComment: boolean,
    ): Promise<Comment | null> {
        if (entry.commentId === null) {
            const idempotencyKey = this.store.idempotencyKeyOf(id);
            const created = await host.saveDraft(entry.draft, idempotencyKey === null ? {} : { idempotencyKey });
            return await this.converge(host, id, entry.draft, created);
        }
        await this.writeUpdate(host, entry.commentId, entry.draft);
        return wantComment ? await this.findComment(host, entry.commentId) : null;
    }

    /**
     * Updates the created draft to match the record text.
     *
     * A host that already accepted creation returns the original comment on a retry with the same
     * idempotency key, without applying the new text. If the first response was lost
     * and the reviewer has edited the text since then, the returned comment would have the old body, and
     * the server would report success for the wrong text. An update fixes the mismatch. If it fails,
     * the record is already bound to the draft, so the next attempt updates it instead of creating one.
     */
    private async converge(
        host: ReviewHost,
        id: string,
        draft: CommentDraft,
        created: Comment,
    ): Promise<Comment> {
        const staleIssue = draft.issue !== undefined && created.issue !== draft.issue;
        // Compare text edges loosely: the host may trim a trailing newline, and that alone
        // should not cause an extra update for every created draft.
        if (created.body.trim() === draft.body.trim() && !staleIssue) {
            return created;
        }
        this.store.attachComment(id, created.id);
        await this.writeUpdate(host, created.id, draft);
        return { ...created, body: draft.body, ...(draft.issue === undefined ? {} : { issue: draft.issue }) };
    }

    /** Updates a draft: `issue: undefined` means "leave the toggle unchanged". */
    private async writeUpdate(host: ReviewHost, commentId: HostId, draft: CommentDraft): Promise<void> {
        if (draft.issue === undefined) {
            await host.updateDraft(commentId, draft.body);
        } else {
            await host.updateDraft(commentId, draft.body, draft.issue);
        }
    }

    /**
     * Finds a comment by id in the host threads. Needed for the rare case of saving with the same key after
     * the record has already been delivered: the draft creation endpoint needs a comment to return.
     * If it is missing (or the host did not respond), the text is still saved, and the composer gets
     * the binding with the next thread snapshot.
     */
    private async findComment(host: ReviewHost, commentId: HostId): Promise<Comment | null> {
        try {
            return findComment(await host.getThreads(), commentId);
        } catch {
            return null;
        }
    }

    /** A draft created by an attempt that was already discarded. Failure is logged and tolerated. */
    private async deleteCreated(host: ReviewHost, commentId: HostId): Promise<void> {
        try {
            await host.deleteDraft(commentId);
        } catch (error) {
            this.log(`draft ${commentId} was created after discard and could not be deleted: ${messageOf(error)}`);
        }
    }

    private scheduleRetry(id: string, attempts: number): void {
        if (this.closed || this.retries.has(id)) {
            return;
        }
        const timer = this.timers.setTimeout(() => {
            this.retries.delete(id);
            void this.retry(id);
        }, retryDelayMs(Math.max(attempts, 1)));
        // The retry timer does not keep the process alive: idle shutdown proceeds as usual.
        const unrefable: { unref?: () => void } = timer;
        unrefable.unref?.();
        this.retries.set(id, timer);
    }

    private cancelRetry(id: string): void {
        const timer = this.retries.get(id);
        if (timer !== undefined) {
            this.timers.clearTimeout(timer);
            this.retries.delete(id);
        }
    }

    private enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
        const request = (this.queues.get(key) ?? Promise.resolve()).then(work);
        const tail = request.then(
            () => undefined,
            () => undefined,
        );
        this.queues.set(key, tail);
        void tail.then(() => {
            if (this.queues.get(key) === tail) {
                this.queues.delete(key);
            }
        });
        return request;
    }
}

/** Converts a buffer row to a contract record. An invalid draft blob is not a record. */
function toEntry(row: BufferRow): DraftBufferEntry | null {
    let draft: CommentDraft;
    try {
        draft = commentDraftSchema.parse(JSON.parse(row.draft_json));
    } catch {
        return null;
    }
    return {
        id: row.id,
        draft,
        commentId: row.comment_id,
        state: row.state === 'failed' ? 'failed' : 'pending',
        error: row.error,
        attempts: row.attempts,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** Finds a comment with this id in the thread tree. Returns `null` when absent. */
function findComment(threads: readonly Thread[], commentId: HostId): Comment | null {
    const visit = (comment: Comment): Comment | null => {
        if (comment.id === commentId) {
            return comment;
        }
        for (const reply of comment.replies) {
            const found = visit(reply);
            if (found !== null) {
                return found;
            }
        }
        return null;
    };
    for (const thread of threads) {
        const found = visit(thread.root);
        if (found !== null) {
            return found;
        }
    }
    return null;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
