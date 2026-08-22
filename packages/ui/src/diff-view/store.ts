import type { FileContent, FileDiff } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';
import type { ExpandAmount } from './expand.js';
import { EXPAND_STEP } from './expand.js';
import type { LineKey, LineSelection } from './selection.js';

/**
 * Diff view state outside the React tree (requirements §1/C3): what the worker has parsed, what is expanded,
 * what is marked read and what is selected. The snapshot is immutable. React reads it through
 * `useSyncExternalStore`.
 *
 * `viewed` marks are ephemeral here. Persistence and optimistic updates/retry belong to M1-T8.
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
    readonly viewed: ReadonlyMap<string, boolean>;
    /** Files the reviewer opened by hand despite the size-based fold (SPEC §2.13). */
    readonly opened: ReadonlySet<string>;
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
    readonly setViewed: (fileId: string, viewed: boolean) => void;
    readonly openFile: (fileId: string) => void;
    readonly startSelection: (fileId: string, key: LineKey) => void;
    readonly extendSelection: (fileId: string, key: LineKey) => void;
    readonly clearSelection: () => void;
}

export interface DiffViewStoreOptions {
    /** Diff files supply the host's initial `viewed` marks. */
    readonly files: readonly FileDiff[];
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

    let snapshot: DiffViewSnapshot = {
        diffMode,
        splitAvailable: true,
        effectiveMode: diffMode,
        models: new Map(),
        content: new Map(),
        expansion: new Map(),
        viewed: new Map(options.files.map((file) => [file.fileId, file.viewed ?? false])),
        opened: new Set(),
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
            update({ models: new Map(snapshot.models).set(fileId, model) });
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

        setViewed: (fileId, viewed) => {
            update({ viewed: new Map(snapshot.viewed).set(fileId, viewed) });
        },

        openFile: (fileId) => {
            if (snapshot.opened.has(fileId)) {
                return;
            }
            update({ opened: new Set(snapshot.opened).add(fileId) });
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
