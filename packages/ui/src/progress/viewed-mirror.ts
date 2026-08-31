import type { UiFileProgress, UiViewedMirrorRequest } from '@sherpa/protocol';

import type { FileReadState } from './read-state.js';

export interface ViewedMirrorSource {
    readonly readStates: ReadonlyMap<string, FileReadState>;
    readonly progress: ReadonlyMap<string, UiFileProgress>;
    /** reviewFileViewed already mirrors explicit file clears. Keep old ranges hidden until refresh. */
    readonly fileWrites: ReadonlySet<string>;
}

export interface ViewedMirrorUpdate {
    readonly state: ReadonlyMap<string, boolean>;
    readonly entries: UiViewedMirrorRequest['entries'];
}

/**
 * Mirror delta from the last sent state. The first calculation becomes the baseline
 * without sending it. Files removed from the current diff are not marked again on the host.
 */
export function viewedMirrorUpdate(
    previous: ReadonlyMap<string, boolean> | null,
    source: ViewedMirrorSource,
): ViewedMirrorUpdate {
    const state = new Map<string, boolean>();
    const entries: { fileId: string; viewed: boolean }[] = [];

    for (const [fileId, read] of source.readStates) {
        const record = source.progress.get(fileId);
        const fromCoverage = record !== undefined && !record.viewed && record.seenRanges.length > 0;
        const fileWrite = source.fileWrites.has(fileId);
        const mirroredByFileWrite = record?.viewed === true || fileWrite;
        const viewed = fileWrite
            ? false
            : fromCoverage && read.state === 'read' && !read.pinned && !read.generatedDefault;
        state.set(fileId, viewed);
        if (
            previous !== null &&
            (previous.get(fileId) ?? false) !== viewed &&
            !(mirroredByFileWrite && !viewed)
        ) {
            entries.push({ fileId, viewed });
        }
    }

    return { state, entries };
}
