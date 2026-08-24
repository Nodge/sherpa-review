import type { FileContent, FileDiff, UiFileProgress } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';
import type { FileReadState } from '../progress/read-state.js';
import { changedLinesOf, readStateOf } from '../progress/read-state.js';
import type { ExpandAmount } from './expand.js';
import { EXPAND_STEP } from './expand.js';
import type { LineKey, LineSelection } from './selection.js';

/**
 * Diff view state outside the React tree (requirements §1/C3): what the worker has parsed, what is expanded,
 * what is read, and what is selected. The snapshot is immutable. React reads it through `useSyncExternalStore`.
 *
 * Reading progress (T8) has two layers here: `progress` holds explicit reviewer records (the source of
 * truth), `readState` derives the state from those records and the file itself for the card
 * and tree to render. The view handles endpoint writes and rollback. The store makes no network calls.
 */

export type DiffMode = 'unified' | 'split';

/** Side by side is unavailable below this width (SPEC §2.6). */
export const SPLIT_MIN_WIDTH = 1100;

const DIFF_MODE_KEY = 'sherpa.diffMode';

export interface DiffViewSnapshot {
    /** User choice: preserved on narrow screens while rendering switches to unified mode. */
    readonly diffMode: DiffMode;
    /** The available width is enough for side by side. */
    readonly splitAvailable: boolean;
    /** Mode currently used to render cards. */
    readonly effectiveMode: DiffMode;
    readonly models: ReadonlyMap<string, DiffFileModel>;
    /** File content for "Expand context". null means the file has none. */
    readonly content: ReadonlyMap<string, FileContent | null>;
    readonly expansion: ReadonlyMap<string, ExpandAmount>;
    /** Explicit progress records by fileId. An absent record means the default state. */
    readonly progress: ReadonlyMap<string, UiFileProgress>;
    /** Effective read-state for every diff file (SPEC §2.12). */
    readonly readState: ReadonlyMap<string, FileReadState>;
    /** Files the reviewer opened by hand despite the size-based fold (SPEC §2.13). */
    readonly opened: ReadonlySet<string>;
    /** Whitespace-only lines the reviewer explicitly expanded. */
    readonly whitespaceShown: ReadonlySet<string>;
    readonly selection: LineSelection | null;
}

export interface DiffViewStore {
    readonly subscribe: (listener: () => void) => () => void;
    readonly getSnapshot: () => DiffViewSnapshot;
    readonly setDiffMode: (mode: DiffMode) => void;
    readonly setAvailableWidth: (width: number) => void;
    readonly setModel: (fileId: string, model: DiffFileModel) => void;
    readonly setContent: (fileId: string, content: FileContent | null) => void;
    /** Next context expansion step: +20 lines or everything at once. */
    readonly expand: (fileId: string, amount?: ExpandAmount) => void;
    /** Full server progress: overrides everything the store calculated itself. */
    readonly setProgress: (files: readonly UiFileProgress[]) => void;
    /** Optimistic mark: the record appears immediately, the view calls the endpoint. */
    readonly markViewed: (fileId: string, viewed: boolean) => void;
    /** Roll back an optimistic mark: `null` means no record existed before it. */
    readonly restoreProgress: (fileId: string, record: UiFileProgress | null) => void;
    readonly openFile: (fileId: string) => void;
    readonly showWhitespace: (fileId: string) => void;
    readonly startSelection: (fileId: string, key: LineKey) => void;
    readonly extendSelection: (fileId: string, key: LineKey) => void;
    readonly clearSelection: () => void;
}

export interface DiffViewStoreOptions {
    /** Diff files: supply `generated`, the host mark, and the changed line count. */
    readonly files: readonly FileDiff[];
    /** Initial server progress. Without it, only defaults apply. */
    readonly progress?: readonly UiFileProgress[];
    /** Storage for the mode choice. Tests and the gallery replace it. */
    readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

function readDiffMode(storage: DiffViewStoreOptions['storage']): DiffMode {
    try {
        return storage?.getItem(DIFF_MODE_KEY) === 'split' ? 'split' : 'unified';
    } catch {
        // Browser policy may block localStorage. That must not crash the view.
        return 'unified';
    }
}

export function createDiffViewStore(options: DiffViewStoreOptions): DiffViewStore {
    const storage = options.storage === undefined ? globalStorage() : options.storage;
    const listeners = new Set<() => void>();
    const diffMode = readDiffMode(storage);
    const filesById = new Map(options.files.map((file) => [file.fileId, file]));

    /**
     * Read-state for one file. Changed model lines are needed only when ranges exist
     * (M2). Without ranges there is no coverage to calculate, so no need to parse the model for it.
     */
    const computeReadState = (
        fileId: string,
        progress: ReadonlyMap<string, UiFileProgress>,
        models: ReadonlyMap<string, DiffFileModel>,
    ): FileReadState | null => {
        const file = filesById.get(fileId);
        if (file === undefined) {
            return null;
        }
        const record = progress.get(fileId) ?? null;
        const changed =
            record !== null && record.seenRanges.length > 0
                ? changedLinesOf(models.get(fileId) ?? null)
                : undefined;
        return readStateOf({ file, record, ...(changed === undefined ? {} : { changed }) });
    };

    const recomputeAll = (
        progress: ReadonlyMap<string, UiFileProgress>,
        models: ReadonlyMap<string, DiffFileModel>,
    ): Map<string, FileReadState> => {
        const next = new Map<string, FileReadState>();
        for (const fileId of filesById.keys()) {
            const state = computeReadState(fileId, progress, models);
            if (state !== null) {
                next.set(fileId, state);
            }
        }
        return next;
    };

    /** Recalculates one file, preserving state object identity for the others (card memoization). */
    const recomputeOne = (fileId: string, progress: ReadonlyMap<string, UiFileProgress>): Map<string, FileReadState> => {
        const next = new Map(snapshot.readState);
        const state = computeReadState(fileId, progress, snapshot.models);
        if (state !== null) {
            next.set(fileId, state);
        }
        return next;
    };

    const initialProgress = new Map((options.progress ?? []).map((record) => [record.fileId, record]));
    let snapshot: DiffViewSnapshot = {
        diffMode,
        splitAvailable: true,
        effectiveMode: diffMode,
        models: new Map(),
        content: new Map(),
        expansion: new Map(),
        progress: initialProgress,
        readState: recomputeAll(initialProgress, new Map()),
        opened: new Set(),
        whitespaceShown: new Set(),
        selection: null,
    };

    const update = (patch: Partial<DiffViewSnapshot>): void => {
        const next = { ...snapshot, ...patch };
        snapshot = { ...next, effectiveMode: next.splitAvailable ? next.diffMode : 'unified' };
        for (const listener of [...listeners]) {
            listener();
        }
    };

    return {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => snapshot,

        setDiffMode: (mode) => {
            if (mode === snapshot.diffMode) {
                return;
            }
            try {
                storage?.setItem(DIFF_MODE_KEY, mode);
            } catch {
                // Saving failed, but the mode still applies to the current session.
            }
            update({ diffMode: mode });
        },

        setAvailableWidth: (width) => {
            const splitAvailable = width >= SPLIT_MIN_WIDTH;
            if (splitAvailable !== snapshot.splitAvailable) {
                update({ splitAvailable });
            }
        },

        setModel: (fileId, model) => {
            if (snapshot.models.get(fileId) === model) {
                return;
            }
            const models = new Map(snapshot.models).set(fileId, model);
            // Parsing changes read-state only where coverage is calculated from model lines.
            const recomputed =
                (snapshot.progress.get(fileId)?.seenRanges.length ?? 0) > 0
                    ? computeReadState(fileId, snapshot.progress, models)
                    : null;
            update({
                models,
                ...(recomputed === null ? {} : { readState: new Map(snapshot.readState).set(fileId, recomputed) }),
            });
        },

        setContent: (fileId, content) => {
            update({ content: new Map(snapshot.content).set(fileId, content) });
        },

        expand: (fileId, amount) => {
            const current = snapshot.expansion.get(fileId) ?? 0;
            const next =
                amount ?? (current === 'all' ? 'all' : current + EXPAND_STEP);
            update({ expansion: new Map(snapshot.expansion).set(fileId, next) });
        },

        setProgress: (files) => {
            const progress = new Map(files.map((record) => [record.fileId, record]));
            update({ progress, readState: recomputeAll(progress, snapshot.models) });
        },

        markViewed: (fileId, viewed) => {
            // Marking changes only the flag: ranges are a separate layer, untouched by the endpoint.
            const seenRanges = snapshot.progress.get(fileId)?.seenRanges ?? [];
            const progress = new Map(snapshot.progress).set(fileId, { fileId, viewed, seenRanges });
            update({ progress, readState: recomputeOne(fileId, progress) });
        },

        restoreProgress: (fileId, record) => {
            const progress = new Map(snapshot.progress);
            if (record === null) {
                progress.delete(fileId);
            } else {
                progress.set(fileId, record);
            }
            update({ progress, readState: recomputeOne(fileId, progress) });
        },

        openFile: (fileId) => {
            if (snapshot.opened.has(fileId)) {
                return;
            }
            update({ opened: new Set(snapshot.opened).add(fileId) });
        },

        showWhitespace: (fileId) => {
            if (!snapshot.whitespaceShown.has(fileId)) {
                update({ whitespaceShown: new Set(snapshot.whitespaceShown).add(fileId) });
            }
        },

        startSelection: (fileId, key) => {
            update({ selection: { fileId, anchor: key, focus: key } });
        },

        extendSelection: (fileId, key) => {
            const current = snapshot.selection;
            const anchor = current !== null && current.fileId === fileId ? current.anchor : key;
            if (current !== null && current.fileId === fileId && current.focus === key) {
                return;
            }
            update({ selection: { fileId, anchor, focus: key } });
        },

        clearSelection: () => {
            if (snapshot.selection !== null) {
                update({ selection: null });
            }
        },
    };
}

/** `localStorage` may be absent (SSR, tests). The mode then does not survive a reload. */
function globalStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
    try {
        // Node (tests, worker) has no `localStorage`, despite what lib.dom promises.
        const storage: unknown = globalThis.localStorage;
        return storage == null ? null : (storage as Pick<Storage, 'getItem' | 'setItem'>);
    } catch {
        return null;
    }
}
