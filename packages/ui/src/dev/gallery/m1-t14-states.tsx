import { fixtureData } from '@sherpa/fixtures';
import type { PrMeta, Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import type { PublicationFailure } from '../../components/review-action-model.js';
import { ReviewActionBar } from '../../components/review-action-bar.tsx';
import type { ReviewCompletion } from '../../components/review-action-bar.tsx';
import { ReviewComplete } from '../../components/review-complete.tsx';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createThreadStore } from '../../threads/store.js';

const DATA = fixtureData('medium');
const DRAFT_THREADS = withDraft(DATA.threads);
const COMPLETION: ReviewCompletion = {
    verdict: 'ship',
    prId: DATA.pr.id,
    headCommit: DATA.diff.headCommit,
    hostName: 'FixtureHost',
    publishedComments: 2,
    publishedReplies: 1,
    progress: {
        filesSeen: 16,
        filesTotal: 18,
        linesSeen: 780,
        linesTotal: 862,
        percentSeen: 90,
    },
    openThreads: 0,
    firstOpenThreadId: null,
};
const FAILURE: PublicationFailure = {
    verdict: 'request_changes',
    failedCount: 2,
    message: null,
    comments: [
        { commentId: '-70001', body: 'This boundary remains unchecked.', message: 'fixture publish failed' },
        { commentId: '-70002', body: 'A test for repeated writes is needed.', message: 'fixture publish failed' },
    ],
};
const TRANSPORT = {
    save: () => Promise.reject(new Error('gallery does not write to the host')),
    update: () => Promise.reject(new Error('gallery does not write to the host')),
    delete: () => Promise.reject(new Error('gallery does not write to the host')),
};

export interface M1T14GalleryState {
    readonly id: string;
    readonly group: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const M1_T14_STATES: readonly M1T14GalleryState[] = [
    {
        id: 'review-bar-drafts',
        group: 'Finish review',
        title: 'bar with drafts',
        render: () => <BarState threads={DRAFT_THREADS} />,
    },
    {
        id: 'review-bar-no-drafts',
        group: 'Finish review',
        title: 'bar without drafts',
        render: () => <BarState threads={[]} />,
    },
    {
        id: 'review-ship-menu',
        group: 'Finish review',
        title: 'ship menu with a guard',
        render: () => <BarState threads={DRAFT_THREADS} menuOpen />,
    },
    {
        id: 'review-sticky-unavailable',
        group: 'Finish review',
        title: 'Sticky ship unavailable',
        render: () => <BarState threads={DRAFT_THREADS} menuOpen stickyAvailable={false} />,
    },
    {
        id: 'review-publish-error',
        group: 'Finish review',
        title: 'partial publication failure',
        render: () => <BarState threads={DRAFT_THREADS} failure={FAILURE} />,
    },
    {
        id: 'review-complete',
        group: 'Finish review',
        title: 'Review complete',
        render: () => <CompleteState completion={COMPLETION} />,
    },
    {
        id: 'review-complete-open-thread',
        group: 'Finish review',
        title: 'Review complete with an open thread',
        render: () => (
            <CompleteState
                completion={{
                    ...COMPLETION,
                    verdict: 'sticky_ship',
                    openThreads: 3,
                    firstOpenThreadId: 'thread-open',
                }}
            />
        ),
    },
];

function withDraft(threads: readonly Thread[]): Thread[] {
    const first = threads[0];
    if (first === undefined) {
        throw new Error('the panel state needs at least one thread');
    }
    return [{ ...first, root: { ...first.root, draft: true } }, ...threads.slice(1)];
}

function BarState({
    threads,
    menuOpen = false,
    failure = null,
    stickyAvailable = true,
}: {
    threads: readonly Thread[];
    menuOpen?: boolean;
    failure?: PublicationFailure | null;
    stickyAvailable?: boolean;
}) {
    const diffStore = useMemo(() => createDiffViewStore({ files: DATA.diff.files, storage: null }), []);
    const threadStore = useMemo(
        () => createThreadStore(threads, new Set(DATA.diff.files.map((file) => file.fileId))),
        [threads],
    );
    const pr = useMemo<PrMeta>(
        () => ({ ...DATA.pr, capabilities: { ...DATA.pr.capabilities, stickyShip: stickyAvailable } }),
        [stickyAvailable],
    );
    return (
        <div className="gallery__viewport gallery-review-actions">
            <ReviewActionBar
                pr={pr}
                diff={DATA.diff}
                diffStore={diffStore}
                threadStore={threadStore}
                connection="online"
                hostName="FixtureHost"
                composerTransport={TRANSPORT}
                onPublish={() => Promise.reject(new Error('the gallery does not write to the host'))}
                onComplete={() => undefined}
                defaultMenuOpen={menuOpen}
                initialFailure={failure}
                storage={null}
            />
        </div>
    );
}

function CompleteState({ completion }: { completion: ReviewCompletion }) {
    return (
        <div className="gallery__viewport gallery-review-complete">
            <ReviewComplete completion={completion} onOpenThread={() => undefined} onOpenFullDiff={() => undefined} />
        </div>
    );
}
