// @vitest-environment jsdom
import { anchor, bot, comment, human, thread } from '@sherpa/fixtures';
import { fixtureIteration } from '@sherpa/fixtures';
import type { Thread } from '@sherpa/protocol';
import { act, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionStore } from '../session/session-store.js';
import type { SessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import type { ThreadStore } from '../threads/store.js';
import { OverviewDiscussion } from './overview-discussion.tsx';
import { ViewFrame } from './view-frames.tsx';

/**
 * Discussion card in Overview (docs/design/SPEC-additions-2026-08-26.md §1e): a summary and entry point. It expands human threads outside the diff
 * because there is nowhere else to read them, never expands bot threads, and shows at
 * most six participants.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DIFF_ID = 'd1';
const ALIVE = 'services/orders/src/alive.ts';
const GONE = 'services/orders/src/gone.ts';
const FILE_IDS = new Set([anchor(DIFF_ID, ALIVE).fileId]);
const NOW = Date.parse('2026-08-24T12:00:00.000Z');

const PEOPLE = ['ada', 'morgan', 'kai', 'iris', 'dana', 'nora', 'sam'];

/** Seven people with one thread each at code: the sixth row is the limit, and the seventh hides behind "N more". */
const AT_CODE: readonly Thread[] = PEOPLE.map((login, index) =>
    thread({
        id: `code-${login}`,
        anchor: anchor(DIFF_ID, ALIVE, { side: 'new', line: index + 1 }),
        root: comment({
            id: `code-${login}-root`,
            author: human(login, login),
            body: 'at the code',
            createdAt: `2026-08-24T1${String(index)}:00:00.000Z`,
        }),
    }),
);

const OUTSIDE: readonly Thread[] = [
    thread({
        id: 'pr-level',
        anchor: null,
        root: comment({
            id: 'pr-level-root',
            author: human('ada', 'ada'),
            body: 'PR-level body',
            createdAt: '2026-08-24T11:30:00.000Z',
        }),
    }),
    thread({
        id: 'gone-file',
        anchor: anchor(DIFF_ID, GONE, { side: 'new', line: 4 }),
        root: comment({
            id: 'gone-file-root',
            author: human('morgan', 'morgan'),
            body: 'gone file body',
            createdAt: '2026-08-24T11:00:00.000Z',
            replies: [
                // This participant opened no threads. They get a row only because of this reply.
                comment({
                    id: 'gone-file-reply',
                    author: human('riley', 'riley'),
                    body: 'reply body',
                    createdAt: '2026-08-24T11:10:00.000Z',
                }),
            ],
        }),
    }),
];

const BOT_OUTSIDE = thread({
    id: 'bot-pr-level',
    anchor: null,
    root: comment({
        id: 'bot-pr-level-root',
        author: bot('ai-review-bot', 'AI Review'),
        body: 'bot body never shown',
        createdAt: '2026-08-24T11:45:00.000Z',
    }),
});

const THREADS: readonly Thread[] = [...AT_CODE, ...OUTSIDE, BOT_OUTSIDE];

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

/** The Overview card reads threads from the store instead of a constant prop so drafts appear immediately. */
function CardUnderTest({
    session,
    store,
    onWritePrComment,
}: {
    session: SessionStore;
    store: ThreadStore;
    onWritePrComment?: (returnFocus: () => void) => void;
}) {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return (
        <OverviewDiscussion
            threads={snapshot.threads}
            fileIds={FILE_IDS}
            session={session}
            store={store}
            transport={TRANSPORT}
            now={NOW}
            loading={false}
            error={null}
            {...(onWritePrComment === undefined ? {} : { onWritePrComment })}
        />
    );
}

function mount(options: { onWritePrComment?: (returnFocus: () => void) => void } = {}) {
    const host = document.createElement('div');
    document.body.append(host);
    const session: SessionStore = createSessionStore({
        initial: { view: 'overview', filter: 'all' },
    });
    const store = createThreadStore(THREADS, FILE_IDS);
    const root = createRoot(host);
    act(() => {
        root.render(
            <CardUnderTest
                session={session}
                store={store}
                {...(options.onWritePrComment === undefined
                    ? {}
                    : { onWritePrComment: options.onWritePrComment })}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { host, session, store };
}

function rows(host: HTMLElement): string[] {
    return [...host.querySelectorAll('.discussion-participant__name')].map((node) => node.textContent);
}

function click(host: HTMLElement, selector: string, index = 0): void {
    const element = [...host.querySelectorAll<HTMLElement>(selector)][index];
    expect(element, selector).toBeDefined();
    act(() => {
        element?.click();
    });
}

describe('discussion card in Overview', () => {
    it('counts all PR threads in the header and has no source chips anymore', () => {
        const { host } = mount();

        expect(host.querySelector('.discussion-card__counts')?.textContent).toBe('10 threads · 10 open');
        expect(host.querySelector('.thread-chip')).toBeNull();
    });

    it('shows at most six rows and puts the rest behind "N more participants"', () => {
        const { host } = mount();

        expect(rows(host)).toHaveLength(6);
        expect(host.querySelector('.discussion-card__more')?.textContent).toBe('3 more participants');

        click(host, '.discussion-card__more');

        // The ninth row is riley, who has no threads of their own, only a reply in someone else's.
        expect(rows(host)).toHaveLength(9);
        expect(rows(host)).toContain('riley');
        expect(host.querySelector('.discussion-card__more')).toBeNull();
    });

    it('collapses the "outside the diff" group by default and expands only human threads', () => {
        const { host } = mount();
        const toggle = host.querySelector('.discussion-card__outside-toggle');

        expect(toggle?.getAttribute('aria-expanded')).toBe('false');
        expect(host.querySelector('.discussion-thread')).toBeNull();

        click(host, '.discussion-card__outside-toggle');

        expect(host.querySelectorAll('.discussion-thread')).toHaveLength(2);
        expect(host.textContent).toContain('PR-level body');
        expect(host.textContent).toContain('gone file body');
        expect(host.textContent).not.toContain('bot body never shown');
    });

    it('sets an author lens and opens Full diff when a participant is clicked', () => {
        const { host, session } = mount();

        // Most open threads come first: ada has 2 (one at code, one at PR level).
        click(host, '.discussion-participant');

        expect(session.getSnapshot().threadAuthor).toBe('ada');
        expect(session.getSnapshot().view).toBe('diff');
    });

    it('clears the author lens for "All threads at code" instead of taking it to the diff', () => {
        const { host, session } = mount();

        click(host, '.discussion-participant');
        expect(session.getSnapshot().threadAuthor).toBe('ada');

        session.setView('overview');
        click(host, '.discussion-card__all');

        expect(session.getSnapshot().threadAuthor).toBeNull();
        expect(session.getSnapshot().view).toBe('diff');
    });

    it('shows a state chip on every thread outside the diff, including open ones', () => {
        const { host } = mount();
        click(host, '.discussion-card__outside-toggle');

        expect([...host.querySelectorAll('.discussion-thread__state')].map((chip) => chip.textContent)).toEqual([
            'open',
            'open',
        ]);
    });

    it('shows replies outside the diff in the card, including a newly written reply immediately', () => {
        const { host, store } = mount();
        click(host, '.discussion-card__outside-toggle');

        // Collapse replies into a counter so the card stays a summary until replies are requested.
        const toggle = host.querySelector('.discussion-thread__replies-toggle');
        expect(toggle?.textContent).toBe('1 reply');
        expect(host.textContent).not.toContain('reply body');

        click(host, '.discussion-thread__replies-toggle');
        expect(host.textContent).toContain('reply body');

        // The composer closes on save, so the new reply must appear in the card itself.
        click(host, '.discussion-thread__reply', 1);
        act(() => {
            store.addDraft(
                { parentId: 'gone-file-root', anchor: null, body: 'fresh reply' },
                comment({
                    id: 'fresh-reply',
                    author: human('me', 'me'),
                    body: 'fresh reply',
                    createdAt: '2026-08-24T11:40:00.000Z',
                    draft: true,
                }),
            );
        });

        expect(host.textContent).toContain('fresh reply');
    });

    it('opens the modal for "Write a PR comment" and passes focus restoration', () => {
        const onWrite = vi.fn();
        const { host } = mount({ onWritePrComment: onWrite });

        click(host, '.discussion-card__write');

        expect(onWrite).toHaveBeenCalledTimes(1);
        const returnFocus = onWrite.mock.calls[0]?.[0] as () => void;
        returnFocus();
        expect(document.activeElement).toBe(host.querySelector('.discussion-card__write'));
    });

    it('invites starting at code when there are no threads and keeps the footer', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <OverviewDiscussion
                    threads={[]}
                    fileIds={FILE_IDS}
                    session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
                    store={createThreadStore([], FILE_IDS)}
                    transport={TRANSPORT}
                    now={NOW}
                    loading={false}
                    error={null}
                />,
            );
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });

        expect(host.textContent).toContain('No threads yet — discussion starts at the code.');
        expect(host.querySelector('.thread-chip')).toBeNull();
        expect(host.querySelector('.discussion-card__write')).not.toBeNull();
    });
});

describe('discussion card within the whole Overview', () => {
    it('occupies the right rail in place of the thread feed', () => {
        const data = fixtureIteration('medium');
        const fileIds = new Set(data.diff.files.map((file) => file.fileId));
        const html = renderToStaticMarkup(
            <ViewFrame
                view="overview"
                prKey="fixture-medium"
                session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
                pr={data.pr}
                diff={data.diff}
                lenses={{ ownership: data.ownership, extra: data.extraLenses }}
                threads={data.threads}
                threadStore={createThreadStore(data.threads, fileIds)}
                threadNow={NOW}
                reviewHostAvailable
            />,
        );

        expect(html).toContain('class="discussion-card"');
        expect(html).toContain('aria-expanded="false"');
        // The thread feed from the old card is no longer in Overview.
        expect(html).not.toContain('thread-outside__toggle');
        expect(html).not.toContain('thread__body');
    });
});

const TRANSPORT = {
    save: () => Promise.reject(new Error('writes are unavailable in this test')),
    update: () => Promise.reject(new Error('writes are unavailable in this test')),
    delete: () => Promise.reject(new Error('writes are unavailable in this test')),
};
