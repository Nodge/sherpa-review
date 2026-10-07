import { fixtureIteration, GALLERY_AVATAR_BROKEN, GALLERY_AVATAR_PHOTOS, withAvatars } from '@sherpa/fixtures';
import type { Comment, FileDiff, Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo, useSyncExternalStore } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import type { FileCardActions } from '../../diff-view/file-card.tsx';
import { FileCard } from '../../diff-view/file-card.tsx';
import type { DiffMode } from '../../diff-view/store.js';
import { readStateOf } from '../../progress/read-state.js';
import { useCardThreads, useThreadsCollapse } from '../../threads/card-threads.tsx';
import type { ComposerTransport } from '../../threads/composer.js';
import { openDraftEditor } from '../../threads/draft-editor.tsx';
import { createThreadStore } from '../../threads/store.js';
import type { ThreadStore } from '../../threads/store.js';
import type { ThreadActions } from '../../threads/thread-list.tsx';
import type { PublishedCommentTransport } from '../../threads/transport.js';

/**
 * Code threads after the 2026-09-20 delta spec §3: marker on the card edge, expansion below the
 * line, Resolve on each issue comment, editing and deleting your own published comments.
 * All states are deterministic: a fixture plus composers opened in advance, without clicks.
 */

const DATA = fixtureIteration('medium');
const FILE = fileForGallery('services/orders/src/api/handlers.ts');
// New file: diff reaches the end of the file, with no trailing bridge after the last line.
const NEW_FILE = fileForGallery('services/orders/src/infra/clock.ts');
const NOW = Date.parse('2026-08-31T12:00:00.000Z');
// The gallery's "me" is the same reviewer as in the fixture, used to determine what is "own".
const ME = DATA.currentUser;
const BOT = { login: 'lint-bot', displayName: 'AI Review (style)', bot: true, avatarUrl: null };
const OTHER = { login: 'kai', displayName: 'Kai Kennedy', bot: false, avatarUrl: null };
/** Photos for avatar states: the other participant and bot have photos, the reviewer's fails to load. */
const PHOTOS = new Map([
    [OTHER.login, GALLERY_AVATAR_PHOTOS[0]],
    [BOT.login, GALLERY_AVATAR_PHOTOS[2]],
    [ME.login, GALLERY_AVATAR_BROKEN],
]);

const TRANSPORT: ComposerTransport = {
    save: () => Promise.reject(new Error('gallery does not save')),
    update: () => Promise.resolve({ outcome: 'saved' }),
    delete: () => Promise.resolve(),
};
const PUBLISHED: PublishedCommentTransport = {
    setResolved: () => Promise.resolve(),
    update: () => Promise.resolve(),
    delete: () => Promise.resolve(),
};
const ACTIONS: FileCardActions = {
    onViewed: () => Promise.resolve(null),
    onExpand: () => Promise.resolve({ feedback: null, content: null, expansion: new Map() }),
    onRetryParse: () => undefined,
    onOpenFile: () => undefined,
    onShowWhitespace: () => undefined,
    onToggleMarkdown: () => undefined,
    onSelectStart: () => undefined,
    onSelectExtend: () => undefined,
};

export interface CodeThreadGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const CODE_THREAD_STATES: readonly CodeThreadGalleryState[] = [
    {
        id: 'code-threads-markers',
        title: 'edge markers: human, bot, resolved, two conversations on one line',
        render: () => <CardState threads={markerThreads()} collapseAll />,
    },
    {
        id: 'code-threads-open',
        title: 'expanded thread: open and resolved under their lines',
        render: () => <CardState threads={openAndResolved()} />,
    },
    {
        id: 'code-threads-replies',
        title: 'replies without lines: 27px indent per level, "↳ recipient" beyond the fourth',
        render: () => <CardState threads={[deepThread()]} />,
    },
    {
        id: 'code-threads-resolve',
        title: 'Resolve on each issue comment',
        render: () => <CardState threads={[issuesThread()]} />,
    },
    {
        id: 'code-threads-draft-reply',
        title: 'own draft reply: action row without "Reply"',
        render: () => <CardState threads={[myThread()]} />,
    },
    {
        id: 'code-threads-delete-confirm',
        title: 'confirmation for deleting your own comment',
        render: () => <CardState threads={[myThread()]} confirmDelete />,
    },
    {
        id: 'code-threads-editing',
        title: 'editing a published comment in place',
        render: () => <CardState threads={[myThread()]} editing />,
    },
    {
        id: 'code-threads-split',
        title: 'split: right-half marker on the divider',
        render: () => <CardState threads={markerThreads()} mode="split" collapseAll />,
    },
    {
        id: 'code-threads-under-header',
        title: 'line with a marker halfway under the sticky header: marker moves with it',
        render: () => <CardState threads={markerThreads()} collapseAll underHeader />,
    },
    {
        id: 'code-threads-last-line-under-header',
        title: 'new file, thread on the last line: header reached the card bottom and covers the marker',
        render: () => <CardState file={NEW_FILE} threads={lastLineThreads()} collapseAll underHeader />,
    },
    {
        id: 'code-threads-last-line',
        title: 'new file, thread on the last line: marker at the bottom corner of the border',
        render: () => <CardState file={NEW_FILE} threads={lastLineThreads()} collapseAll />,
    },
    {
        id: 'code-threads-avatars',
        title: 'markers with photos: round photo for both human and bot',
        render: () => <CardState threads={withAvatars(markerThreads(), PHOTOS)} collapseAll />,
    },
    {
        id: 'code-threads-avatars-open',
        title: 'expanded thread with photos: a photo that fails to load falls back to initials',
        render: () => <CardState threads={withAvatars(openAndResolved(), PHOTOS)} />,
    },
];

function CardState({
    file = FILE,
    threads,
    mode = 'unified',
    collapseAll = false,
    editing = false,
    confirmDelete = false,
    underHeader = false,
}: {
    file?: FileDiff;
    threads: readonly Thread[];
    mode?: DiffMode;
    /** Threads start collapsed: the card is about the markers themselves. */
    collapseAll?: boolean;
    editing?: boolean;
    confirmDelete?: boolean;
    /** View is scrolled so the first marker's line is halfway under the sticky header. */
    underHeader?: boolean;
}) {
    const store = useMemo(() => {
        const created = createThreadStore(threads, new Set([file.fileId]));
        created.setViewer(DATA.pr.viewer?.login ?? null);
        if (collapseAll) {
            created.setThreadsOpen(
                threads.map((thread) => thread.id),
                false,
            );
        }
        const target = threads[0];
        if (editing && target !== undefined) {
            openDraftEditor(created, target, target.root);
        }
        return created;
    }, [collapseAll, editing, file, threads]);

    return (
        <div className="gallery__viewport" ref={underHeader ? scrollMarkerUnderHeader : undefined}>
            {/* Extra space below to allow enough scrolling to reach the target line. */}
            <div style={underHeader ? { padding: 24, paddingBottom: '70vh' } : { padding: 24 }}>
                <Card file={file} store={store} mode={mode} confirmDelete={confirmDelete} />
            </div>
        </div>
    );
}

function Card({
    file,
    store,
    mode,
    confirmDelete,
}: {
    file: FileDiff;
    store: ThreadStore;
    mode: DiffMode;
    confirmDelete: boolean;
}) {
    const model = useMemo(() => parseFileDiff(toParseRequest(file)), [file]);
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const actions = useMemo<ThreadActions>(
        () => ({
            transport: TRANSPORT,
            resolve: () => Promise.resolve(true),
            resolveComment: () => Promise.resolve(true),
            published: PUBLISHED,
        }),
        [],
    );
    const { threadsUnderHeader, renderAfterLine, renderLineMarker, lineThreadIds } = useCardThreads({
        model,
        rowsShown: true,
        threads: snapshot.byFile.get(file.fileId) ?? [],
        composers: [],
        store,
        actions,
        now: NOW,
        onFocusThread: () => undefined,
        initialLayout: 'markdown',
    });
    const threadsCollapse = useThreadsCollapse(store, lineThreadIds);

    return (
        <div ref={confirmDelete ? clickDelete : undefined}>
            <FileCard
                file={file}
                model={model}
                mode={mode}
                content={null}
                contentAvailable={false}
                expansion={new Map()}
                read={readStateOf({ file: FILE, record: null })}
                opened
                showWhitespace={false}
                markdown={false}
                selection={null}
                threadsUnderHeader={threadsUnderHeader}
                renderAfterLine={renderAfterLine}
                renderLineMarker={renderLineMarker}
                threadsCollapse={threadsCollapse}
                actions={ACTIONS}
            />
        </div>
    );
}

/** Scrolling is a screen state, not a scenario: the first marker's line sits halfway under the header. */
function scrollMarkerUnderHeader(viewport: HTMLDivElement | null): void {
    if (viewport === null) {
        return;
    }
    const marker = viewport.querySelector('.thread-marker');
    const header = viewport.querySelector('.file-card__header');
    if (marker === null || header === null) {
        return;
    }
    const markerBox = marker.getBoundingClientRect();
    const markerTop = markerBox.top - viewport.getBoundingClientRect().top + viewport.scrollTop;
    viewport.scrollTop = markerTop - header.getBoundingClientRect().height + markerBox.height / 2;
}

/** Delete confirmation is a screen state, not a scenario: the gallery clicks the link for the reviewer. */
function clickDelete(host: HTMLDivElement | null): void {
    host?.querySelector<HTMLButtonElement>('.thread__action--delete')?.click();
}

function threadOf(
    id: string,
    line: number,
    root: Partial<Comment> & Pick<Comment, 'id' | 'body'>,
    resolved = false,
    file: FileDiff = FILE,
): Thread {
    return {
        id,
        anchor: { fileId: file.fileId, path: file.path, position: { side: 'new', line, size: 1 } },
        resolved,
        resolvedBy: resolved ? OTHER.login : null,
        outdated: false,
        pinnedTo: null,
        root: {
            author: OTHER,
            draft: false,
            issue: null,
            resolved: null,
            createdAt: '2026-08-31T10:00:00.000Z',
            editedAt: null,
            replies: [],
            ...root,
        },
    };
}

function markerThreads(): Thread[] {
    return [
        threadOf('marker-person', 48, {
            id: 'marker-person-root',
            body: 'The client needs a countdown, not an absolute time.',
            replies: [
                {
                    id: 'marker-person-reply',
                    author: ME,
                    body: 'Agreed, changed it to remaining time.',
                    draft: false,
                    issue: null,
                    resolved: null,
                    createdAt: '2026-08-31T10:05:00.000Z',
                    editedAt: null,
                    replies: [],
                },
            ],
        }),
        threadOf('marker-bot', 49, {
            id: 'marker-bot-root',
            author: BOT,
            body: 'The failure branch has no test.',
        }),
        threadOf(
            'marker-resolved',
            50,
            {
                id: 'marker-resolved-root',
                body: 'naming: drop() → invalidate().',
                issue: true,
                resolved: true,
            },
            true,
        ),
        threadOf('marker-second', 48, {
            id: 'marker-second-root',
            author: ME,
            body: 'Also move the window constant into config.',
        }),
    ];
}

/** Thread on the last line of a new file: for an added file, the last line number equals the addition count. */
function lastLineThreads(): Thread[] {
    return [
        threadOf(
            'last-line',
            NEW_FILE.additions,
            { id: 'last-line-root', body: 'Exporting a singleton hides the clock dependency.' },
            false,
            NEW_FILE,
        ),
    ];
}

function openAndResolved(): Thread[] {
    const [person, , resolved] = markerThreads();
    return [person, resolved].filter((thread): thread is Thread => thread !== undefined);
}

/**
 * Six-level thread: indentation grows by 27px up to the fourth level, then stays fixed,
 * and the "↳ recipient" label in the message header names the recipient.
 */
function deepThread(): Thread {
    const reply = (
        id: string,
        author: typeof ME,
        body: string,
        minute: number,
        replies: Comment[] = [],
    ): Comment => ({
        id,
        author,
        body,
        draft: false,
        issue: null,
        resolved: null,
        createdAt: `2026-08-31T10:${String(minute).padStart(2, '0')}:00.000Z`,
        editedAt: null,
        replies,
    });
    return threadOf('deep', 48, {
        id: 'deep-root',
        body: 'Why is the window a class instead of a pure function of (order, now)?',
        replies: [
            reply('deep-1', ME, 'Next comes a window per product category, which means state.', 10, [
                reply('deep-2', OTHER, 'Then have the constructor take config, not just a Clock.', 15, [
                    reply('deep-3', ME, 'I will do it in the next PR. This one is already big.', 20, [
                        reply('deep-4', OTHER, 'Link the issue here or it will get lost.', 25, [
                            reply('deep-5', ME, '#2281.', 30, [
                                reply('deep-6', OTHER, 'Thanks.', 35),
                            ]),
                        ]),
                    ]),
                ]),
            ]),
            reply('deep-side', OTHER, 'Second branch on the same parent: the config also moves the flag out of the domain.', 12),
        ],
    });
}

function issuesThread(): Thread {
    return threadOf('issues', 48, {
        id: 'issues-root',
        body: 'Nothing limits the retry loop.',
        issue: true,
        resolved: true,
        replies: [
            {
                id: 'issues-reply',
                author: ME,
                body: 'And the new limit has no test.',
                draft: false,
                issue: true,
                resolved: false,
                createdAt: '2026-08-31T10:20:00.000Z',
                editedAt: null,
                replies: [],
            },
        ],
    });
}

/** A published comment of your own: the gallery sets the reviewer login through a draft reply. */
function myThread(): Thread {
    return threadOf('mine', 48, {
        id: 'mine-root',
        author: ME,
        body: 'The remainingMs field misleads the client here.',
        replies: [
            {
                id: 'mine-draft',
                author: ME,
                body: 'I will check again before Ship.',
                draft: true,
                issue: null,
                resolved: null,
                createdAt: '2026-08-31T10:25:00.000Z',
                editedAt: null,
                replies: [],
            },
        ],
    });
}

function fileForGallery(path: string): FileDiff {
    const file = DATA.diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`fixture medium needs ${path}`);
    }
    return file;
}
