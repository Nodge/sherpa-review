import type { RefObject } from 'react';
import { useMemo, useRef, useState } from 'react';

import { setFileViewed, setStopFileViewed, setStopViewed } from '../api.js';
import type { DiffViewStore } from '../diff-view/store.js';
import type { ProgressWriter } from '../progress/progress-writer.js';
import { createProgressWriter } from '../progress/progress-writer.js';
import type { StopProgressStore } from '../progress/stop-progress-store.js';
import { createStopProgressStore } from '../progress/stop-progress-store.js';

export interface UseProgressWriterOptions {
    readonly viewKey: string;
    readonly diffStore: DiffViewStore | null;
    readonly routeSnapshotId: string | null;
    readonly token: string;
    readonly readOnly: boolean;
}

export interface UseProgressWriterResult {
    readonly progressWriter: ProgressWriter | null;
    readonly stopProgress: StopProgressStore;
    /** Files whose viewed mark was cleared by hand. The mirror does not replay them to the host. */
    readonly mirroredFileWrites: RefObject<Set<string>>;
    /** Completed write counter used to refresh progress. */
    readonly progressWritesSettled: number;
}

/** One progress writer per tab for file marks and stop marks. */
export function useProgressWriter({
    viewKey,
    diffStore,
    routeSnapshotId,
    token,
    readOnly,
}: UseProgressWriterOptions): UseProgressWriterResult {
    const [progressWritesSettled, setProgressWritesSettled] = useState(0);
    // Stop marks live alongside file marks. They share a progress revision and one writer.
    // Changing the PR, host or selected iteration means a different route, so the old marks do not apply.
    const [stopProgressState, setStopProgressState] = useState(() => ({
        key: viewKey,
        store: createStopProgressStore(),
    }));
    if (stopProgressState.key !== viewKey) {
        setStopProgressState({ key: viewKey, store: createStopProgressStore() });
    }
    const stopProgress = stopProgressState.store;
    const mirroredFileWrites = useRef(new Set<string>());
    const writingProgress = useMemo<ProgressWriter | null>(
        () =>
            diffStore === null
                ? null
                : createProgressWriter({
                      initialRevision: 0,
                      read: (fileId) => diffStore.getSnapshot().progress.get(fileId) ?? null,
                      apply: (fileId, viewed) => {
                          if (viewed) {
                              mirroredFileWrites.current.delete(fileId);
                          } else {
                              mirroredFileWrites.current.add(fileId);
                          }
                          // markViewed synchronously notifies the mirror subscriber. Change the flag before writing to the store.
                          diffStore.markViewed(fileId, viewed);
                      },
                      restore: diffStore.restoreProgress,
                      send: async (fileId, viewed) => {
                          try {
                              return (await setFileViewed(token, fileId, viewed)).progressRevision;
                          } catch (error) {
                              if (!viewed) {
                                  mirroredFileWrites.current.delete(fileId);
                              }
                              throw error;
                          }
                      },
                      stops: {
                          read: (stopId) => stopProgress.getSnapshot().get(stopId) ?? null,
                          apply: stopProgress.setViewed,
                          restore: stopProgress.restore,
                          send: async (stopId, viewed, ranges) => {
                              if (routeSnapshotId === null) {
                                  throw new Error('Sherpa UI: cannot mark a stop without a route snapshot');
                              }
                              return (await setStopViewed(token, routeSnapshotId, stopId, viewed, ranges))
                                  .progressRevision;
                          },
                      },
                      stopFiles: {
                          apply: diffStore.applySeenRanges,
                          send: async (stopId, fileId, viewed, ranges) => {
                              if (routeSnapshotId === null) {
                                  throw new Error('Sherpa UI: cannot mark a stop file without a route snapshot');
                              }
                              return (await setStopFileViewed(token, routeSnapshotId, stopId, fileId, viewed, ranges))
                                  .progressRevision;
                          },
                      },
                      onSettled: () => {
                          setProgressWritesSettled((settled) => settled + 1);
                      },
                  }),
        [diffStore, routeSnapshotId, stopProgress, token],
    );
    /**
     * For a previous iteration, the progress writer only refreshes the snapshot. It rejects writes
     * before applying an optimistic mark, so the control does not flicker and roll back.
     * The controls themselves are disabled. Only internal paths can reach this point.
     */
    const progressWriter = useMemo<ProgressWriter | null>(
        () =>
            writingProgress === null || !readOnly
                ? writingProgress
                : {
                      ...writingProgress,
                      write: () => Promise.resolve(false),
                      writeStop: () => Promise.resolve(false),
                      writeStopFile: () => Promise.resolve(false),
                  },
        [readOnly, writingProgress],
    );

    return { progressWriter, stopProgress, mirroredFileWrites, progressWritesSettled };
}
