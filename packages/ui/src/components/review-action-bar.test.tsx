import { fixtureData } from '@sherpa/fixtures';
import type { Thread } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createDiffViewStore } from '../diff-view/store.js';
import { countDraftComments } from '../progress/summary.js';
import { createThreadStore } from '../threads/store.js';
import { ReviewActionBar } from './review-action-bar.tsx';
import { ReviewComplete } from './review-complete.tsx';

const DATA = fixtureData('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const DRAFT_THREADS = withDraft(DATA.threads);
const TRANSPORT = {
    save: () => Promise.reject(new Error('not called during static rendering')),
    update: () => Promise.reject(new Error('not called during static rendering')),
    delete: () => Promise.reject(new Error('not called during static rendering')),
};

function renderBar(options: { menu?: boolean; threads?: typeof DRAFT_THREADS; sticky?: boolean } = {}): string {
    const threads = options.threads ?? DRAFT_THREADS;
    return renderToStaticMarkup(
        <ReviewActionBar
            pr={{
                ...DATA.pr,
                capabilities: {
                    ...DATA.pr.capabilities,
                    stickyShip: options.sticky ?? DATA.pr.capabilities.stickyShip,
                },
            }}
            diff={DATA.diff}
            diffStore={createDiffViewStore({ files: DATA.diff.files, storage: null })}
            threadStore={createThreadStore(threads, FILE_IDS)}
            connection="online"
            hostName="FixtureHost"
            composerTransport={TRANSPORT}
            onPublish={() => Promise.reject(new Error('not called during static rendering'))}
            onComplete={() => undefined}
            {...(options.menu === undefined ? {} : { defaultMenuOpen: options.menu })}
            storage={null}
        />,
    );
}

function withDraft(threads: readonly Thread[]): Thread[] {
    const first = threads[0];
    if (first === undefined) {
        throw new Error('the test needs at least one thread');
    }
    return [{ ...first, root: { ...first.root, draft: true } }, ...threads.slice(1)];
}

describe('floating review bar', () => {
    it('shows the live draft count and the count on both final action buttons', () => {
        const drafts = countDraftComments(DRAFT_THREADS);
        expect(drafts).toBeGreaterThan(0);

        const html = renderBar();

        expect(html).toContain(`${String(drafts)} draft`);
        expect(html).toContain(`Request changes · ${String(drafts)}`);
        expect(html).toContain(`Ship · ${String(drafts)}`);
    });

    it('shows neutral text with zero drafts', () => {
        const html = renderBar({ threads: [] });

        expect(html).toContain('no unpublished comments');
        expect(html).not.toContain('go out on ship');
    });

    it('uses the singular verb for numbers ending in one', () => {
        const source = DRAFT_THREADS[0];
        if (source === undefined) {
            throw new Error('the test needs a thread');
        }
        const threads = Array.from({ length: 21 }, (_, index) => ({
            ...source,
            id: `draft-thread-${String(index)}`,
            root: { ...source.root, id: `draft-${String(index)}`, draft: true },
        }));

        expect(renderBar({ threads })).toContain('21 drafts go out on ship');
    });

    it('shows a non-blocking warning, exact consequences and a reason for disabled sticky in the menu', () => {
        const html = renderBar({ menu: true, sticky: false });

        expect(html).toContain('ship anyway?');
        expect(html).toContain('Approves this snapshot only. A new push drops the approval and asks again.');
        expect(html).toContain('The approval carries over to later pushes until a file in your ownership zone changes.');
        expect(html).toContain('This host does not support Sticky ship.');
        expect(html).toContain('aria-disabled="true"');
    });

    it('hides only while the diff store has an active drag selection', () => {
        const diffStore = createDiffViewStore({ files: DATA.diff.files, storage: null });
        diffStore.beginSelection();
        diffStore.startSelection(DATA.diff.files[0]?.fileId ?? 'file', 'a1');
        const props = {
            pr: DATA.pr,
            diff: DATA.diff,
            diffStore,
            threadStore: createThreadStore(DRAFT_THREADS, FILE_IDS),
            connection: 'online' as const,
            hostName: 'FixtureHost',
            composerTransport: TRANSPORT,
            onPublish: () => Promise.reject(new Error('not called during static rendering')),
            onComplete: () => undefined,
            storage: null,
        };

        expect(renderToStaticMarkup(<ReviewActionBar {...props} />)).toBe('');
        diffStore.finishSelection();
        expect(renderToStaticMarkup(<ReviewActionBar {...props} />)).toContain('review-action-bar');
    });

    it('shows the failed comment text and only a retry action in the error state', () => {
        const html = renderToStaticMarkup(
            <ReviewActionBar
                pr={DATA.pr}
                diff={DATA.diff}
                diffStore={createDiffViewStore({ files: DATA.diff.files, storage: null })}
                threadStore={createThreadStore(DRAFT_THREADS, FILE_IDS)}
                connection="online"
                hostName="FixtureHost"
                composerTransport={TRANSPORT}
                onPublish={() => Promise.reject(new Error('not called during static rendering'))}
                onComplete={() => undefined}
                initialFailure={{
                    verdict: 'ship',
                    failedCount: 1,
                    message: null,
                    comments: [{ commentId: 'bad', body: 'Fix the boundary check', message: 'host refused' }],
                }}
                storage={null}
            />,
        );

        expect(html).toContain('1 comment failed to publish');
        expect(html).toContain('Fix the boundary check');
        expect(html).toContain('host refused');
        expect(html).toContain('<button type="button">retry</button>');
        expect(html).not.toContain('Request changes');
    });
});

describe('Review complete screen', () => {
    it('renders the M1 counters and amber footer for open threads', () => {
        const html = renderToStaticMarkup(
            <ReviewComplete
                completion={{
                    verdict: 'sticky_ship',
                    prId: '4821',
                    headCommit: '9f3c1ab012345',
                    hostName: 'GitHub',
                    publishedComments: 2,
                    publishedReplies: 1,
                    progress: {
                        filesSeen: 17,
                        filesTotal: 18,
                        linesSeen: 800,
                        linesTotal: 862,
                        percentSeen: 92,
                    },
                    openThreads: 1,
                    firstOpenThreadId: 'thread-1',
                }}
                onOpenThread={() => undefined}
                onOpenFullDiff={() => undefined}
            />,
        );

        expect(html).toContain('Sticky ship · PR 4821');
        expect(html).toContain('2 comments published as one batch');
        expect(html).toContain('delivered to GitHub');
        expect(html).toContain('17 of 18');
        expect(html).toContain('92% of 862 lines');
        expect(html).toContain('2 (1 of them a reply)');
        expect(html).toContain('1 thread is still open');
        expect(html).toContain('To the full diff');
    });
});
