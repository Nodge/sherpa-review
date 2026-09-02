import { fileContentOf, fixtureIteration } from '@sherpa/fixtures';
import type { FileDiff, Thread } from '@sherpa/protocol';
import { useMemo } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { ReadOnlyIterationProvider } from '../../iterations/read-only.tsx';
import { ThreadPinProvider } from '../../iterations/thread-pin.tsx';
import type { IterationLayout } from '../../threads/model.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { DiffWorkspace } from '../../views/full-diff.tsx';
import type { RouteGalleryState } from './m2-t6-states.tsx';

/**
 * Threads pinned to a previous commit (M4-T10): a "pinned to 9f3c1ab" chip, a
 * "View at the old commit" action and an "on files no longer in this PR" group (SPEC §2.17).
 * Both states use the `medium` fixture: v2 is active, v1 is its previous iteration.
 */

const V1 = fixtureIteration('medium', 0);
const V2 = fixtureIteration('medium', 1);
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');

/** A thread whose anchor the push affected. It is outdated in v2 and beside its own lines in v1. */
const OUTDATED_THREAD_ID = threadIdBy((thread) => thread.outdated && thread.anchor !== null);

function threadIdBy(match: (thread: Thread) => boolean): string {
    const found = V2.threads.find(match);
    if (found === undefined) {
        throw new Error('the medium fixture needs a thread outdated after the second push');
    }
    return found.id;
}

function fileIdsOf(files: readonly FileDiff[]): Set<string> {
    return new Set(files.map((file) => file.fileId));
}

interface PinnedStateProps {
    /** The iteration whose diff is rendered. Threads always come from the active iteration (v2). */
    readonly diff: typeof V1.diff;
    readonly readOnly?: boolean;
    readonly outsideOpen?: boolean;
}

function PinnedState({ diff, readOnly = false, outsideOpen = false }: PinnedStateProps) {
    // Bots are visible: the fixture thread on a file no longer in the PR comes from the review bot.
    const session = useMemo(
        () =>
            createSessionStore({
                initial: { view: 'diff', filter: 'all', threadsShow: { people: true, bots: true, resolved: true } },
            }),
        [],
    );
    const layout = useMemo<IterationLayout | null>(
        () =>
            diff.diffId === V2.diff.diffId
                ? null
                : { diffId: diff.diffId, fileIdByPath: new Map(diff.files.map((file) => [file.path, file.fileId])) },
        [diff],
    );
    const threadStore = useMemo(
        () => createThreadStore(V2.threads, fileIdsOf(diff.files), layout),
        [diff, layout],
    );
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: diff.files });
        for (const file of diff.files) {
            created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
        return created;
    }, [diff]);

    return (
        <ReadOnlyIterationProvider readOnly={readOnly}>
            <ThreadPinProvider
                value={{
                    activeDiffId: V2.diff.diffId,
                    viewingDiffId: diff.diffId,
                    openAtPin: () => undefined,
                }}
            >
                <div className="gallery__viewport">
                    <DiffWorkspace
                        pr={V2.pr}
                        diff={diff}
                        threads={V2.threads}
                        threadStore={threadStore}
                        lenses={{ ownership: V2.ownership, extra: V2.extraLenses }}
                        prKey="fixture-medium"
                        session={session}
                        store={store}
                        threadNow={GALLERY_NOW}
                        initialThreadId={OUTDATED_THREAD_ID}
                        outsideThreadsOpen={outsideOpen}
                        parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                        loadContent={(fileId) => {
                            const file = diff.files.find((candidate) => candidate.fileId === fileId);
                            return Promise.resolve(file === undefined ? null : fileContentOf(file));
                        }}
                        onSetViewed={() => Promise.resolve(0)}
                    />
                </div>
            </ThreadPinProvider>
        </ReadOnlyIterationProvider>
    );
}

export const M4_T10_STATES: readonly RouteGalleryState[] = [
    {
        id: 'iterations-thread-pinned',
        title: 'active iteration: pin chip, Show on old commit, files no longer in the PR',
        render: () => <PinnedState diff={V2.diff} outsideOpen />,
    },
    {
        id: 'iterations-thread-pinned-old',
        title: 'previous iteration in read-only mode: the thread is beside its own lines',
        render: () => <PinnedState diff={V1.diff} readOnly />,
    },
];
