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
 * M5-T22: floating action bar next to chat. Two frames for different viewports:
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

export interface M5T22GalleryState {
    readonly id: string;
    readonly group: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const M5_T22_STATES: readonly M5T22GalleryState[] = [
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
];

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
                    prKey="fixture-medium"
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
                composerTransport={TRANSPORT}
                onPublish={() => Promise.reject(new Error('the gallery does not write to the host'))}
                onComplete={() => undefined}
                chatOpen
            />
        </>
    );
}

/** Draft in the thread set: the panel shows a counter instead of "no unpublished comments". */
function withDraft(threads: readonly Thread[]): Thread[] {
    const first = threads[0];
    if (first === undefined) {
        throw new Error('the panel state needs at least one thread');
    }
    return [{ ...first, root: { ...first.root, draft: true } }, ...threads.slice(1)];
}
