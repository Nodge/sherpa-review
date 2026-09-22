import { fixtureIteration } from '@sherpa/fixtures';
import type { DraftBufferEntry, Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { ReviewActionBar } from '../../components/review-action-bar.tsx';
import { ShipVerdictBanner } from '../../components/ship-verdict-banner.tsx';
import { createDiffViewStore } from '../../diff-view/store.js';
import { SettingsProvider } from '../../settings/context.tsx';
import { createUiSettingsStore } from '../../settings/settings-store.js';
import { NewCommentComposer, openPrComposer } from '../../threads/thread-list.tsx';
import { createThreadStore } from '../../threads/store.js';

/**
 * Draft buffer and ship summary. Composer in the "will save when the connection returns" state,
 * bar with a ship guard and unresolved thread count, banner for another reviewer's ship.
 */

const DATA = fixtureIteration('medium');
const GALLERY_NOW = Date.parse('2026-09-03T12:03:00.000Z');
const TRANSPORT = {
    save: () => Promise.reject(new Error('gallery does not write to the host')),
    update: () => Promise.reject(new Error('gallery does not write to the host')),
    delete: () => Promise.reject(new Error('gallery does not write to the host')),
};

const BUFFERED: DraftBufferEntry = {
    id: 'ck-gallery',
    draft: { body: 'This needs a check for an empty list.', parentId: null, anchor: null },
    commentId: null,
    state: 'failed',
    error: 'review host: 502 Bad Gateway',
    attempts: 2,
    createdAt: '2026-09-03T11:58:00.000Z',
    updatedAt: '2026-09-03T12:00:00.000Z',
};

export interface DraftBufferGalleryState {
    readonly id: string;
    readonly group: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const DRAFT_BUFFER_STATES: readonly DraftBufferGalleryState[] = [
    {
        id: 'draft-buffer-composer',
        group: 'Draft buffer',
        title: 'composer: will save when the connection returns',
        render: () => <BufferedComposerState />,
    },
    {
        id: 'draft-buffer-action-bar',
        group: 'Draft buffer',
        title: 'bar: ship waits for buffered drafts and counts unresolved threads',
        render: () => <BufferedBarState />,
    },
    {
        id: 'ship-verdict-banner',
        group: 'Draft buffer',
        title: 'banner: someone shipped first',
        render: () => (
            <ShipVerdictBanner
                event={{ login: 'lead', displayName: 'Leah Lane', observedAt: GALLERY_NOW - 3 * 60_000 }}
                now={GALLERY_NOW}
                onDismiss={() => undefined}
            />
        ),
    },
];

function BufferedComposerState() {
    const settings = useMemo(() => createUiSettingsStore({ initial: { composerLayout: 'markdown' } }), []);
    const store = useMemo(() => {
        const created = createThreadStore([], new Set());
        openPrComposer(created, true);
        created.updateComposer('new:pr', {
            text: BUFFERED.draft.body,
            status: 'buffered',
            clientKey: BUFFERED.id,
            bufferEntry: BUFFERED,
        });
        return created;
    }, []);

    return (
        <SettingsProvider store={settings}>
            <div style={{ maxWidth: 720 }}>
                <NewCommentComposer composerKey="new:pr" store={store} transport={TRANSPORT} />
            </div>
        </SettingsProvider>
    );
}

function BufferedBarState() {
    const diffStore = useMemo(() => createDiffViewStore({ files: DATA.diff.files }), []);
    const threadStore = useMemo(
        () => createThreadStore(withDraft(DATA.threads), new Set(DATA.diff.files.map((file) => file.fileId))),
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
            reviewHost="fixture"
            composerTransport={TRANSPORT}
            draftBuffer={[BUFFERED]}
            onPublish={() => Promise.reject(new Error('gallery does not write to the host'))}
            onComplete={() => undefined}
        />
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
