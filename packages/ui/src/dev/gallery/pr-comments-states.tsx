import { fixtureIteration } from '@sherpa/fixtures';
import type { Comment, Thread } from '@sherpa/protocol';
import { useCallback, useMemo } from 'react';

import { PrCommentsModal } from '../../components/pr-comments-modal.tsx';
import type { ComposerTransport } from '../../threads/composer.js';
import { openDraftEditor } from '../../threads/draft-editor.tsx';
import { createThreadStore } from '../../threads/store.js';
import type { ThreadActions } from '../../threads/thread-list.tsx';
import type { PublishedCommentTransport } from '../../threads/transport.js';

/**
 * The "PR comments" modal after the 2026-09-20 delta spec §4: PR-level threads as cards,
 * a collapsed row with a preview, and inline replies. Its width depends on the viewport
 * (`clamp(620px, 68vw, 1120px)`), so a gallery card cannot show it. E2E tests check it.
 */

const DATA = fixtureIteration('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const ME = DATA.pr.viewer ?? { login: 'avery', displayName: 'Avery Vance', bot: false, avatarUrl: null };
const OTHER = { login: 'kai', displayName: 'Kai Kennedy', bot: false, avatarUrl: null };
const BOT = { login: 'lint-bot', displayName: 'AI Review (style)', bot: true, avatarUrl: null };

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

const DRAFT = thread('pr-draft', '2026-08-31T11:42:00.000Z', {
    id: 'pr-draft-root',
    author: ME,
    body: 'We need to define what happens on a repeated Ship.',
    draft: true,
    issue: true,
});
const WITH_REPLIES = thread('pr-replies', '2026-08-31T11:18:00.000Z', {
    id: 'pr-replies-root',
    author: OTHER,
    body: 'Checked the transaction boundaries. The **lock order** is now unambiguous.',
    issue: true,
    replies: [
        reply('pr-replies-1', ME, 'Then I withdraw the comment: `DISPATCH_LOCK` is acquired after reading the state.', [
            reply('pr-replies-2', OTHER, 'Yes, and retries now follow the same branch.'),
        ]),
    ],
});
/** A thread six levels deep: indentation hits the limit, and the header shows "↳ to whom". */
const DEEP = thread('pr-deep', '2026-08-31T10:05:00.000Z', {
    id: 'pr-deep-root',
    author: OTHER,
    body: 'Document the lock order in `docs/architecture.md`. It is not obvious here.',
    replies: [
        reply('pr-deep-1', ME, 'I will add a paragraph to the queue section.', [
            reply('pr-deep-2', OTHER, 'And a transition diagram while you are at it.', [
                reply('pr-deep-3', ME, 'A diagram takes a while to draw. Let us use a list.', [
                    reply('pr-deep-4', OTHER, 'A list works, but include a retry example.', [
                        reply('pr-deep-5', ME, 'Added the example.', [
                            reply('pr-deep-6', OTHER, 'It reads clearly now.'),
                        ]),
                    ]),
                ]),
            ]),
        ]),
    ],
});
const MINE = thread('pr-mine', '2026-08-31T10:40:00.000Z', {
    id: 'pr-mine-root',
    author: ME,
    body: 'Describe the removal of the config key in the release notes.',
});
const BOT_THREAD = thread('pr-bot', '2026-08-31T09:20:00.000Z', {
    id: 'pr-bot-root',
    author: BOT,
    body: 'The linter sees no changes in `.github/CODEOWNERS`: the ownership zone is unchanged.',
});
const RESOLVED = thread(
    'pr-resolved',
    '2026-08-31T08:30:00.000Z',
    {
        id: 'pr-resolved-root',
        author: OTHER,
        body: 'The config migration is not documented. Fix it before merging.',
        issue: true,
        resolved: true,
        replies: [reply('pr-resolved-1', ME, 'Added a section to `docs/edit-window.md`.')],
    },
    true,
);

export const PR_COMMENTS_STATES = [
    {
        id: 'pr-comments-modal-threads',
        title: 'draft, thread with replies, bot, and collapsed resolved thread',
        render: () => <ModalState threads={[DRAFT, WITH_REPLIES, BOT_THREAD, RESOLVED]} />,
    },
    {
        id: 'pr-comments-modal-nesting',
        title: 'nesting: 27px indentation per level, "↳ to whom" beyond level four',
        render: () => <ModalState threads={[DEEP]} />,
    },
    {
        id: 'pr-comments-modal-reply',
        title: 'inline reply: composer below the message, issue toggle',
        render: () => <ModalState threads={[WITH_REPLIES]} click="reply" />,
    },
    {
        id: 'pr-comments-modal-editing',
        title: 'edit your comment in place',
        render: () => <ModalState threads={[MINE, WITH_REPLIES]} editing={MINE.id} />,
    },
    {
        id: 'pr-comments-modal-delete-confirm',
        title: 'confirmation for deleting your own comment',
        render: () => <ModalState threads={[MINE]} click="delete" />,
    },
    {
        id: 'pr-comments-modal-empty',
        title: 'empty',
        render: () => <ModalState threads={[]} />,
    },
] as const;

/**
 * A link the gallery clicks for the reviewer: deletion confirmation lives in the thread state,
 * and an inline reply lives in the store composer. A click sets up both states the same way.
 */
const CLICK_TARGET = {
    reply: '.thread__row--reply .thread__row-actions button',
    delete: '.thread__action--delete',
} as const;

function ModalState({
    threads,
    editing,
    click,
}: {
    threads: readonly Thread[];
    /** An open edit of this thread root. */
    editing?: string;
    click?: keyof typeof CLICK_TARGET;
}) {
    const store = useMemo(() => {
        const created = createThreadStore(threads, FILE_IDS);
        created.setViewer(ME.login);
        const target = threads.find((thread) => thread.id === editing);
        if (target !== undefined) {
            openDraftEditor(created, target, target.root);
        }
        return created;
    }, [editing, threads]);
    // The modal uses a portal in `body`, so look for the link in the last mounted modal.
    const press = useCallback(
        (host: HTMLDivElement | null): void => {
            if (host === null || click === undefined) {
                return;
            }
            const modals = document.querySelectorAll<HTMLElement>('.pr-comments-modal');
            modals[modals.length - 1]?.querySelector<HTMLButtonElement>(CLICK_TARGET[click])?.click();
        },
        [click],
    );
    const actions = useMemo<ThreadActions>(
        () => ({
            transport: TRANSPORT,
            commentIssues: true,
            resolve: () => Promise.resolve(true),
            resolveComment: () => Promise.resolve(true),
            published: PUBLISHED,
        }),
        [],
    );
    return (
        <div ref={press}>
            <PrCommentsModal
                pr={DATA.pr}
                store={store}
                transport={TRANSPORT}
                actions={actions}
                now={NOW}
                initialLayout="markdown"
                onClose={() => undefined}
            />
        </div>
    );
}

function reply(id: string, author: Comment['author'], body: string, replies: Comment[] = []): Comment {
    return {
        id,
        author,
        body,
        draft: false,
        issue: false,
        resolved: false,
        createdAt: '2026-08-31T11:30:00.000Z',
        editedAt: null,
        replies,
    };
}

function thread(
    id: string,
    createdAt: string,
    root: Partial<Comment> & Pick<Comment, 'id' | 'body' | 'author'>,
    resolved = false,
): Thread {
    return {
        id,
        anchor: null,
        resolved,
        resolvedBy: resolved ? OTHER.login : null,
        outdated: false,
        pinnedTo: null,
        root: {
            draft: false,
            // The medium fixture supports issue: a comment without it has the status off, not absent.
            issue: false,
            resolved: false,
            createdAt,
            editedAt: null,
            replies: [],
            ...root,
        },
    };
}
