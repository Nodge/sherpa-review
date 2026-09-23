import type { UiFileProgress } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';
import type { FileReadState } from '../progress/read-state.js';
import { rangesCoverage, readStateOf } from '../progress/read-state.js';
import type { RouteEntry, RouteFileGroup } from './route-model.js';
import { entryGroups } from './route-model.js';

export interface StopCoverageSnapshot {
    readonly progress: ReadonlyMap<string, UiFileProgress>;
    readonly readState: ReadonlyMap<string, FileReadState>;
}

/**
 * Coverage of a file card's lines in a route entry by its seen ranges is the only rule
 * for "the card's lines are read". Group ranges contain only changed lines (`coveredChangedRanges`),
 * so their length is the card's changed-line count. An empty group is never covered.
 */
export function groupCoverage(group: RouteFileGroup, record: UiFileProgress | null): FileReadState {
    return rangesCoverage(group.seenRanges, record?.seenRanges ?? []);
}

/**
 * Read-state of a file card in a route entry (docs/design/SPEC-elements.md §2.10). A file pin
 * (manual mark, host, generated default) keeps `read` in any card. Otherwise, count
 * coverage of the card's own lines instead of the entire file.
 */
export function groupReadState(
    group: RouteFileGroup,
    fileRead: FileReadState,
    record: UiFileProgress | null,
): FileReadState {
    return fileRead.state === 'read' && fileRead.pinned ? fileRead : groupCoverage(group, record);
}

/** `groupReadState` from a diff store snapshot. */
export function cardReadState(group: RouteFileGroup, snapshot: StopCoverageSnapshot): FileReadState {
    const record = snapshot.progress.get(group.fileId) ?? null;
    const fileRead = snapshot.readState.get(group.fileId) ?? readStateOf({ file: group.file, record });
    return groupReadState(group, fileRead, record);
}

/**
 * Whether all cards in a route entry are covered by viewed marks. The generated default does not complete a stop.
 * It is a default, not a reading action.
 */
export function stopCoveredByProgress(entry: RouteEntry, snapshot: StopCoverageSnapshot): boolean {
    // A conflict-only entry (docs/design/SPEC-elements.md §4.1) has no readable ranges.
    // The guardrail cannot require reading what is outside coverage.
    if (conflictsOnlyEntry(entry)) {
        return true;
    }
    const groups = entryGroups(entry);
    if (groups.length === 0) {
        return false;
    }

    return groups.every((group) => {
        const read = cardReadState(group, snapshot);
        if (read.generatedDefault) {
            return groupCoverage(group, snapshot.progress.get(group.fileId) ?? null).state === 'read';
        }
        return read.state === 'read';
    });
}

/**
 * How a file card in a route entry is marked, with its own lines or, for a non-text file,
 * with a whole-file pin (it has no lines and the card shows it in full). An unparsed file
 * has nothing to mark until a model exists, so its toggle is disabled, as with a stop containing such a file.
 */
export type CardViewedMark = 'ranges' | 'pin' | 'pending' | 'parseFailed';

export function cardViewedMark(
    group: RouteFileGroup,
    model: DiffFileModel | null,
    parseFailed: boolean,
): CardViewedMark {
    if (model === null) {
        return parseFailed ? 'parseFailed' : 'pending';
    }
    return group.seenRanges.length === 0 ? 'pin' : 'ranges';
}

/** All files in the entry have conflicts. There are no cards and nothing to read. */
function conflictsOnlyEntry(entry: RouteEntry): boolean {
    return entry.kind === 'stop'
        ? entry.view.files.length === 0 && entry.view.conflictPaths.length > 0
        : entry.view.files.length === 0 && entry.view.conflictFiles > 0;
}
