import type { UiPrState, UiPrStatePatch } from '@sherpa/protocol';
import { uiPrStateSchema } from '@sherpa/protocol';

import type { SherpaDatabase, SqlRow } from './db.js';
import { transaction } from './db.js';

export interface PrStateStoreOptions {
    readonly db: SherpaDatabase;
    /** Injectable clock: tests can check `updated_at` without real time. */
    readonly now?: () => Date;
}

interface StateRow extends SqlRow {
    key: string;
    value_json: string;
}

type PrStateField = keyof UiPrState;

/**
 * UI state for one PR: collapsed tree directories and diff cards, recent palette
 * commands. Stored in per-PR SQLite instead of the browser: the tab origin changes with the
 * server port, so `localStorage` does not survive until the next run.
 *
 * The table is KV by schema field name: a corrupt value falls back to the default for
 * that field alone, keeping its neighbours. A patch replaces the named field entirely, otherwise
 * resetting a directory to its default (deleting a map key) could not be expressed.
 */
export class PrStateStore {
    private readonly db: SherpaDatabase;
    private readonly now: () => Date;
    private readonly txPatch: (partial: UiPrStatePatch) => UiPrState;

    constructor(options: PrStateStoreOptions) {
        this.db = options.db;
        this.now = options.now ?? ((): Date => new Date());
        this.txPatch = transaction(this.db, (partial: UiPrStatePatch) => this.patchInTransaction(partial));
    }

    read(): UiPrState {
        const rows = this.db.prepare('SELECT key, value_json FROM ui_pr_state').all() as StateRow[];
        const source: Record<string, unknown> = {};
        for (const row of rows) {
            // An unknown table key (manual edit, version rollback) is not our field. Skip it silently.
            if (!isPrStateField(row.key)) {
                continue;
            }
            const value = parseField(row.key, row.value_json);
            if (value !== undefined) {
                source[row.key] = value;
            }
        }
        // Missing and discarded fields get schema defaults: UI state must not prevent the tab from opening.
        return uiPrStateSchema.parse(source);
    }

    /** Replaces named fields entirely and returns the whole state. `undefined` leaves a field unchanged. */
    patch(partial: UiPrStatePatch): UiPrState {
        return this.txPatch(partial);
    }

    private patchInTransaction(partial: UiPrStatePatch): UiPrState {
        const updatedAt = this.now().toISOString();
        const upsert = this.db.prepare(
            `INSERT INTO ui_pr_state (key, value_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        );
        for (const field of Object.keys(uiPrStateSchema.shape) as PrStateField[]) {
            const value = partial[field];
            if (value !== undefined) {
                upsert.run(field, JSON.stringify(value), updatedAt);
            }
        }
        return this.read();
    }
}

function isPrStateField(key: string): key is PrStateField {
    return Object.hasOwn(uiPrStateSchema.shape, key);
}

/** A stored field value. `undefined` means parsing failed, so the field will use its default. */
function parseField(field: PrStateField, raw: string): unknown {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch (error) {
        process.stderr.write(
            `PR state field ${field} could not be parsed as JSON (${messageOf(error)}). Using the default.\n`,
        );
        return undefined;
    }

    if (!uiPrStateSchema.shape[field].safeParse(value).success) {
        process.stderr.write(`PR state field ${field} failed schema validation. Using the default.\n`);
        return undefined;
    }
    return value;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
