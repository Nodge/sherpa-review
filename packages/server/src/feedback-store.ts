import type { Locale } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';

/**
 * Binds a local review round to its `review.feedback` task (migration 021). Rounds live
 * in the host file, while the queue lives in SQLite. Their link must survive restart, otherwise reconciliation
 * would enqueue a second task for the same round.
 */

/** Round task state: open, accepted or closed by failure (failed tasks are not enqueued again). */
export type FeedbackTaskState = 'open' | 'done' | 'failed';

export interface FeedbackBinding {
    readonly roundId: string;
    readonly taskId: number;
    readonly state: FeedbackTaskState;
    /** Reply language requested by the task, used to validate the submitted result. */
    readonly locale: Locale;
}

interface BindingRow extends SqlRow {
    round_id: string;
    task_id: number;
    state: string;
    locale: string;
}

export interface FeedbackStoreOptions {
    readonly db: SherpaDatabase;
    readonly now?: () => Date;
}

export class FeedbackStore {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;

    constructor(options: FeedbackStoreOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
    }

    /** All known bindings, one per round. */
    list(): FeedbackBinding[] {
        const rows = this.db
            .prepare('SELECT round_id, task_id, state, locale FROM feedback_tasks')
            .all() as BindingRow[];
        return rows.map(bindingOf);
    }

    /** Round binding. If null, the round has never had a task. */
    ofRound(roundId: string): FeedbackBinding | null {
        const row = this.db
            .prepare('SELECT round_id, task_id, state, locale FROM feedback_tasks WHERE round_id = ?')
            .get(roundId) as BindingRow | undefined;
        return row === undefined ? null : bindingOf(row);
    }

    /** Round for a task. If null, the task is not ours. */
    ofTask(taskId: number): FeedbackBinding | null {
        const row = this.db
            .prepare('SELECT round_id, task_id, state, locale FROM feedback_tasks WHERE task_id = ?')
            .get(taskId) as BindingRow | undefined;
        return row === undefined ? null : bindingOf(row);
    }

    /** New round task: re-enqueuing overwrites the previous binding. */
    bind(roundId: string, taskId: number, locale: Locale): void {
        const nowIso = this.now().toISOString();
        this.db
            .prepare(
                `INSERT INTO feedback_tasks (round_id, task_id, state, locale, created_at, updated_at)
                 VALUES (?, ?, 'open', ?, ?, ?)
                 ON CONFLICT(round_id) DO UPDATE SET task_id = excluded.task_id, state = 'open',
                     locale = excluded.locale, updated_at = excluded.updated_at`,
            )
            .run(roundId, taskId, locale, nowIso, nowIso);
    }

    setState(roundId: string, state: FeedbackTaskState): void {
        this.db
            .prepare('UPDATE feedback_tasks SET state = ?, updated_at = ? WHERE round_id = ?')
            .run(state, this.now().toISOString(), roundId);
    }
}

function bindingOf(row: BindingRow): FeedbackBinding {
    return {
        roundId: row.round_id,
        taskId: row.task_id,
        state: stateOf(row.state),
        locale: row.locale === 'en' ? 'en' : 'ru',
    };
}

function stateOf(value: string): FeedbackTaskState {
    return value === 'done' || value === 'failed' ? value : 'open';
}
