import type { UiFileProgress } from '@sherpa/protocol';

import type { FileReadState } from '../progress/read-state.js';
import { rangesCover } from '../progress/read-state.js';
import type { RouteEntry, RouteFileGroup } from './route-model.js';
import { uncoveredAsGroup } from './route-model.js';

export interface StopCoverageSnapshot {
    readonly progress: ReadonlyMap<string, UiFileProgress>;
    readonly readState: ReadonlyMap<string, FileReadState>;
}

/** Whether viewed ranges cover every range of a route entry. An empty entry does not mark itself. */
export function stopCoveredByProgress(entry: RouteEntry, snapshot: StopCoverageSnapshot): boolean {
    const groups: readonly RouteFileGroup[] =
        entry.kind === 'stop' ? entry.view.files : entry.view.files.map((file) => uncoveredAsGroup(file));
    if (groups.length === 0) {
        return false;
    }

    return groups.every((group) => {
        const readState = snapshot.readState.get(group.fileId);
        if (readState?.state === 'read' && readState.pinned && !readState.generatedDefault) {
            return true;
        }
        if (group.seenRanges.length === 0) {
            return false;
        }
        return rangesCover(snapshot.progress.get(group.fileId)?.seenRanges ?? [], group.seenRanges);
    });
}
