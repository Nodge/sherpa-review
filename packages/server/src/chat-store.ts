import type {
    AgentNote,
    ChatAnchor,
    ChatExchange,
    ChatExchangeStatus,
    UiChatResponse,
} from '@sherpa/protocol';
import { agentNoteSchema, chatAnchorSchema, chatExchangeSchema, uiChatResponseSchema } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';
import type { TransactionalEnqueue } from './queue.js';

/** Chat change listener consumed by the UI SSE channel (`UI_CHAT_EVENT`). */
export type ChatListener = (revision: number) => void;

export interface ChatStoreOptions {
    readonly db: SherpaDatabase;
    readonly now?: () => Date;
}

interface ExchangeRow extends SqlRow {
    id: number;
    question: string;
    anchor: string | null;
    status: string;
    answer: string | null;
    progress_text: string | null;
    error: string | null;
    task_id: number | null;
    head_commit: string | null;
    created_at: string;
    updated_at: string;
}

interface NoteRow extends SqlRow {
    id: number;
    exchange_id: number;
    anchor: string;
    text: string;
    commit_hash: string | null;
    created_at: string;
}

/** Exchange with server fields absent from the contract (`taskId` is already part of the exchange). */
export interface StoredChatExchange {
    readonly exchange: ChatExchange;
    readonly headCommit: string | null;
}

/**
 * Question history and local agent notes for one PR. All public data passes protocol
 * schemas. The revision increases on every actual change to an exchange or note.
 */
export class ChatStore {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly listeners = new Set<ChatListener>();
    private readonly txAsk: (
        question: string,
        anchor: ChatAnchor | null,
        headCommit: string | null,
        enqueue: () => TransactionalEnqueue,
    ) => { exchange: ChatExchange; enqueued: TransactionalEnqueue };
    private readonly txRetry: (
        exchangeId: number,
        headCommit: string | null,
        enqueue: () => TransactionalEnqueue,
    ) => { exchange: ChatExchange; enqueued: TransactionalEnqueue } | null;
    private readonly txComplete: (taskId: number, answer: string) => boolean;

    private revisionValue = 0;
    private closed = false;

    constructor(options: ChatStoreOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
        this.txAsk = transaction(this.db, (question, anchor, headCommit, enqueue) =>
            this.askInTransaction(question, anchor, headCommit, enqueue),
        );
        this.txRetry = transaction(this.db, (exchangeId, headCommit, enqueue) =>
            this.retryInTransaction(exchangeId, headCommit, enqueue),
        );
        this.txComplete = transaction(this.db, (taskId, answer) => this.completeInTransaction(taskId, answer));
    }

    get revision(): number {
        return this.revisionValue;
    }

    read(): UiChatResponse {
        const exchanges = this.exchangeRows().map((row) => toStoredExchange(row).exchange);
        const notes = (this.db.prepare('SELECT * FROM agent_notes ORDER BY id').all() as NoteRow[]).map(toNote);
        return uiChatResponseSchema.parse({ exchanges, notes, chatRevision: this.revisionValue });
    }

    exchange(exchangeId: number): StoredChatExchange | null {
        const row = this.db.prepare('SELECT * FROM chat_exchanges WHERE id = ?').get(exchangeId) as
            | ExchangeRow
            | undefined;
        return row === undefined ? null : toStoredExchange(row);
    }

    exchangeForTask(taskId: number): StoredChatExchange | null {
        const row = this.db.prepare('SELECT * FROM chat_exchanges WHERE task_id = ?').get(taskId) as
            | ExchangeRow
            | undefined;
        return row === undefined ? null : toStoredExchange(row);
    }

    openExchanges(): StoredChatExchange[] {
        return this.exchangeRows()
            .filter((row) => row.status === 'queued' || row.status === 'running')
            .map(toStoredExchange);
    }

    ask(
        question: string,
        anchor: ChatAnchor | null,
        headCommit: string | null,
        enqueue: () => TransactionalEnqueue,
    ): ChatExchange {
        const parsedAnchor = anchor === null ? null : chatAnchorSchema.parse(anchor);
        const result = this.txAsk(question, parsedAnchor, headCommit, enqueue);
        this.bump();
        result.enqueued.onCommitted();
        return result.exchange;
    }

    retry(exchangeId: number, headCommit: string | null, enqueue: () => TransactionalEnqueue): boolean {
        const result = this.txRetry(exchangeId, headCommit, enqueue);
        if (result === null) {
            return false;
        }
        this.bump();
        result.enqueued.onCommitted();
        return true;
    }

    /** Open exchange state for the current task. Repeating the same value does not bump the revision. */
    syncTask(
        taskId: number,
        status: Extract<ChatExchangeStatus, 'queued' | 'running' | 'failed' | 'cancelled'>,
        progressText: string | null,
        error: string | null,
    ): void {
        const row = this.exchangeRowForTask(taskId);
        if (row === null || row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') {
            return;
        }
        const nextProgress = status === 'running' ? progressText : null;
        const nextError = status === 'failed' ? error : null;
        if (row.status === status && row.progress_text === nextProgress && row.error === nextError) {
            return;
        }

        this.db
            .prepare(
                `UPDATE chat_exchanges SET status = ?, answer = NULL, progress_text = ?, error = ?, updated_at = ?
                 WHERE id = ?`,
            )
            .run(status, nextProgress, nextError, this.nowIso(), row.id);
        this.bump();
    }

    cancelExchange(exchangeId: number): void {
        const row = this.exchange(exchangeId);
        if (row === null || (row.exchange.status !== 'queued' && row.exchange.status !== 'running')) {
            return;
        }
        this.db
            .prepare(
                `UPDATE chat_exchanges SET status = 'cancelled', answer = NULL, progress_text = NULL,
                 error = NULL, updated_at = ? WHERE id = ?`,
            )
            .run(this.nowIso(), exchangeId);
        this.bump();
    }

    failExchange(exchangeId: number, error: string): void {
        const row = this.exchange(exchangeId);
        if (
            row === null ||
            row.exchange.status === 'done' ||
            row.exchange.status === 'failed' ||
            row.exchange.status === 'cancelled'
        ) {
            return;
        }
        this.db
            .prepare(
                `UPDATE chat_exchanges SET status = 'failed', answer = NULL, progress_text = NULL,
                 error = ?, updated_at = ? WHERE id = ?`,
            )
            .run(error, this.nowIso(), exchangeId);
        this.bump();
    }

    completeTask(taskId: number, answer: string): void {
        if (this.txComplete(taskId, answer)) {
            this.bump();
        }
    }

    deleteNote(noteId: number): boolean {
        const info = this.db.prepare('DELETE FROM agent_notes WHERE id = ?').run(noteId);
        if (info.changes === 0) {
            return false;
        }
        this.bump();
        return true;
    }

    subscribe(listener: ChatListener): () => void {
        if (this.closed) {
            return () => undefined;
        }
        this.listeners.add(listener);
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.listeners.delete(listener);
        };
    }

    close(): void {
        this.closed = true;
        this.listeners.clear();
    }

    private askInTransaction(
        question: string,
        anchor: ChatAnchor | null,
        headCommit: string | null,
        enqueue: () => TransactionalEnqueue,
    ): { exchange: ChatExchange; enqueued: TransactionalEnqueue } {
        const enqueued = enqueue();
        const now = this.nowIso();
        const info = this.db
            .prepare(
                `INSERT INTO chat_exchanges (
                    question, anchor, status, answer, progress_text, error, task_id, head_commit,
                    created_at, updated_at
                 ) VALUES (?, ?, 'queued', NULL, NULL, NULL, ?, ?, ?, ?)`,
            )
            .run(question, anchor === null ? null : JSON.stringify(anchor), enqueued.record.id, headCommit, now, now);
        return { exchange: this.requireExchange(Number(info.lastInsertRowid)).exchange, enqueued };
    }

    private retryInTransaction(
        exchangeId: number,
        headCommit: string | null,
        enqueue: () => TransactionalEnqueue,
    ): { exchange: ChatExchange; enqueued: TransactionalEnqueue } | null {
        const current = this.exchange(exchangeId);
        if (current === null || (current.exchange.status !== 'failed' && current.exchange.status !== 'cancelled')) {
            return null;
        }

        const enqueued = enqueue();
        this.db
            .prepare(
                `UPDATE chat_exchanges SET status = 'queued', answer = NULL, progress_text = NULL,
                 error = NULL, task_id = ?, head_commit = ?, updated_at = ? WHERE id = ?`,
            )
            .run(enqueued.record.id, headCommit, this.nowIso(), exchangeId);
        return { exchange: this.requireExchange(exchangeId).exchange, enqueued };
    }

    /** Commits the answer and note for an anchored question in a single transaction. */
    private completeInTransaction(taskId: number, answer: string): boolean {
        const row = this.exchangeRowForTask(taskId);
        if (row === null || row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') {
            return false;
        }

        const now = this.nowIso();
        this.db
            .prepare(
                `UPDATE chat_exchanges SET status = 'done', answer = ?, progress_text = NULL,
                 error = NULL, updated_at = ? WHERE id = ?`,
            )
            .run(answer, now, row.id);
        if (row.anchor !== null) {
            const anchor = parseAnchor(row.anchor);
            this.db
                .prepare(
                    `INSERT INTO agent_notes (exchange_id, anchor, text, commit_hash, created_at)
                     VALUES (?, ?, ?, ?, ?)`,
                )
                .run(row.id, JSON.stringify(anchor), answer, row.head_commit, now);
        }
        return true;
    }

    private exchangeRows(): ExchangeRow[] {
        return this.db.prepare('SELECT * FROM chat_exchanges ORDER BY id').all() as ExchangeRow[];
    }

    private exchangeRowForTask(taskId: number): ExchangeRow | null {
        const row = this.db.prepare('SELECT * FROM chat_exchanges WHERE task_id = ?').get(taskId) as
            | ExchangeRow
            | undefined;
        return row ?? null;
    }

    private requireExchange(exchangeId: number): StoredChatExchange {
        const exchange = this.exchange(exchangeId);
        if (exchange === null) {
            throw new Error(`Chat exchange ${String(exchangeId)} is not in storage.`);
        }
        return exchange;
    }

    private bump(): void {
        this.revisionValue += 1;
        if (!this.closed) {
            for (const listener of [...this.listeners]) {
                listener(this.revisionValue);
            }
        }
    }

    private nowIso(): string {
        return this.now().toISOString();
    }
}

function toStoredExchange(row: ExchangeRow): StoredChatExchange {
    const exchange = chatExchangeSchema.parse({
        id: row.id,
        question: row.question,
        anchor: row.anchor === null ? null : parseAnchor(row.anchor),
        status: row.status,
        taskId: row.task_id,
        answer: row.answer,
        progressText: row.progress_text,
        error: row.error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
    return { exchange, headCommit: row.head_commit };
}

function toNote(row: NoteRow): AgentNote {
    return agentNoteSchema.parse({
        id: row.id,
        exchangeId: row.exchange_id,
        anchor: parseAnchor(row.anchor),
        text: row.text,
        commit: row.commit_hash,
        createdAt: row.created_at,
    });
}

function parseAnchor(raw: string): ChatAnchor {
    return chatAnchorSchema.parse(JSON.parse(raw) as unknown);
}
