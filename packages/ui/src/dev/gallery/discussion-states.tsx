import {
    anchor,
    bot,
    comment,
    fixtureIteration,
    GALLERY_AVATAR_BROKEN,
    GALLERY_AVATAR_PHOTOS,
    human,
    thread,
    withAvatars,
} from '@sherpa/fixtures';
import type { Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { createSessionStore } from '../../session/session-store.js';
import type { ComposerTransport } from '../../threads/composer.js';
import { createThreadStore } from '../../threads/store.js';
import { openReply } from '../../threads/thread-list.tsx';
import { OverviewDiscussion } from '../../views/overview-discussion.tsx';
import './discussion-states.css';

/**
 * Discussion card in Overview (docs/design/SPEC-additions-2026-08-26.md §1e). The 360px column has the same width
 * as the design, so it tests whether a long link and code block break the layout.
 */

const MEDIUM = fixtureIteration('medium');
const MEDIUM_FILE_IDS = new Set(MEDIUM.diff.files.map((file) => file.fileId));
const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');

const DIFF_ID = 'gallery-1e';
const ALIVE = 'services/orders/src/domain/edit-window.ts';
const GONE = 'services/orders/src/legacy/edit-window-old.ts';
const SCALE_FILE_IDS = new Set([anchor(DIFF_ID, ALIVE).fileId]);

const BOTS = [
    bot('ai-review-bot', 'AI Review'),
    bot('lint-bot', 'Lint Bot'),
    bot('sec-scanner', 'Security Scanner'),
    bot('perf-watch', 'Perf Watch'),
    bot('style-guard', 'Style Guard'),
    bot('deps-bot', 'Deps Bot'),
];
const PEOPLE = [human('morgan', 'Morgan Price'), human('ada', 'Ada Ortiz')];
/** Replies in someone else's thread without opening any of their own, but still has a participant row. */
const REPLIER = human('drew', 'Drew Kim');

const LONG_LINK =
    'https://github.com/quillmart/quillmart/blob/9f3c1ab6d4e2705c8a1b3f9d6e4c2a08b7d5f316/services/orders/src/domain/edit-window.ts#L118-L146';

/**
 * Scale from §1e: 86 threads, including 83 bot threads from 6 sources and 3 human threads, 2 of those
 * 3 outside the diff (a removed file and the PR level). Nine participants: 6 bots and 3
 * people, the third of whom only replies in someone else's thread. The list shows 6 rows
 * and hides the rest behind "N more".
 */
const SCALE_THREADS: readonly Thread[] = [
    ...Array.from({ length: 83 }, (_, index) => {
        const source = BOTS[index % BOTS.length] ?? BOTS[0];
        if (source === undefined) {
            throw new Error('the gallery needs at least one bot');
        }
        return thread({
            id: `bot-${String(index)}`,
            anchor: anchor(DIFF_ID, ALIVE, { side: 'new', line: 10 + index }),
            resolved: index % 5 === 0,
            root: comment({
                id: `bot-${String(index)}-root`,
                author: source,
                body: 'Possible context leak in the edit window handler.',
                createdAt: `2026-08-2${String(index % 4)}T09:${String(10 + (index % 40))}:00.000Z`,
            }),
        });
    }),
    thread({
        id: 'human-at-code',
        anchor: anchor(DIFF_ID, ALIVE, { side: 'new', line: 118 }),
        root: comment({
            id: 'human-at-code-root',
            author: PEOPLE[0] ?? human('morgan'),
            body: 'The window is calculated from `createdAt` here, not `scheduledAt`. Is that intentional?',
            createdAt: '2026-08-24T11:20:00.000Z',
        }),
    }),
    thread({
        id: 'human-gone-file',
        anchor: anchor(DIFF_ID, GONE, { side: 'new', line: 42 }),
        root: comment({
            id: 'human-gone-file-root',
            author: PEOPLE[0] ?? human('morgan'),
            body: [
                '### Old window calculation',
                '',
                'The file has left the PR, but the question remains: the old branch calculated the window this way,',
                'and this behaviour still exists somewhere else.',
                '',
                '```ts',
                'const deadline = createdAt + EDIT_WINDOW_MINUTES * 60_000; // 30 minutes after creation',
                '```',
                '',
                `Source link: ${LONG_LINK}`,
            ].join('\n'),
            createdAt: '2026-08-24T10:40:00.000Z',
        }),
    }),
    thread({
        id: 'human-pr-level',
        anchor: null,
        root: comment({
            id: 'human-pr-level-root',
            author: PEOPLE[1] ?? human('ada'),
            body: [
                'I went through the whole PR: the window logic is fine, but the description needs more detail.',
                'It does not say that the window is measured in minutes and capped by the delivery schedule.',
                'Check the migration separately: it carries over existing orders without a window,',
                'and the endpoint will return 400 for them instead of a clear message.',
                'Link to the chat discussion: ' + LONG_LINK,
            ].join('\n'),
            createdAt: '2026-08-24T11:50:00.000Z',
            replies: [
                comment({
                    id: 'human-pr-level-reply-1',
                    author: REPLIER,
                    body: 'I updated the description to state the minutes and the delivery schedule cap explicitly.',
                    createdAt: '2026-08-24T11:55:00.000Z',
                }),
                comment({
                    id: 'human-pr-level-reply-2',
                    author: PEOPLE[1] ?? human('ada'),
                    body: 'Thanks. Please still check the migration separately. The endpoint returns 400 for old orders.',
                    createdAt: '2026-08-24T11:58:00.000Z',
                }),
            ],
        }),
    }),
];

/** Same scale with photos: 2 people and one bot have photos, the reply author's photo fails to load. */
const AVATAR_THREADS = withAvatars(
    SCALE_THREADS,
    new Map([
        ['morgan', GALLERY_AVATAR_PHOTOS[0]],
        ['ada', GALLERY_AVATAR_PHOTOS[1]],
        ['ai-review-bot', GALLERY_AVATAR_PHOTOS[2]],
        [REPLIER.login, GALLERY_AVATAR_BROKEN],
    ]),
);

const TRANSPORT: ComposerTransport = {
    save: () => Promise.reject(new Error('Sherpa gallery: writing drafts is not available')),
    update: () => Promise.reject(new Error('Sherpa gallery: writing drafts is not available')),
    delete: () => Promise.reject(new Error('Sherpa gallery: writing drafts is not available')),
};

function Card({
    threads,
    fileIds,
    outsideOpen = false,
    replyTo,
}: {
    threads: readonly Thread[];
    fileIds: ReadonlySet<string>;
    outsideOpen?: boolean;
    /** Thread with the reply composer open from the start: the state is rendered without clicking. */
    replyTo?: string;
}) {
    const session = useMemo(
        () =>
            createSessionStore({
                initial: {
                    view: 'overview',
                    filter: 'all',
                },
            }),
        [],
    );
    const store = useMemo(() => {
        const created = createThreadStore(threads, fileIds);
        created.setViewer(MEDIUM.pr.viewer?.login ?? null);
        const target = threads.find((candidate) => candidate.id === replyTo);
        if (target !== undefined) {
            openReply(created, target, true);
        }
        return created;
    }, [fileIds, replyTo, threads]);
    return (
        <div className="gallery-discussion-column">
            <OverviewDiscussion
                threads={threads}
                fileIds={fileIds}
                session={session}
                store={store}
                transport={TRANSPORT}
                now={GALLERY_NOW}
                loading={false}
                error={null}
                onWritePrComment={() => undefined}
                outsideOpenByDefault={outsideOpen}
            />
        </div>
    );
}

export const DISCUSSION_STATES: readonly {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}[] = [
    {
        id: 'discussion-empty',
        title: 'discussion: no threads',
        render: () => <Card threads={EMPTY} fileIds={MEDIUM_FILE_IDS} />,
    },
    {
        id: 'discussion-people',
        title: 'discussion: people only (medium fixture)',
        render: () => <Card threads={MEDIUM.threads} fileIds={MEDIUM_FILE_IDS} />,
    },
    {
        id: 'discussion-scale',
        title: 'discussion: 86 threads, people and bots',
        render: () => <Card threads={SCALE_THREADS} fileIds={SCALE_FILE_IDS} />,
    },
    {
        id: 'discussion-outside-open',
        title: 'discussion: "outside the diff" expanded, reply in progress',
        render: () => (
            <Card
                threads={SCALE_THREADS}
                fileIds={SCALE_FILE_IDS}
                outsideOpen
                replyTo="human-pr-level"
            />
        ),
    },
    {
        id: 'discussion-avatars',
        title: 'discussion: participant photos, including the bot. Broken photo shows initials',
        render: () => <Card threads={AVATAR_THREADS} fileIds={SCALE_FILE_IDS} outsideOpen />,
    },
];

const EMPTY: readonly Thread[] = [];
