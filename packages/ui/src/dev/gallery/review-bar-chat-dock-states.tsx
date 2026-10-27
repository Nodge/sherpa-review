import { chatFixtures, fixtureIteration } from '@sherpa/fixtures';
import type { AgentNote, ChatExchange, Thread, WorkerStatus } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { ChatPanel } from '../../components/chat-panel.tsx';
import { useChatDock } from '../../components/dock.js';
import { ReviewActionBar } from '../../components/review-action-bar.tsx';
import { createDiffViewStore } from '../../diff-view/store.js';
import { createThreadStore } from '../../threads/store.js';

/**
 * Floating action bar next to chat. Two states for different viewports:
 * docked chat (capture at 1440 and 1280) and overlay chat with a scrim (capture at 1024).
 * The same hook as in the app (`useChatDock`) sets the docking class on the root, so
 * `--dock-*` and layers follow exactly the same rules here.
 */

const DATA = fixtureIteration('medium');
const CHAT = chatFixtures('medium');
const EXCHANGES: readonly ChatExchange[] = CHAT?.exchanges ?? [];
const NOTES: readonly AgentNote[] = CHAT?.notes ?? [];
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');
const WORKER: WorkerStatus = {
    kind: 'connected',
    workerId: 'gallery-worker',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-08-24T09:00:00.000Z',
    lastSeenAt: '2026-08-24T11:59:00.000Z',
};
const TRANSPORT = {
    save: () => Promise.reject(new Error('gallery does not write to the host')),
    update: () => Promise.reject(new Error('gallery does not write to the host')),
    delete: () => Promise.reject(new Error('gallery does not write to the host')),
};

export interface ReviewBarChatDockGalleryState {
    readonly id: string;
    readonly group: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const REVIEW_BAR_CHAT_DOCK_STATES: readonly ReviewBarChatDockGalleryState[] = [
    {
        id: 'review-bar-chat-docked',
        group: 'Finish review',
        title: 'bar and docked chat (≥1280)',
        render: () => <DockState overlay={false} />,
    },
    {
        id: 'review-bar-chat-overlay',
        group: 'Finish review',
        title: 'bar under the overlay chat scrim (<1280)',
        render: () => <DockState overlay />,
    },
    {
        id: 'review-bar-issue-drafts',
        group: 'Finish review',
        title: 'draft counter with a "· 2 issues" suffix, ship menu open',
        render: () => <IssueDraftsState />,
    },
];

/** The "· N issues" suffix on the draft counter (SPEC-changes-2026-09-20 §1). */
function IssueDraftsState() {
    const diffStore = useMemo(() => createDiffViewStore({ files: DATA.diff.files }), []);
    const threadStore = useMemo(
        () => createThreadStore(withIssueDrafts(DATA.threads), new Set(DATA.diff.files.map((file) => file.fileId))),
        [],
    );

    return (
        <ReviewActionBar
            pr={DATA.pr}
            diff={DATA.diff}
            diffStore={diffStore}
            threadStore={threadStore}
            connection="online"
            hostName="FixtureHost"
            draftDestination="pr"
            composerTransport={TRANSPORT}
            onPublish={() => Promise.reject(new Error('gallery does not write to the host'))}
            onComplete={() => undefined}
            defaultMenuOpen
        />
    );
}

/**
 * The "bar + open chat" state. `overlay` draws the scrim for a narrow viewport. A media query
 * selects the mode by window width. The flag only adds what `app.tsx` draws in the app.
 */
function DockState({ overlay }: { overlay: boolean }) {
    useChatDock(true);

    const diffStore = useMemo(() => createDiffViewStore({ files: DATA.diff.files }), []);
    const threadStore = useMemo(
        () => createThreadStore(withDraft(DATA.threads), new Set(DATA.diff.files.map((file) => file.fileId))),
        [],
    );

    return (
        <>
            {overlay ? <div className="gallery-dock-scrim" /> : null}
            <div className={`gallery-dock-chat${overlay ? ' gallery-dock-chat--overlay' : ''}`}>
                <ChatPanel
                    worker={WORKER}
                    tasks={[]}
                    exchanges={EXCHANGES}
                    notes={NOTES}
                    loading={false}
                    error={null}
                    reconnectCommand="/sherpa fixture-medium"
                    anchor={null}
                    focusRequest={0}
                    scrollRequest={null}
                    viewDiffId={DATA.diff.diffId}
                    onScrollRequestHandled={() => undefined}
                    onClose={() => undefined}
                    onRemoveAnchor={() => undefined}
                    onAsk={() => Promise.reject(new Error('gallery questions are not sent'))}
                    onCancel={() => Promise.resolve()}
                    onRetry={() => Promise.resolve()}
                    onNavigate={() => undefined}
                    onNavigateToNote={() => undefined}
                    now={GALLERY_NOW}
                />
            </div>
            <ReviewActionBar
                pr={DATA.pr}
                diff={DATA.diff}
                diffStore={diffStore}
                threadStore={threadStore}
                connection="online"
                hostName="FixtureHost"
                draftDestination="pr"
                composerTransport={TRANSPORT}
                onPublish={() => Promise.reject(new Error('the gallery does not write to the host'))}
                onComplete={() => undefined}
                chatOpen
            />
        </>
    );
}

/** Two drafts with the issue flag: the counter gets a suffix, and the other threads stay as in the fixture. */
function withIssueDrafts(threads: readonly Thread[]): Thread[] {
    const [first, second, ...rest] = threads;
    if (first === undefined || second === undefined) {
        throw new Error('the counter state needs two threads');
    }
    return [
        { ...first, root: { ...first.root, draft: true, issue: true } },
        { ...second, root: { ...second.root, draft: true, issue: true } },
        ...rest,
    ];
}

/** Draft in the thread set: the panel shows a counter instead of "no unpublished comments". */
function withDraft(threads: readonly Thread[]): Thread[] {
    const first = threads[0];
    if (first === undefined) {
        throw new Error('the panel state needs at least one thread');
    }
    return [{ ...first, root: { ...first.root, draft: true } }, ...threads.slice(1)];
}
