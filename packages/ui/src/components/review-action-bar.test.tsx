// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { DraftBufferEntry, PublishResult, Thread, UiSettings, Verdict } from '@sherpa/protocol';
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { createDiffViewStore } from '../diff-view/store.js';
import { ThreadPinProvider } from '../iterations/thread-pin.tsx';
import { countDraftComments } from '../progress/summary.js';
import { SettingsProvider } from '../settings/context.tsx';
import { createUiSettingsStore } from '../settings/settings-store.js';
import { createThreadStore } from '../threads/store.js';
import { usePrCommentsGate } from './pr-comments-gate.js';
import type { RouteProgress } from './review-action-bar.tsx';
import {
    reviewActionBarVisible,
    ReviewActionBar,
} from './review-action-bar.tsx';
import { ReviewComplete } from './review-complete.tsx';

const DATA = fixtureIteration('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const DRAFT_THREADS = withDraft(DATA.threads);
const BUFFERED: DraftBufferEntry = {
    id: 'ck-1',
    draft: { body: 'waiting for a connection', parentId: null, anchor: null },
    commentId: null,
    state: 'failed',
    error: 'review host: 502',
    attempts: 1,
    createdAt: '2026-09-03T10:00:00.000Z',
    updatedAt: '2026-09-03T10:00:00.000Z',
};

const TRANSPORT = {
    save: () => Promise.reject(new Error('not called during static rendering')),
    update: () => Promise.reject(new Error('not called during static rendering')),
    delete: () => Promise.reject(new Error('not called during static rendering')),
};

function renderBar(
    options: {
        menu?: boolean;
        threads?: typeof DRAFT_THREADS;
        /** PR publishing modes. Defaults to the fixture modes. */
        verdicts?: readonly Verdict[];
        route?: RouteProgress | null;
        /** Active PR iteration, used to count drafts pinned to previous commits. */
        activeDiffId?: string;
        draftBuffer?: readonly DraftBufferEntry[];
        reviewHost?: string;
        /** Saved split-button mode. */
        shipMode?: UiSettings['shipMode'];
    } = {},
): string {
    const threads = options.threads ?? DRAFT_THREADS;
    const settings = createUiSettingsStore({ loaded: true, initial: { shipMode: options.shipMode ?? 'ship' } });
    return renderToStaticMarkup(
        <SettingsProvider store={settings}>
        <ThreadPinProvider
            value={{
                activeDiffId: options.activeDiffId ?? null,
                viewingDiffId: options.activeDiffId ?? null,
                openAtPin: null,
            }}
        >
        <ReviewActionBar
            pr={{
                ...DATA.pr,
                capabilities: {
                    ...DATA.pr.capabilities,
                    publishVerdicts: [...(options.verdicts ?? DATA.pr.capabilities.publishVerdicts)],
                },
            }}
            diff={DATA.diff}
            diffStore={createDiffViewStore({ files: DATA.diff.files })}
            threadStore={createThreadStore(threads, FILE_IDS)}
            connection="online"
            hostName="FixtureHost"
            reviewHost={options.reviewHost ?? 'fixture'}
            composerTransport={TRANSPORT}
            {...(options.draftBuffer === undefined ? {} : { draftBuffer: options.draftBuffer })}
            onPublish={() => Promise.reject(new Error('not called during static rendering'))}
            onComplete={() => undefined}
            route={options.route ?? null}
            {...(options.menu === undefined ? {} : { defaultMenuOpen: options.menu })}
        />
        </ThreadPinProvider>
        </SettingsProvider>,
    );
}

function withDraft(threads: readonly Thread[]): Thread[] {
    const first = threads[0];
    if (first === undefined) {
        throw new Error('the test needs at least one thread');
    }
    return [{ ...first, root: { ...first.root, draft: true } }, ...threads.slice(1)];
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    document.body.style.overflow = '';
});

/** Mounted bar: static markup cannot test opening a modal in a portal. */
function mountBar(): { readonly commentButton: HTMLButtonElement } {
    // Deterministic markdown layout, a plain textarea instead of ProseMirror.
    const settings = createUiSettingsStore({ initial: { composerLayout: 'markdown' } });
    const host = document.createElement('div');
    document.body.append(host);
    const threadStore = createThreadStore(DRAFT_THREADS, FILE_IDS);
    const root = createRoot(host);

    act(() => {
        root.render(
            <SettingsProvider store={settings}>
                <ReviewActionBar
                    pr={DATA.pr}
                    diff={DATA.diff}
                    diffStore={createDiffViewStore({ files: DATA.diff.files })}
                    threadStore={threadStore}
                    connection="online"
                    hostName="FixtureHost"
                    reviewHost="fixture"
                    composerTransport={TRANSPORT}
                    onPublish={() => Promise.reject(new Error('the test does not publish'))}
                    onComplete={() => undefined}
                    route={null}
                />
            </SettingsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    const commentButton = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Comment on the PR',
    );
    if (commentButton === undefined) {
        throw new Error('the bar has no PR comment button');
    }
    return { commentButton };
}

describe('PR comments modal', () => {
    it('opens a dialog from the button and returns focus to it on close', async () => {
        const { commentButton } = mountBar();

        expect(commentButton.getAttribute('aria-expanded')).toBe('false');
        expect(document.querySelector('.pr-comments-modal')).toBeNull();

        act(() => {
            commentButton.click();
        });
        const dialog = document.querySelector<HTMLElement>('.pr-comments-modal');
        expect(commentButton.getAttribute('aria-expanded')).toBe('true');
        expect(dialog?.getAttribute('role')).toBe('dialog');
        expect(dialog?.getAttribute('aria-modal')).toBe('true');
        expect(dialog?.contains(document.activeElement)).toBe(true);

        const close = document.querySelector<HTMLButtonElement>('[aria-label="Close the PR comments"]');
        await act(async () => {
            close?.click();
            await Promise.resolve();
        });

        expect(document.querySelector('.pr-comments-modal')).toBeNull();
        expect(commentButton.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(commentButton);
        expect(document.body.style.overflow).toBe('');
    });

    it('opens from outside the bar and returns focus to the triggering button', async () => {
        const { outside } = mountSharedGate();

        act(() => {
            outside.click();
        });

        expect(document.querySelector('.pr-comments-modal')).not.toBeNull();

        const close = document.querySelector<HTMLButtonElement>('[aria-label="Close the PR comments"]');
        await act(async () => {
            close?.click();
            await Promise.resolve();
        });

        expect(document.querySelector('.pr-comments-modal')).toBeNull();
        expect(document.activeElement).toBe(outside);
    });
});

/**
 * Bar with shared modal state: the Discussion card in Overview can open it too,
 * and focus must return to wherever it was opened from.
 */
function mountSharedGate(): { readonly outside: HTMLButtonElement } {
    const settings = createUiSettingsStore({ initial: { composerLayout: 'markdown' } });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    function Harness() {
        const gate = usePrCommentsGate();
        const ref = useRef<HTMLButtonElement | null>(null);
        return (
            <SettingsProvider store={settings}>
                <button
                    type="button"
                    ref={ref}
                    className="outside-opener"
                    onClick={() => {
                        gate.openModal(() => {
                            ref.current?.focus();
                        });
                    }}
                >
                    Write a PR comment
                </button>
                <ReviewActionBar
                    pr={DATA.pr}
                    diff={DATA.diff}
                    diffStore={createDiffViewStore({ files: DATA.diff.files })}
                    threadStore={createThreadStore(DRAFT_THREADS, FILE_IDS)}
                    connection="online"
                    hostName="FixtureHost"
                    reviewHost="fixture"
                    composerTransport={TRANSPORT}
                    onPublish={() => Promise.reject(new Error('the test does not publish'))}
                    onComplete={() => undefined}
                    prComments={gate}
                    route={null}
                />
            </SettingsProvider>
        );
    }

    act(() => {
        root.render(<Harness />);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    const outside = host.querySelector<HTMLButtonElement>('.outside-opener');
    if (outside === null) {
        throw new Error('the test has no external button');
    }
    return { outside };
}

/** PR publishing modes with sticky ship disabled in settings. */
const WITHOUT_STICKY: readonly Verdict[] = ['comment', 'ship', 'request_changes'];

/**
 * Mounted bar for publishing checks: publishing always succeeds by default, and `results`
 * supplies host responses in order.
 */
function mountShipBar(options: {
    readonly shipMode: UiSettings['shipMode'];
    readonly verdicts: readonly Verdict[];
    readonly menu?: boolean;
    readonly threads?: readonly Thread[];
    readonly results?: PublishResult[];
}): {
    readonly host: HTMLElement;
    readonly published: Verdict[];
    readonly shipMode: () => UiSettings['shipMode'];
} {
    const settings = createUiSettingsStore({ initial: { shipMode: options.shipMode } });
    const published: Verdict[] = [];
    const results = [...(options.results ?? [])];
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    act(() => {
        root.render(
            <SettingsProvider store={settings}>
                <ReviewActionBar
                    pr={{ ...DATA.pr, capabilities: { ...DATA.pr.capabilities, publishVerdicts: [...options.verdicts] } }}
                    diff={DATA.diff}
                    diffStore={createDiffViewStore({ files: DATA.diff.files })}
                    threadStore={createThreadStore([...(options.threads ?? [])], FILE_IDS)}
                    connection="online"
                    hostName="FixtureHost"
                    reviewHost="fixture"
                    composerTransport={TRANSPORT}
                    onPublish={(verdict) => {
                        published.push(verdict);
                        return Promise.resolve(
                            results.shift() ?? { publishedCommentIds: [], failed: [], verdictApplied: true },
                        );
                    }}
                    onComplete={() => undefined}
                    route={null}
                    defaultMenuOpen={options.menu ?? false}
                />
            </SettingsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    return { host, published, shipMode: () => settings.getSnapshot().shipMode };
}

function clickByText(host: HTMLElement, selector: string, text: string): void {
    const target = [...host.querySelectorAll<HTMLElement>(selector)].find((node) => node.textContent.includes(text));
    if (target === undefined) {
        throw new Error(`the bar has no ${selector} element with text "${text}"`);
    }
    act(() => {
        target.click();
    });
}

describe('global ship mode', () => {
    it('publishing with a fallback mode preserves the reviewer choice', async () => {
        // Settings request sticky, but this PR has none: the button publishes ship without choosing it.
        const bar = mountShipBar({ shipMode: 'sticky_ship', verdicts: WITHOUT_STICKY });

        clickByText(bar.host, '.review-action-bar__ship-primary', 'Ship');
        await act(async () => {
            await Promise.resolve();
        });

        expect(bar.published).toEqual(['ship']);
        expect(bar.shipMode()).toBe('sticky_ship');
    });

    it('remembers an explicit mode selection in the menu', async () => {
        const bar = mountShipBar({ shipMode: 'ship', verdicts: DATA.pr.capabilities.publishVerdicts, menu: true });

        clickByText(bar.host, '.review-action-menu__option', 'Sticky ship');
        await act(async () => {
            await Promise.resolve();
        });

        expect(bar.published).toEqual(['sticky_ship']);
        expect(bar.shipMode()).toBe('sticky_ship');
    });
});

describe('publishing without a verdict', () => {
    it('publishes comment from the Comment menu row and remembers the mode', async () => {
        const bar = mountShipBar({
            shipMode: 'ship',
            verdicts: DATA.pr.capabilities.publishVerdicts,
            threads: DRAFT_THREADS,
            menu: true,
        });

        clickByText(bar.host, '.review-action-menu__option', 'Comment');
        await act(async () => {
            await Promise.resolve();
        });

        expect(bar.published).toEqual(['comment']);
        expect(bar.shipMode()).toBe('comment');
    });

    it('shows saved Comment as the primary part with a caret', async () => {
        const bar = mountShipBar({ shipMode: 'comment', verdicts: DATA.pr.capabilities.publishVerdicts, threads: DRAFT_THREADS });

        expect(bar.host.querySelector('.review-action-bar__ship-caret')).not.toBeNull();
        clickByText(bar.host, '.review-action-bar__ship-primary', 'Comment');
        await act(async () => {
            await Promise.resolve();
        });

        expect(bar.published).toEqual(['comment']);
    });

    it('navigates all 3 menu rows by keyboard and ignores Enter on a disabled row', async () => {
        const bar = mountShipBar({ shipMode: 'ship', verdicts: WITHOUT_STICKY, threads: [], menu: true });
        const menu = bar.host.querySelector<HTMLElement>('.review-action-menu');
        if (menu === null) {
            throw new Error('the menu is not open');
        }
        const press = (key: string): void => {
            act(() => {
                menu.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
            });
        };

        press('ArrowDown');
        press('ArrowDown');
        press('ArrowDown');
        expect(menu.getAttribute('aria-activedescendant')).toBe('review-ship-option-2');
        // Comment is disabled without drafts.
        press('Enter');
        press('ArrowUp');
        // Sticky ship is disabled when the host modes exclude it.
        press('Enter');
        await act(async () => {
            await Promise.resolve();
        });
        expect(bar.published).toEqual([]);

        press('ArrowUp');
        press('Enter');
        await act(async () => {
            await Promise.resolve();
        });
        expect(bar.published).toEqual(['ship']);
    });

    it('shows Comment without a caret for one mode and does not save the selection', async () => {
        const bar = mountShipBar({ shipMode: 'ship', verdicts: ['comment'], threads: DRAFT_THREADS });

        expect(bar.host.querySelector('.review-action-bar__ship-caret')).toBeNull();
        clickByText(bar.host, '.review-action-bar__ship-primary', 'Comment');
        await act(async () => {
            await Promise.resolve();
        });

        expect(bar.published).toEqual(['comment']);
        expect(bar.shipMode()).toBe('ship');
    });

    it('retries the same comment after a failure', async () => {
        const bar = mountShipBar({
            shipMode: 'ship',
            verdicts: ['comment'],
            threads: DRAFT_THREADS,
            results: [
                { publishedCommentIds: [], failed: [{ commentId: 'draft-1', message: 'host refused' }], verdictApplied: false },
            ],
        });

        clickByText(bar.host, '.review-action-bar__ship-primary', 'Comment');
        await act(async () => {
            await Promise.resolve();
        });
        clickByText(bar.host, '.review-action-error__summary button', 'retry');
        await act(async () => {
            await Promise.resolve();
        });

        expect(bar.published).toEqual(['comment', 'comment']);
    });
});

describe('floating bar mount condition', () => {
    const base = {
        completed: false,
        reviewHost: 'fixture',
        pr: DATA.pr,
    } as const;

    it('mounts only with usable data in any view', () => {
        expect(reviewActionBarVisible({ ...base, dataReady: false })).toBe(false);
        expect(reviewActionBarVisible({ ...base, dataReady: true })).toBe(true);
    });

    it('hides the bar after review completion or without a PR or host', () => {
        expect(reviewActionBarVisible({ ...base, dataReady: true, completed: true })).toBe(false);
        expect(reviewActionBarVisible({ ...base, dataReady: true, reviewHost: null })).toBe(false);
        expect(reviewActionBarVisible({ ...base, dataReady: true, pr: null })).toBe(false);
    });
});

describe('floating review bar', () => {
    it('shows a live draft counter and the count on all final action buttons', () => {
        const drafts = countDraftComments(DRAFT_THREADS);
        expect(drafts).toBeGreaterThan(0);

        const html = renderBar();

        expect(html).toContain(`${String(drafts)} draft`);
        expect(html).toContain(`Request changes · ${String(drafts)}`);
        expect(html).toContain(`Ship · ${String(drafts)}`);
        // There is no separate publish-without-verdict button: Comment is a Ship menu mode.
        expect(html).not.toContain('>Publish');
        expect(html).not.toContain('Comment ·');
    });

    it('shows one Comment button without a caret or verdicts in comments-only mode', () => {
        const html = renderBar({ verdicts: ['comment'] });

        expect(html).toMatch(
            /<button[^>]*class="ctl ctl--primary review-action-bar__ship-primary"[^>]*title="Publishes 1 draft without a verdict"[^>]*>Comment · 1<\/button>/,
        );
        expect(html).not.toContain('Request changes');
        expect(html).not.toContain('review-action-bar__ship-caret');
        expect(html).not.toContain('ic-thumb');
    });

    it('disables Comment with a reason in comments-only mode without drafts', () => {
        const html = renderBar({ threads: [], verdicts: ['comment'] });

        expect(html).toMatch(/<button[^>]*review-action-bar__ship-primary"[^>]*disabled=""[^>]*title="no unpublished comments"/);
        expect(html).toContain('>Comment</button>');
    });

    it('disables the primary part for saved Comment without drafts and keeps the caret enabled', () => {
        const html = renderBar({ threads: [], shipMode: 'comment' });

        expect(html).toMatch(/<button[^>]*review-action-bar__ship-primary"[^>]*disabled=""[^>]*title="no unpublished comments"/);
        expect(html).toMatch(/<button[^>]*review-action-bar__ship-caret"(?![^>]*disabled)[^>]*>/);
    });

    it('falls back to ship when the saved sticky mode is unavailable on the PR', () => {
        const html = renderBar({ shipMode: 'sticky_ship', verdicts: WITHOUT_STICKY });

        expect(html).toContain(`>Ship · ${String(countDraftComments(DRAFT_THREADS))}</button>`);
    });

    it('omits Request changes when the modes exclude request_changes and keeps ship', () => {
        const html = renderBar({ verdicts: ['comment', 'ship'] });

        expect(html).not.toContain('Request changes');
        expect(html).toContain('review-action-bar__ship-primary');
        expect(html).toContain('review-action-bar__ship-caret');
    });

    it('falls back to ship when the modes exclude the saved Comment', () => {
        const html = renderBar({ shipMode: 'comment', verdicts: ['ship', 'request_changes'] });

        expect(html).toContain(`>Ship · ${String(countDraftComments(DRAFT_THREADS))}</button>`);
        expect(html).not.toContain('review-action-bar__ship-caret');
    });

    it('omits the split button when it has no modes and keeps Request changes', () => {
        const html = renderBar({ verdicts: ['request_changes'] });

        expect(html).not.toContain('review-action-bar__ship-primary');
        expect(html).toContain('Request changes');
    });

    it('sends local review drafts to the agent', () => {
        const html = renderBar({ verdicts: ['comment'], reviewHost: 'local-git' });

        expect(html).toContain('1 draft goes to the agent');
        expect(html).toContain('title="Hands 1 draft to the agent"');
        expect(html).not.toContain('when you publish');
    });

    it('shows no comments for the agent in local review without drafts', () => {
        const html = renderBar({ threads: [], verdicts: ['comment'], reviewHost: 'local-git' });

        expect(html).toContain('<span class="review-action-bar__no-drafts">no comments for the agent</span>');
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="no comments for the agent"/);
    });

    it('shows neutral text with zero drafts', () => {
        const html = renderBar({ threads: [] });

        expect(html).toContain('no unpublished comments');
        expect(html).not.toContain('go out when you publish');
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

        expect(renderBar({ threads })).toContain('21 drafts go out when you publish');
    });

    // The draft counter suffix shows how many drafts open an issue (SPEC-changes-2026-09-20 §1).
    it('appends the issue count to the draft counter', () => {
        const source = DRAFT_THREADS[0];
        if (source === undefined) {
            throw new Error('the test needs a thread');
        }
        const threads = [0, 1].map((index) => ({
            ...source,
            id: `issue-thread-${String(index)}`,
            root: { ...source.root, id: `issue-draft-${String(index)}`, draft: true, issue: true },
        }));

        expect(renderBar({ threads })).toContain('· 2 issues');
    });

    it('omits the suffix without issue drafts', () => {
        expect(renderBar()).not.toContain('issue');
    });

    it('counts issues in buffered drafts too', () => {
        const html = renderBar({
            threads: [],
            draftBuffer: [{ ...BUFFERED, draft: { ...BUFFERED.draft, issue: true } }],
        });

        expect(html).toContain('· 1 issue');
    });

    // Buffered drafts count in the batch and block ship until they arrive.
    it('counts buffered drafts and blocks ship with a reason', () => {
        const drafts = countDraftComments(DRAFT_THREADS);

        const html = renderBar({ draftBuffer: [BUFFERED] });

        expect(html).toContain(`${String(drafts + 1)} draft`);
        expect(html).toContain('1 not sent yet');
        expect(html).toContain('1 draft is not sent yet — ship is blocked until it is');
        expect(html).toContain('class="ctl ctl--primary review-action-bar__ship-primary" disabled=""');
    });

    // The edit belongs to a draft already counted in the threads, so it adds no second draft
    // to the batch, but blocks ship just like a create operation.
    it('does not double the draft count for a buffered edit but blocks ship', () => {
        const drafts = countDraftComments(DRAFT_THREADS);

        const html = renderBar({ draftBuffer: [{ ...BUFFERED, commentId: 'draft-1' }] });

        expect(html).toContain(`${String(drafts)} draft`);
        expect(html).toContain('1 not sent yet');
        expect(html).toContain('ship is blocked until it is');
    });

    // The unresolved thread counter was removed from the bar: it asked for no action and did not block publishing.
    it('omits unresolved thread text and does not disable ship for those threads', () => {
        expect(DRAFT_THREADS.filter((thread) => !thread.resolved).length).toBeGreaterThan(0);

        expect(renderBar()).not.toContain('unresolved');
        expect(renderBar()).not.toContain('review-action-bar__ship-primary" disabled');
    });

    it('shows Ship, Sticky ship and Comment with their consequences in the menu', () => {
        const html = renderBar({ menu: true });

        expect(html.indexOf('<strong>Ship</strong>')).toBeLessThan(html.indexOf('<strong>Sticky ship</strong>'));
        expect(html.indexOf('<strong>Sticky ship</strong>')).toBeLessThan(html.indexOf('<strong>Comment</strong>'));
        expect(html).toContain('id="review-ship-option-2"');
        expect(html).toContain('<span>Publishes 1 draft without a verdict</span>');
    });

    it('disables the Comment menu row with a reason when there are no drafts', () => {
        const html = renderBar({ menu: true, threads: [] });

        expect(html).toMatch(
            /id="review-ship-option-2"[^>]*aria-disabled="true"[^>]*title="no unpublished comments"/,
        );
    });

    it('shows a non-blocking warning, exact consequences and a reason for disabled sticky in the menu', () => {
        const html = renderBar({ menu: true, verdicts: WITHOUT_STICKY });

        expect(html).toContain('ship anyway?');
        expect(html).toContain('Approves this snapshot only. A new push drops the approval and asks again.');
        // The copy is accurate: there is no ownership-zone revocation, only the host's ordinary sticky ship (№36).
        expect(html).toContain('The approval carries over to later pushes — the host’s own sticky ship.');
        expect(html).not.toContain('CODEOWNERS zone');
        expect(html).toContain('Sticky ship is unavailable here.');
        expect(html).toContain('aria-disabled="true"');
    });

    it('counts stops in the warning when the route is ready', () => {
        const route = {
            stopIds: ['s01', 's02', 's03'],
            otherStopId: 's03',
            uncoveredLines: 34,
            viewed: new Map([['s01', true]]),
        };

        const html = renderBar({ menu: true, route });

        expect(html).toContain('2 stops not viewed — ship anyway?');
        expect(html).not.toContain('files not viewed');
    });

    it('omits the warning when all stops are viewed', () => {
        const route = {
            stopIds: ['s01', 's02'],
            otherStopId: null,
            uncoveredLines: 0,
            viewed: new Map([
                ['s01', true],
                ['s02', true],
            ]),
        };

        const html = renderBar({ menu: true, route });

        expect(html).not.toContain('ship anyway?');
    });

    it('keeps the file-based warning without a route', () => {
        const html = renderBar({ menu: true });

        expect(html).toContain('files not viewed — ship anyway?');
    });

    it('hides only while the diff store has an active drag selection', () => {
        const diffStore = createDiffViewStore({ files: DATA.diff.files });
        diffStore.beginSelection();
        diffStore.startSelection(DATA.diff.files[0]?.fileId ?? 'file', 'a1');
        const props = {
            pr: DATA.pr,
            diff: DATA.diff,
            diffStore,
            threadStore: createThreadStore(DRAFT_THREADS, FILE_IDS),
            connection: 'online' as const,
            hostName: 'FixtureHost',
            reviewHost: 'fixture',
            composerTransport: TRANSPORT,
            onPublish: () => Promise.reject(new Error('not called during static rendering')),
            onComplete: () => undefined,
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
                diffStore={createDiffViewStore({ files: DATA.diff.files })}
                threadStore={createThreadStore(DRAFT_THREADS, FILE_IDS)}
                connection="online"
                hostName="FixtureHost"
                reviewHost="fixture"
                composerTransport={TRANSPORT}
                onPublish={() => Promise.reject(new Error('not called during static rendering'))}
                onComplete={() => undefined}
                initialFailure={{
                    verdict: 'ship',
                    failedCount: 1,
                    message: null,
                    comments: [{ commentId: 'bad', body: 'Fix the boundary check', message: 'host refused' }],
                }}
            />,
        );

        expect(html).toContain('1 comment failed to publish');
        expect(html).toContain('Fix the boundary check');
        expect(html).toContain('host refused');
        expect(html).toContain('<button type="button" class="ctl ctl--link-muted">retry</button>');
        expect(html).not.toContain('Request changes');
    });
});

describe('Review complete screen', () => {
    it('renders counters and an amber footer for open threads', () => {
        const html = renderToStaticMarkup(
            <ReviewComplete
                completion={{
                    verdict: 'sticky_ship',
                    prId: '4821',
                    headCommit: '9f3c1ab012345',
                    hostName: 'GitHub',
                    reviewHost: 'github',
                    publishedComments: 2,
                    publishedReplies: 1,
                    progress: {
                        filesSeen: 17,
                        filesTotal: 18,
                        linesSeen: 800,
                        linesTotal: 862,
                        percentSeen: 92,
                    },
                    route: null,
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
        expect(html).toContain('1 thread is still open — that does not block the ship');
        expect(html).toContain('Snapshot signed');
        expect(html).toContain('To the full diff');
        // Without a route, the card has no rows about stops.
        expect(html).not.toContain('Stops viewed');
        expect(html).not.toContain('outside the route');
    });

    it('shows Comments published and comment provenance when publishing without a verdict', () => {
        const html = renderToStaticMarkup(
            <ReviewComplete
                completion={{
                    verdict: 'comment',
                    prId: '42',
                    headCommit: '9f3c1ab012345',
                    hostName: 'GitHub',
                    reviewHost: 'github',
                    publishedComments: 2,
                    publishedReplies: 0,
                    progress: { filesSeen: 3, filesTotal: 5, linesSeen: 40, linesTotal: 90, percentSeen: 44 },
                    route: null,
                    openThreads: 2,
                    firstOpenThreadId: 'thread-1',
                }}
                onOpenThread={() => undefined}
                onOpenFullDiff={() => undefined}
            />,
        );

        expect(html).toContain('Comments published · PR 42');
        expect(html).toContain('comment · 9f3c1ab');
        expect(html).toContain('delivered to GitHub');
        // There was no ship and no snapshot was signed, so there is no ship-related or signed-snapshot copy.
        expect(html).toContain('2 threads are still open');
        expect(html).not.toContain('the ship');
        expect(html).toContain('Snapshot reviewed');
        expect(html).not.toContain('signed');
    });

    it('sends local review comments to the agent', () => {
        const html = renderToStaticMarkup(
            <ReviewComplete
                completion={{
                    verdict: 'request_changes',
                    prId: 'local-git-app-0badc0de',
                    headCommit: '9f3c1ab012345',
                    hostName: 'local checkout',
                    reviewHost: 'local-git',
                    publishedComments: 1,
                    publishedReplies: 0,
                    progress: {
                        filesSeen: 1,
                        filesTotal: 1,
                        linesSeen: 10,
                        linesTotal: 10,
                        percentSeen: 100,
                    },
                    route: null,
                    openThreads: 0,
                    firstOpenThreadId: null,
                }}
                onOpenThread={() => undefined}
                onOpenFullDiff={() => undefined}
            />,
        );

        expect(html).toContain('handed to the agent');
        expect(html).not.toContain('delivered to');
    });

    it('shows stops, Other and lines read outside the route when a route exists', () => {
        const html = renderToStaticMarkup(
            <ReviewComplete
                completion={{
                    verdict: 'ship',
                    prId: '4821',
                    headCommit: '9f3c1ab012345',
                    hostName: 'GitHub',
                    reviewHost: 'github',
                    publishedComments: 2,
                    publishedReplies: 1,
                    progress: {
                        filesSeen: 18,
                        filesTotal: 18,
                        linesSeen: 862,
                        linesTotal: 862,
                        percentSeen: 100,
                    },
                    route: { stopsTotal: 7, stopsViewed: 7, otherViewed: true, uncoveredLines: 34 },
                    openThreads: 0,
                    firstOpenThreadId: null,
                }}
                onOpenThread={() => undefined}
                onOpenFullDiff={() => undefined}
            />,
        );

        expect(html).toContain('7 of 7 · Other read as a raw diff');
        expect(html).toContain('100% of 862 lines');
        expect(html).toContain('34 lines the model did not place');
        // The route counter replaces the file counter.
        expect(html).not.toContain('Files seen');
    });

    it('omits the second clause when Other is unread', () => {
        const html = renderToStaticMarkup(
            <ReviewComplete
                completion={{
                    verdict: 'ship',
                    prId: '4821',
                    headCommit: '9f3c1ab012345',
                    hostName: 'GitHub',
                    reviewHost: 'github',
                    publishedComments: 0,
                    publishedReplies: 0,
                    progress: {
                        filesSeen: 10,
                        filesTotal: 18,
                        linesSeen: 500,
                        linesTotal: 862,
                        percentSeen: 58,
                    },
                    route: { stopsTotal: 7, stopsViewed: 5, otherViewed: false, uncoveredLines: 34 },
                    openThreads: 0,
                    firstOpenThreadId: null,
                }}
                onOpenThread={() => undefined}
                onOpenFullDiff={() => undefined}
            />,
        );

        expect(html).toContain('5 of 7');
        expect(html).not.toContain('Other read as a raw diff');
        // "Of that, read outside the route" counts seen lines: without the Other mark there is no row.
        expect(html).not.toContain('outside the route');
    });
});

describe('drafts written before a push', () => {
    const V2 = fixtureIteration('medium', 1);

    it('counts drafts in threads pinned to previous commits as a separate note', () => {
        const pinned = V2.threads.find((thread) => thread.pinnedTo !== null && thread.anchor !== null);
        if (pinned === undefined) {
            throw new Error('the medium fixture needs a pinned thread');
        }
        const threads = [{ ...pinned, root: { ...pinned.root, draft: true } }];

        const html = renderBar({ threads, activeDiffId: V2.diff.diffId });

        expect(html).toContain('1 is pinned to earlier commits');
    });

    it('omits the note when the pin matches the active iteration', () => {
        const pinned = V2.threads.find((thread) => thread.pinnedTo !== null && thread.anchor !== null);
        if (pinned?.pinnedTo == null) {
            throw new Error('the medium fixture needs a pinned thread');
        }
        const threads = [{ ...pinned, root: { ...pinned.root, draft: true } }];

        const html = renderBar({ threads, activeDiffId: pinned.pinnedTo.diffId });

        expect(html).not.toContain('pinned to earlier commits');
    });
});
