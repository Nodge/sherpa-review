import type { FileContent, FileDiff, UiFileProgress } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';
import type { FileReadState } from '../progress/read-state.js';
import { changedLinesOf, readStateOf } from '../progress/read-state.js';
import type { ExpandDirection, FileExpansion, GapKey } from './expand.js';
import { expandAllGaps, expandGap } from './expand.js';
import type { LineKey, LineSelection } from './selection.js';

/**
 * Diff view state outside the React tree (docs/architecture.md §1): what the worker has parsed, what is expanded,
 * what is read, and what is selected. The snapshot is immutable. React reads it through `useSyncExternalStore`.
 *
 * Reading progress has two layers here: `progress` holds the reviewer's explicit records (server
 * truth), `readState` derives the state from those records and the file itself for the card
 * and tree to render. The view handles endpoint writes and rollback. The store makes no network calls.
 */

export type DiffMode = 'unified' | 'split';
export type FileCollapseReason = 'viewed' | 'manual' | 'generated';

/** Below this width, side by side is unavailable (docs/design/SPEC-elements.md §2.6). */
export const SPLIT_MIN_WIDTH = 1100;

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
    readonly expansion: ReadonlyMap<string, FileExpansion>;
    /** Explicit progress records by fileId. An absent record means the default state. */
    readonly progress: ReadonlyMap<string, UiFileProgress>;
    /** Effective read-state of each diff file (docs/design/SPEC-elements.md §2.12). */
    readonly readState: ReadonlyMap<string, FileReadState>;
    /** Manual expansion overriding the generated default. */
    readonly collapseExpanded: ReadonlySet<string>;
    /** Temporary expansion of a viewed file from its summary row. */
    readonly collapseExpandedViewed: ReadonlySet<string>;
    /** Manual collapse of a regular file. */
    readonly collapseCollapsed: ReadonlySet<string>;
    /** Reviewer's explicit choice for persistence: true to collapse, false to expand. */
    readonly collapsePreferences: ReadonlyMap<string, boolean>;
    /** Files the reviewer opened by hand despite collapse by size (docs/design/SPEC-elements.md §2.13). */
    readonly opened: ReadonlySet<string>;
    /** Whitespace-only lines the reviewer explicitly expanded. */
    readonly whitespaceShown: ReadonlySet<string>;
    readonly selection: LineSelection | null;
    /** Between the actual start of a drag and mouse button release. */
    readonly selectionDragging: boolean;
}

export interface DiffViewStore {
    readonly subscribe: (listener: () => void) => () => void;
    readonly getSnapshot: () => DiffViewSnapshot;
    readonly setDiffMode: (mode: DiffMode) => void;
    readonly setAvailableWidth: (width: number) => void;
    readonly setModel: (fileId: string, model: DiffFileModel) => void;
    readonly setContent: (fileId: string, content: FileContent | null) => void;
    /** Expand one gap control in a given direction. */
    readonly expandGap: (fileId: string, gapKey: GapKey, direction: ExpandDirection, amount?: number) => void;
    /** Fully expand all original file gaps and those visible after transform. */
    readonly expandFile: (fileId: string, visibleGapKeys?: readonly GapKey[]) => void;
    /** Full server progress: overrides everything the store calculated itself. */
    readonly setProgress: (files: readonly UiFileProgress[]) => void;
    /** Optimistic mark: the record appears immediately, the view calls the endpoint. */
    readonly markViewed: (fileId: string, viewed: boolean) => void;
    /** Roll back an optimistic mark: `null` means no record existed before it. */
    readonly restoreProgress: (fileId: string, record: UiFileProgress | null) => void;
    /** Toggles manual collapse with the same layer formula as route stops (docs/design/SPEC-elements.md §2.9). */
    readonly toggleFileCollapse: (fileId: string) => void;
    /**
     * Full explicit collapse choices: PR state arrived from the server after store creation.
     * Replaces previous choices, because the server value is the same set, just complete.
     */
    readonly setCollapsePreferences: (collapsed: ReadonlyMap<string, boolean>) => void;
    /** Prepare a collapsed file for navigation from the tree, a link, or search. */
    readonly revealFile: (fileId: string) => void;
    readonly openFile: (fileId: string) => void;
    readonly showWhitespace: (fileId: string) => void;
    readonly beginSelection: () => void;
    readonly startSelection: (fileId: string, key: LineKey, side?: 'old' | 'new') => void;
    readonly extendSelection: (fileId: string, key: LineKey, side?: 'old' | 'new') => void;
    /**
     * Extends selection on mouse movement only between `beginSelection` and `finishSelection`.
     * Otherwise any movement with a held button over lines, while selecting text in code or a popover,
     * would extend the active selection from an old anchor.
     */
    readonly dragSelection: (fileId: string, key: LineKey, side?: 'old' | 'new') => void;
    readonly finishSelection: () => void;
    readonly selectText: (selection: LineSelection) => void;
    readonly clearSelection: () => void;
}

export interface DiffViewStoreOptions {
    /** Diff files: supply `generated`, the host mark, and the changed line count. */
    readonly files: readonly FileDiff[];
    /** Initial server progress. Without it, only defaults apply. */
    readonly progress?: readonly UiFileProgress[];
    /** Initial diff mode from global settings (`~/.sherpa/settings.json`). */
    readonly diffMode?: DiffMode;
    /** Reviewer mode change: the view handles persistence, the store makes no network calls. */
    readonly onDiffModeChange?: (mode: DiffMode) => void;
    /** Explicit manual collapse choices already read from per-PR storage. */
    readonly collapsed?: ReadonlyMap<string, boolean>;
}

type FileCollapseSnapshot = Pick<
    DiffViewSnapshot,
    'readState' | 'collapseExpanded' | 'collapseExpandedViewed' | 'collapseCollapsed'
>;

/** Final collapse reason from docs/design/SPEC-elements.md §2.9. Collapse for >2000 lines is calculated separately. */
export function fileCollapseReason(snapshot: FileCollapseSnapshot, file: FileDiff): FileCollapseReason | null {
    const read = snapshot.readState.get(file.fileId) ?? readStateOf({ file, record: null });
    // The generated default works like the low tier, not a viewed mark. An explicit expansion must survive un-pin.
    if (read.state === 'read' && !read.generatedDefault) {
        return snapshot.collapseExpandedViewed.has(file.fileId) ? null : 'viewed';
    }
    if (snapshot.collapseCollapsed.has(file.fileId)) {
        return 'manual';
    }
    if (file.generated && !snapshot.collapseExpanded.has(file.fileId)) {
        return 'generated';
    }
    return null;
}

/**
 * Collapse layers derived from explicit choices: true means manual collapse, false means
 * manual expansion. Both sides of the store maintain this invariant, so choices can be replaced in full.
 */
function collapseSetsOf(preferences: ReadonlyMap<string, boolean>): {
    readonly collapseExpanded: Set<string>;
    readonly collapseCollapsed: Set<string>;
} {
    const collapseExpanded = new Set<string>();
    const collapseCollapsed = new Set<string>();
    for (const [fileId, collapsed] of preferences) {
        (collapsed ? collapseCollapsed : collapseExpanded).add(fileId);
    }
    return { collapseExpanded, collapseCollapsed };
}

function sameCollapsePreferences(next: ReadonlyMap<string, boolean>, current: ReadonlyMap<string, boolean>): boolean {
    return next.size === current.size && [...next].every(([fileId, collapsed]) => current.get(fileId) === collapsed);
}

export function createDiffViewStore(options: DiffViewStoreOptions): DiffViewStore {
    const listeners = new Set<() => void>();
    const diffMode = options.diffMode ?? 'unified';
    const filesById = new Map(options.files.map((file) => [file.fileId, file]));

    /**
     * Read-state of one file. The model's changed lines are needed only when ranges exist:
     * without ranges there is no coverage to calculate, so there is no reason to parse the model for it.
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
    const collapsePreferences = new Map(options.collapsed ?? []);
    const { collapseExpanded, collapseCollapsed } = collapseSetsOf(collapsePreferences);
    let snapshot: DiffViewSnapshot = {
        diffMode,
        splitAvailable: true,
        effectiveMode: diffMode,
        models: new Map(),
        content: new Map(),
        expansion: new Map(),
        progress: initialProgress,
        readState: recomputeAll(initialProgress, new Map()),
        collapseExpanded,
        collapseExpandedViewed: new Set(),
        collapseCollapsed,
        collapsePreferences,
        opened: new Set(),
        whitespaceShown: new Set(),
        selection: null,
        selectionDragging: false,
    };

    const update = (patch: Partial<DiffViewSnapshot>): void => {
        const next = { ...snapshot, ...patch };
        snapshot = { ...next, effectiveMode: next.splitAvailable ? next.diffMode : 'unified' };
        for (const listener of [...listeners]) {
            listener();
        }
    };

    const revealFile = (fileId: string): void => {
        const file = filesById.get(fileId);
        if (file === undefined) {
            return;
        }
        const reason = fileCollapseReason(snapshot, file);
        if (reason === null) {
            return;
        }
        if (reason === 'viewed') {
            update({ collapseExpandedViewed: new Set(snapshot.collapseExpandedViewed).add(fileId) });
            return;
        }

        const collapsed = new Set(snapshot.collapseCollapsed);
        collapsed.delete(fileId);
        update({
            collapseExpanded: new Set(snapshot.collapseExpanded).add(fileId),
            collapseCollapsed: collapsed,
            collapsePreferences: new Map(snapshot.collapsePreferences).set(fileId, false),
        });
    };

    const extendSelection = (fileId: string, key: LineKey, side?: 'old' | 'new'): void => {
        const current = snapshot.selection;
        const sameFile = current !== null && current.fileId === fileId;
        const anchor = sameFile ? current.anchor : key;
        const selectedSide = sameFile ? current.side : side;
        if (sameFile && current.focus === key) {
            return;
        }
        update({
            selection: {
                fileId,
                ...(selectedSide === undefined ? {} : { side: selectedSide }),
                anchor,
                focus: key,
            },
        });
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
            update({ diffMode: mode });
            options.onDiffModeChange?.(mode);
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

        expandGap: (fileId, gapKey, direction, amount) => {
            const current = snapshot.expansion.get(fileId) ?? new Map();
            const next = expandGap(current, gapKey, direction, amount);
            update({ expansion: new Map(snapshot.expansion).set(fileId, next) });
        },

        expandFile: (fileId, visibleGapKeys = []) => {
            const model = snapshot.models.get(fileId);
            if (model === undefined) {
                return;
            }
            const current = snapshot.expansion.get(fileId) ?? new Map();
            const next = expandAllGaps(model, current, visibleGapKeys);
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
            if (viewed) {
                update({ progress, readState: recomputeOne(fileId, progress) });
                return;
            }
            // Temporary expansion of a viewed file lasts only while the mark is set.
            const expandedViewed = new Set(snapshot.collapseExpandedViewed);
            expandedViewed.delete(fileId);
            update({
                progress,
                readState: recomputeOne(fileId, progress),
                collapseExpandedViewed: expandedViewed,
            });
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

        toggleFileCollapse: (fileId) => {
            const file = filesById.get(fileId);
            if (file === undefined) {
                return;
            }
            if (fileCollapseReason(snapshot, file) !== null) {
                revealFile(fileId);
                return;
            }

            const read = snapshot.readState.get(fileId) ?? readStateOf({ file, record: null });
            if (read.state === 'read' && !read.generatedDefault) {
                const expandedViewed = new Set(snapshot.collapseExpandedViewed);
                if (expandedViewed.delete(fileId)) {
                    update({ collapseExpandedViewed: expandedViewed });
                }
                return;
            }

            if (file.generated && snapshot.collapseExpanded.has(fileId)) {
                const expanded = new Set(snapshot.collapseExpanded);
                const preferences = new Map(snapshot.collapsePreferences);
                expanded.delete(fileId);
                preferences.delete(fileId);
                update({ collapseExpanded: expanded, collapsePreferences: preferences });
                return;
            }

            const expanded = new Set(snapshot.collapseExpanded);
            expanded.delete(fileId);
            update({
                collapseExpanded: expanded,
                collapseCollapsed: new Set(snapshot.collapseCollapsed).add(fileId),
                collapsePreferences: new Map(snapshot.collapsePreferences).set(fileId, true),
            });
        },

        setCollapsePreferences: (collapsed) => {
            if (sameCollapsePreferences(collapsed, snapshot.collapsePreferences)) {
                return;
            }
            const preferences = new Map(collapsed);
            update({ collapsePreferences: preferences, ...collapseSetsOf(preferences) });
        },

        revealFile,

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

        beginSelection: () => {
            if (!snapshot.selectionDragging) {
                update({ selectionDragging: true });
            }
        },

        startSelection: (fileId, key, side) => {
            update({ selection: { fileId, ...(side === undefined ? {} : { side }), anchor: key, focus: key } });
        },

        extendSelection,

        dragSelection: (fileId, key, side) => {
            if (snapshot.selectionDragging) {
                extendSelection(fileId, key, side);
            }
        },

        finishSelection: () => {
            if (snapshot.selectionDragging) {
                update({ selectionDragging: false });
            }
        },

        selectText: (selection) => { update({ selection, selectionDragging: false }); },

        clearSelection: () => {
            if (snapshot.selection !== null || snapshot.selectionDragging) {
                update({ selection: null, selectionDragging: false });
            }
        },
    };
}
