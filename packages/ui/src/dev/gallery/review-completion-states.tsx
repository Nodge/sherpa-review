import { fixtureIteration, GALLERY_HOSTS } from '@sherpa/fixtures';
import type { PrMeta, Thread, UiReviewHost, UiSettings, Verdict } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { hostDisplayName } from '../../app/review-state.js';
import type { PublicationFailure } from '../../components/review-action-model.js';
import { ReviewActionBar } from '../../components/review-action-bar.tsx';
import type { ReviewCompletion } from '../../components/review-action-bar.tsx';
import { ReviewComplete } from '../../components/review-complete.tsx';
import { createDiffViewStore } from '../../diff-view/store.js';
import { useT } from '../../i18n/index.js';
import { SettingsProvider } from '../../settings/context.tsx';
import { createUiSettingsStore } from '../../settings/settings-store.js';
import { createThreadStore } from '../../threads/store.js';

const DATA = fixtureIteration('medium');
const DRAFT_THREADS = withDraft(DATA.threads);
const COMPLETION: ReviewCompletion = {
    verdict: 'ship',
    prId: DATA.pr.id,
    headCommit: DATA.diff.headCommit,
    hostName: 'FixtureHost',
    draftDestination: GALLERY_HOSTS.fixture.drafts,
    publishedComments: 2,
    publishedReplies: 1,
    route: null,
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
/** Your own PR on GitHub and local review: no verdicts, only Comment. */
const COMMENT_ONLY: readonly Verdict[] = ['comment'];
/** Local review with `sherpa-review up --local --verdicts`: Request changes and Ship, without Comment. */
const LOCAL_VERDICTS: readonly Verdict[] = ['request_changes', 'ship'];
const TRANSPORT = {
    save: () => Promise.reject(new Error('gallery does not write to the host')),
    update: () => Promise.reject(new Error('gallery does not write to the host')),
    delete: () => Promise.reject(new Error('gallery does not write to the host')),
};

export interface ReviewCompletionGalleryState {
    readonly id: string;
    readonly group: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const REVIEW_COMPLETION_STATES: readonly ReviewCompletionGalleryState[] = [
    {
        id: 'review-bar-drafts',
        group: 'Finish review',
        title: 'bar with drafts: all modes, Ship active',
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
        title: 'ship menu with a guard: Ship, Sticky ship, Comment',
        render: () => <BarState threads={DRAFT_THREADS} menuOpen />,
    },
    {
        id: 'review-bar-comment-mode',
        group: 'Finish review',
        title: 'Comment active, other modes in the menu',
        render: () => <BarState threads={DRAFT_THREADS} shipMode="comment" />,
    },
    {
        id: 'review-sticky-unavailable',
        group: 'Finish review',
        title: 'Sticky ship unavailable',
        render: () => (
            <BarState threads={DRAFT_THREADS} menuOpen verdicts={['comment', 'ship', 'request_changes']} />
        ),
    },
    {
        id: 'review-bar-comment-only',
        group: 'Finish review',
        title: 'Comment only: your own GitHub PR, button without a caret',
        render: () => <BarState threads={DRAFT_THREADS} verdicts={COMMENT_ONLY} />,
    },
    {
        id: 'review-bar-comment-only-empty',
        group: 'Finish review',
        title: 'Comment only, no drafts',
        render: () => <BarState threads={[]} verdicts={COMMENT_ONLY} />,
    },
    {
        id: 'review-bar-local',
        group: 'Finish review',
        title: 'local review: drafts go to the agent',
        render: () => <BarState threads={DRAFT_THREADS} verdicts={COMMENT_ONLY} reviewHost={GALLERY_HOSTS.local} />,
    },
    {
        id: 'review-bar-local-verdicts',
        group: 'Finish review',
        title: 'local review with verdicts: Request changes and Ship without a caret',
        render: () => <BarState threads={DRAFT_THREADS} verdicts={LOCAL_VERDICTS} reviewHost={GALLERY_HOSTS.local} />,
    },
    {
        id: 'review-bar-local-verdicts-empty',
        group: 'Finish review',
        title: 'local review with verdicts, no drafts: Ship available',
        render: () => <BarState threads={[]} verdicts={LOCAL_VERDICTS} reviewHost={GALLERY_HOSTS.local} />,
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
        id: 'review-complete-comment',
        group: 'Finish review',
        title: 'Review complete without a verdict',
        render: () => (
            <CompleteState
                completion={{ ...COMPLETION, verdict: 'comment', openThreads: 2, firstOpenThreadId: 'thread-open' }}
            />
        ),
    },
    {
        id: 'review-complete-local',
        group: 'Finish review',
        title: 'Review complete for local review',
        render: () => (
            <CompleteState
                completion={{ ...COMPLETION, draftDestination: GALLERY_HOSTS.local.drafts, hostName: 'local checkout' }}
            />
        ),
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

interface FixtureReviewActionBarProps {
    readonly threads: readonly Thread[];
    readonly menuOpen?: boolean;
    readonly failure?: PublicationFailure | null;
    readonly verdicts?: readonly Verdict[];
    readonly reviewHost?: UiReviewHost;
    /** Saved split-button mode. Falls back to page settings when absent. */
    readonly shipMode?: UiSettings['shipMode'];
}

/** The real action bar on the `medium` fixture, shown by completion cards and the tour. */
export function FixtureReviewActionBar({
    threads,
    menuOpen = false,
    failure = null,
    verdicts = DATA.pr.capabilities.publishVerdicts,
    reviewHost = GALLERY_HOSTS.fixture,
    shipMode,
}: FixtureReviewActionBarProps) {
    const t = useT();
    const diffStore = useMemo(() => createDiffViewStore({ files: DATA.diff.files }), []);
    const threadStore = useMemo(
        () => createThreadStore(threads, new Set(DATA.diff.files.map((file) => file.fileId))),
        [threads],
    );
    const pr = useMemo<PrMeta>(
        () => ({ ...DATA.pr, capabilities: { ...DATA.pr.capabilities, publishVerdicts: [...verdicts] } }),
        [verdicts],
    );
    const settings = useMemo(
        () => (shipMode === undefined ? null : createUiSettingsStore({ loaded: true, initial: { shipMode } })),
        [shipMode],
    );
    const bar = (
        <ReviewActionBar
            pr={pr}
            diff={DATA.diff}
            diffStore={diffStore}
            threadStore={threadStore}
            connection="online"
            hostName={hostDisplayName(reviewHost, t)}
            draftDestination={reviewHost.drafts}
            composerTransport={TRANSPORT}
            onPublish={() => Promise.reject(new Error('gallery does not write to the host'))}
            onComplete={() => undefined}
            defaultMenuOpen={menuOpen}
            initialFailure={failure}
        />
    );
    return settings === null ? bar : <SettingsProvider store={settings}>{bar}</SettingsProvider>;
}

function BarState(props: FixtureReviewActionBarProps) {
    return (
        <div className="gallery__viewport gallery-review-actions">
            <FixtureReviewActionBar {...props} />
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
