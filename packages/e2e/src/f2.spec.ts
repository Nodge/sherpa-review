import type { Locator, Page } from '@playwright/test';
import type { FixtureData } from '@sherpa/fixtures';
import { fixtureData } from '@sherpa/fixtures';

import { answerChat, buildRoute, takeTask } from './route-worker.js';
import type { SherpaServerHandle } from './sherpa-fixture.js';
import { expect, test } from './sherpa-fixture.js';

/**
 * F2 (brief §7): with a completed route, the reviewer selects lines, asks the agent about them, receives
 * an answer in the panel and a note at the same lines, turns the note into a blocking draft and requests
 * changes to the PR.
 *
 * The agent uses the same CLI bundle as in F1. It submits the chat answer as Markdown text instead of route JSON.
 */

/** The first code stop in the full tour: a single file, with lines 1–14 added in full. */
const STOP = 's01';
const FILE = 'edit-window.ts';
const ANCHOR = `${FILE}:3–5`;
const QUESTION = 'Why is the editing window calculated here?';
const PROGRESS = 'Reading edit-window.ts and nearby calls';
const ANSWER = [
    'The editing window is built from the order settings and the current time. The class receives its time source',
    'through the constructor, so tests can replace it, while production uses the system clock.',
    '',
    'Check 3 things in this range:',
    '',
    '- bounds are calculated in UTC and displayed in the user timezone.',
    '- a check higher up the stack rejects zero duration.',
    '- the lower bound is inclusive.',
    '',
    'The PR has no test for crossing midnight. It makes sense to ask the author for one.',
].join('\n');
/** The answer list shows that the panel renders Markdown instead of raw text. */
const ANSWER_ITEMS = [
    'bounds are calculated in UTC and displayed in the user timezone.',
    'a check higher up the stack rejects zero duration.',
    'the lower bound is inclusive.',
];
const DRAFT_TAIL = 'E2E F2: this cannot be merged without a test for crossing midnight.';
/** The fixture's "me": the author of drafts the reviewer saves and publishes. */
const ME = fixtureData('medium').currentUser.login;

test('F2: selection → agent question → answer and note → draft → request changes', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    await test.step('route built, reviewer takes the full tour', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Route', exact: true }).click();
        expect((await worker.register('claude-code')).code).toBe(0);
        await buildRoute(worker);

        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await page.keyboard.press('t');
        await expect(page.getByRole('button', { name: 'Full tour', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(card(page).locator('.file-card__name')).toHaveText(FILE);
    });

    await test.step('dragging the gutter selects 3 lines, the popover calls the agent', async () => {
        await dragSelectLines(page, 'a3', 'a5');

        await expect(page.locator('.selection-popover__count')).toHaveText('3 lines selected');
        await page.getByRole('button', { name: 'Ask the agent', exact: true }).click();

        await expect(page.locator('.chat-panel')).toBeVisible();
        // The range moved into the composer as a chip. The basename is visible, the full path is in title.
        await expect(page.locator('.chat-panel__context--anchor')).toHaveAttribute('title', new RegExp(`/${ANCHOR}$`));
        await expect(page.locator('.chat-panel__context-label')).toHaveText(ANCHOR);
    });

    await test.step('⏎ sends the question: message with anchor, popover and pill show it in flight', async () => {
        const question = page.getByRole('textbox', { name: 'Question to the agent' });
        await expect(question).toBeFocused();
        await question.pressSequentially(QUESTION);
        await question.press('Enter');

        await expect(page.locator('.chat-message--you .chat-message__body')).toHaveText(QUESTION);
        await expect(page.locator('.chat-message__anchor')).toHaveText(`↳ ${ANCHOR}`);
        await expect(page.locator('.selection-popover--chip')).toHaveText('asked · the answer will land here');
        await expect(page.locator('.agent-pill__label')).toHaveText('Agent working · 1 in queue');
    });

    await test.step('agent claims the chat task, progress line is visible in the panel', async () => {
        const chat = await takeTask(worker, 'chat');
        expect((await worker.progress(chat.taskId, PROGRESS)).code).toBe(0);
        await expect(page.locator('.chat-message__progress')).toHaveText(PROGRESS);

        await answerChat(worker, chat.taskId, ANSWER);
    });

    await test.step('answer rendered as Markdown, pinned as a note at the same lines', async () => {
        const answer = page.locator('.chat-message--agent .chat-message__body');
        await expect(answer.locator('li')).toHaveText(ANSWER_ITEMS);
        await expect(answer.locator('p')).toHaveCount(3);
        await expect(page.locator('.chat-message__note')).toHaveText(`◆ Pinned by a note at ${ANCHOR}`);
        await expect(page.locator('.chat-panel__notes')).toHaveText('Notes 1');

        await expectNoteAtLines(page);
    });

    await test.step('note and history survive reload, the pill opens the panel', async () => {
        await page.reload();

        await expectNoteAtLines(page);
        await expect(page.locator('.chat-panel')).toHaveCount(0);
        await page.locator('.agent-pill').click();
        await expect(page.locator('.chat-message--you .chat-message__body')).toHaveText(QUESTION);
        // The answer comes from the exchange, not the note. The note has its own copy of the text.
        await expect(page.locator('.chat-message--agent .chat-message__body li')).toHaveText(ANSWER_ITEMS);
        await expect(page.locator('.chat-panel__notes')).toHaveText('Notes 1');
    });

    await test.step('"Turn into a comment draft": composer at the same lines with a quote and issue', async () => {
        await card(page).getByRole('button', { name: 'Turn into a comment draft', exact: true }).click();

        const composer = card(page).locator('.thread-composer');
        await expect(composer.locator('.thread-composer__context')).toContainText('new comment · lines 3–5');
        await expect(composer.locator('.thread__chip--draft')).toHaveText('draft · publishes on ship');

        await expect(composer).toContainText('Quoted from the agent’s answer:');
        await expect(composer).toContainText('The editing window is built from the order settings');

        // The Markdown layout of the same composer lets the reviewer write below the quote without parsing it by hand.
        await composer.getByRole('button', { name: 'Markdown', exact: true }).click();
        const input = composer.getByRole('textbox', { name: 'New comment' });
        const quoted = await input.inputValue();
        expect(quoted.startsWith('Quoted from the agent’s answer:')).toBe(true);
        expect(quoted).toContain('> The editing window is built from the order settings');
        await input.fill(`${quoted}\n\n${DRAFT_TAIL}`);

        // The fixture host supports issue, so a new comment is blocking by default.
        await expect(composer.getByRole('button', { name: 'Open an issue' })).toHaveAttribute('aria-pressed', 'true');
        await composer.getByRole('button', { name: 'Save draft', exact: true }).click();
        await expect(input).toHaveCount(0);
    });

    await test.step('draft saved as blocking, note still present', async () => {
        await expect(card(page).getByText(DRAFT_TAIL, { exact: true })).toBeVisible();
        await expect(card(page).locator('.thread__chip--draft')).toHaveText('draft · publishes on ship');
        await expect(page.locator('.review-action-bar')).toContainText('1 draft goes out on ship');
        await expect(card(page).locator('.agent-note--expanded')).toHaveCount(1);
        await expect(page.locator('.chat-panel__notes')).toHaveText('Notes 1');

        // The UI does not show whether a comment is blocking, so read it from the contract.
        const saved = await myComments(page, server);
        expect(saved.map((comment) => ({ draft: comment.draft, issue: comment.issue }))).toEqual([
            { draft: true, issue: true },
        ]);
        expect(saved[0]?.body).toContain(DRAFT_TAIL);
    });

    await test.step('request changes publishes one blocking comment, the note stays out of the host', async () => {
        await page.getByRole('button', { name: /^Request changes/ }).click();

        await expect(page.getByRole('heading', { name: 'Changes requested · PR 4821', exact: true })).toBeVisible();
        // Exactly one comment is published, the agent note lives only in Sherpa (SPEC §2.16).
        await expect(counter(page, 'Comments published')).toHaveText('1 (0 of them replies)');

        // The same comment at the host is no longer a draft, and issue survived publication.
        const published = await myComments(page, server);
        expect(published.map((comment) => ({ draft: comment.draft, issue: comment.issue }))).toEqual([
            { draft: false, issue: true },
        ]);
    });
});

/**
 * Drag the line gutter with the mouse, using the same event path as the reviewer: mousedown on the line
 * number, mousemove with the button held to the final line, mouseup. Mouse events over code belong to
 * native text selection, so the drag must start in the gutter (`file-card.tsx`).
 */
async function dragSelectLines(page: Page, fromKey: string, toKey: string): Promise<void> {
    const gutter = (key: string): Locator =>
        card(page).locator(`.diff-row[data-key="${key}"] .diff-row__gutter`).first();
    await gutter(fromKey).scrollIntoViewIfNeeded();
    const from = await gutter(fromKey).boundingBox();
    const to = await gutter(toKey).boundingBox();
    if (from === null || to === null) {
        throw new Error(`lines ${fromKey}–${toKey} are not rendered`);
    }

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
    await page.mouse.up();
}

/** A note at its range: clicking the collapsed row expands it and names the same lines. */
async function expectNoteAtLines(page: Page): Promise<void> {
    const collapsed = card(page).locator('.agent-note--collapsed');
    await expect(collapsed).toContainText('Agent note');
    await collapsed.click();
    await expect(card(page).locator('.agent-note--expanded .agent-note__header')).toContainText(
        'Agent note · asked at lines 3–5',
    );
}

type HostThread = FixtureData['threads'][number];
type HostComment = HostThread['root'];

/**
 * Reviewer comments straight from the review contract (`GET review/threads`): the UI does not show the issue flag
 * or "draft/published" state, but the host stores them. The server token is in the fragment of the
 * URL printed by `sherpa up`. The UI uses the same token.
 */
async function myComments(page: Page, server: SherpaServerHandle): Promise<readonly HostComment[]> {
    const url = new URL(server.url);
    const token = new URLSearchParams(url.hash.slice(1)).get('t') ?? '';
    const response = await page.request.get(new URL('/api/ui/review/threads', url.origin).href, {
        headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as { readonly threads: readonly HostThread[] };
    return body.threads
        .flatMap((thread) => flattenComments(thread.root))
        .filter((comment) => comment.author.login === ME);
}

function flattenComments(comment: HostComment): HostComment[] {
    return [comment, ...comment.replies.flatMap((reply) => flattenComments(reply))];
}

function stop(page: Page): Locator {
    return page.locator(`[data-stop="${STOP}"]`);
}

/** The target file card: a stop has several cards, and their row `data-key` values repeat. */
function card(page: Page): Locator {
    return stop(page)
        .locator('.file-card')
        .filter({ has: page.locator('.file-card__name', { hasText: FILE }) });
}

function counter(page: Page, label: string): Locator {
    return page.locator('.review-complete__counter').filter({ hasText: label }).locator('dd');
}
