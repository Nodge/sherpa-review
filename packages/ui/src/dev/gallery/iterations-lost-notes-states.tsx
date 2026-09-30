import { chatFixtures, fileContentOf, fixtureIteration } from '@sherpa/fixtures';
import type { AgentNote, ChatExchange, WorkerStatus } from '@sherpa/protocol';
import { useMemo, useState } from 'react';

import { ChatPanel } from '../../components/chat-panel.tsx';
import type { ChatScrollTarget } from '../../components/chat-panel.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { notesForIteration } from '../../notes/model.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import { DiffWorkspace } from '../../views/full-diff.tsx';
import { NotesLostBanner } from '../../views/route/iteration-banners.tsx';
import type { RouteGalleryState } from './route-states.tsx';
import { asFetched } from './fetched.js';

/**
 * Notes after a push (docs/design/SPEC-elements.md §2.16): active iteration v2 with a "1 note lost its
 * anchor…" banner, an open chat panel with a chip on the lost note, and 4 moved notes beside the code.
 * Data comes from `chatFixtures('medium').notesAfterPush`, the same set the server tests.
 */

const V2 = asFetched(fixtureIteration('medium', 1));
const CHAT = chatFixtures('medium');
const NOTES: readonly AgentNote[] = CHAT?.notesAfterPush ?? [];
const EXCHANGES: readonly ChatExchange[] = CHAT?.exchanges ?? [];
const LOST = NOTES.find((note) => note.lostAnchor) ?? null;
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');
const WORKER: WorkerStatus = {
    kind: 'connected',
    workerId: 'gallery-worker',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-08-24T09:00:00.000Z',
    lastSeenAt: '2026-08-24T11:59:00.000Z',
};

/** The file whose notes moved with a line shift. The frame opens on this file. */
const SHIFTED_FILE =
    V2.diff.files.find((file) => file.path.endsWith('edit-policy.ts'))?.fileId ?? V2.diff.files[0]?.fileId ?? null;

function NotesLostState() {
    const session = useMemo(
        () => createSessionStore({ initial: { view: 'diff', filter: 'all' } }),
        [],
    );
    const threadStore = useMemo(
        () => createThreadStore(V2.threads, new Set(V2.diff.files.map((file) => file.fileId)), null),
        [],
    );
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: V2.diff.files });
        for (const file of V2.diff.files) {
            created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
        return created;
    }, []);
    const notesInCode = useMemo(() => notesForIteration(NOTES, V2.diff.diffId), []);
    // The panel opens on the note with a lost anchor. Its chip is the subject of this state.
    const [scrollRequest, setScrollRequest] = useState<{ id: number; target: ChatScrollTarget } | null>(() =>
        LOST === null ? null : { id: 1, target: { kind: 'exchange', exchangeId: LOST.exchangeId } },
    );

    return (
        <div className="gallery__viewport">
            <NotesLostBanner count={NOTES.filter((note) => note.lostAnchor).length} onShow={() => undefined} onDismiss={() => undefined} />
            <div className="gallery-notes-lost">
                <div className="gallery-notes-lost__diff">
                    <DiffWorkspace
                        pr={V2.pr}
                        diff={V2.diff}
                        threads={V2.threads}
                        threadStore={threadStore}
                        lenses={{ ownership: V2.ownership, extra: V2.extraLenses, ownershipSource: 'CODEOWNERS' }}
                        prKey="fixture-medium"
                        session={session}
                        store={store}
                        threadNow={GALLERY_NOW}
                        initialFileId={SHIFTED_FILE}
                        notes={notesInCode}
                        parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                        loadContent={(fileId) => {
                            const file = V2.diff.files.find((candidate) => candidate.fileId === fileId);
                            return Promise.resolve(file === undefined ? null : fileContentOf(file));
                        }}
                        onSetViewed={() => Promise.resolve(0)}
                    />
                </div>
                <div className="gallery-chat-panel">
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
                        scrollRequest={scrollRequest}
                        viewDiffId={V2.diff.diffId}
                        onScrollRequestHandled={() => {
                            setScrollRequest(null);
                        }}
                        onClose={() => undefined}
                        onRemoveAnchor={() => undefined}
                        onAsk={() => Promise.reject(new Error('the gallery does not send questions'))}
                        onCancel={() => Promise.resolve()}
                        onRetry={() => Promise.resolve()}
                        onNavigate={() => undefined}
                        onNavigateToNote={() => undefined}
                        now={GALLERY_NOW}
                    />
                </div>
            </div>
        </div>
    );
}

export const ITERATION_LOST_NOTE_STATES: readonly RouteGalleryState[] = [
    {
        id: 'iterations-notes-lost',
        title: 'notes after a push: banner, anchor lost chip in chat, moved notes beside the code',
        render: () => <NotesLostState />,
    },
];
