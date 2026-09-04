import type { Locator, Page } from '@playwright/test';

import {
    answerChat,
    buildRoute,
    fillSections,
    mediumRawResults,
    sectionFor,
    submit,
    takeTask,
} from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

/**
 * M3 DoD: the queue behaves honestly. A question asked during route generation waits
 * exactly one step in the queue. The worker sees it after submitting the current section, and the UI shows this
 * with a panel banner and queue length in the pill (rpc-design §5, README "Agent queue is honest").
 *
 * The second test cancels an exchange in flight. The exchange stops, but the UI says the worker still holds
 * the cancelled task until it checks in. A late `complete` does not revive the exchange, and "Retry"
 * queues a new task.
 */

const QUEUE_QUESTION = 'What breaks in this PR if the migration is rolled back?';
const QUEUE_ANSWER = [
    'Rolling back the migration removes the column with the window bounds, but the code reads it without a null check.',
    'The very first request after rollback fails while parsing the row, not during the migration itself.',
    '',
    'The safe rollback order is:',
    '',
    '- first disable the editing window with the flag.',
    '- then remove the column.',
].join('\n');
const CANCEL_QUESTION = 'What could break here on resubmission?';
const LATE_ANSWER = 'A late answer to a cancelled question. Nobody is waiting for it anymore.';
const RETRY_ANSWER = 'An idempotency key protects resubmission, so no second record is created.';

test('F2 queue: a question during generation waits one step, the UI shows the queue', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    const section = await test.step('plan submitted, worker holds the first section', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Route', exact: true }).click();
        expect((await worker.register('claude-code')).code).toBe(0);

        const skeleton = await takeTask(worker, 'route.skeleton');
        await submit(worker, skeleton.taskId, mediumRawResults().skeleton);
        await expect(page.locator('.route-skeleton-card')).toHaveCount(6);

        // The lease stays open until the end of the step, exactly when the reviewer asks a question.
        const held = await takeTask(worker, 'route.section');
        // 6 sections queued at once. One is leased, 5 are waiting.
        await expect(pillLabel(page)).toHaveText('Agent working · 6 in queue');
        return held;
    });

    await test.step('question joins the queue: route banner and +1 in the pill', async () => {
        await page.locator('.agent-pill').click();
        await expect(page.locator('.chat-panel')).toBeVisible();

        const question = page.getByRole('textbox', { name: 'Question to the agent' });
        await question.click();
        await question.pressSequentially(QUEUE_QUESTION);
        await question.press('Enter');

        await expect(page.locator('.chat-message--you .chat-message__body')).toHaveText(QUEUE_QUESTION);
        await expect(page.locator('.chat-panel__queue')).toHaveText('Generating the route · your question is next');
        // 5 unclaimed sections + the worker lease + the question itself.
        await expect(pillLabel(page)).toHaveText('Agent working · 7 in queue');
        // While the exchange is queued, there is no answer message in the chat at all.
        await expect(page.locator('.chat-message--agent')).toHaveCount(0);
    });

    await test.step('section submitted, the next worker task is chat before the remaining route', async () => {
        await submit(worker, section.taskId, sectionFor(section.planIndexes));

        // The central queue check: 5 route.section tasks are still queued, but interactive goes first.
        const chat = await takeTask(worker, 'chat');
        await expect(page.locator('.chat-panel__queue')).toHaveCount(0);
        await expect(page.locator('.chat-message--agent .chat-message__activity')).toContainText('Answering');

        await answerChat(worker, chat.taskId, QUEUE_ANSWER);
    });

    await test.step('answer in the panel, no note because the question had no anchor', async () => {
        const answer = page.locator('.chat-message--agent .chat-message__body');
        await expect(answer.locator('li')).toHaveText([
            'first disable the editing window with the flag.',
            'then remove the column.',
        ]);
        await expect(page.locator('.chat-message__note')).toHaveCount(0);
        await expect(page.locator('.chat-panel__notes')).toHaveCount(0);
        await expect(page.locator('.agent-note--collapsed')).toHaveCount(0);
    });

    await test.step('remaining sections finish the route', async () => {
        await fillSections(worker, 5);

        await expect(page.locator('.coverage__legend-text')).toHaveText(
            '866 changed lines · 95% explained · 38 lines not explained',
        );
        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
    });
});

test('F2 queue: cancellation stops the exchange in flight, a late answer is a no-op, Retry gets an answer', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    await test.step('route ready, worker has claimed the question', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Route', exact: true }).click();
        expect((await worker.register('claude-code')).code).toBe(0);
        await buildRoute(worker);
        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);

        await page.locator('.agent-pill').click();
        const question = page.getByRole('textbox', { name: 'Question to the agent' });
        await question.click();
        await question.pressSequentially(CANCEL_QUESTION);
        await question.press('Enter');
    });

    const cancelled = await test.step('"Stop" cancels the exchange', async () => {
        const chat = await takeTask(worker, 'chat');
        await page.getByRole('button', { name: 'Stop', exact: true }).click();

        await expect(page.locator('.chat-message--failed .chat-message__body')).toHaveText('Question cancelled.');
        await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();

        // The task is cancelled, but the worker does not know yet. It still holds the lease (rpc-design §5).
        await expect(page.locator('.chat-panel__cancelled-lease')).toHaveText(
            'The agent is still busy with the cancelled task — it learns about the cancel on its next call',
        );
        await expect(pillLabel(page)).toHaveText('Agent working · 1 in queue');
        return chat;
    });

    await test.step('late complete of a cancelled task is a no-op for both server and chat', async () => {
        const late = await worker.complete(cancelled.taskId, LATE_ANSWER);
        expect(late.code, late.stderr).toBe(0);
        expect(late.stdout).toContain('has been cancelled');

        // The worker checked in, the hold is released, and the agent is free again.
        await expect(page.locator('.chat-panel__cancelled-lease')).toHaveCount(0);
        await expect(pillLabel(page)).not.toHaveText(/Agent working/);
        await expect(page.locator('.chat-message--failed .chat-message__body')).toHaveText('Question cancelled.');
        await expect(page.getByText(LATE_ANSWER, { exact: true })).toHaveCount(0);
    });

    await test.step('"Retry" queues a new chat task and the answer arrives', async () => {
        await page.getByRole('button', { name: 'Retry', exact: true }).click();

        const retried = await takeTask(worker, 'chat');
        expect(retried.taskId).not.toBe(cancelled.taskId);
        await answerChat(worker, retried.taskId, RETRY_ANSWER);

        // There is one exchange. "Retry" reopens it instead of creating a second question.
        await expect(page.locator('.chat-message--you .chat-message__body')).toHaveText(CANCEL_QUESTION);
        await expect(page.locator('.chat-message--agent .chat-message__body')).toHaveText(RETRY_ANSWER);
        await expect(page.getByText(LATE_ANSWER, { exact: true })).toHaveCount(0);
    });
});

function pillLabel(page: Page): Locator {
    return page.locator('.agent-pill__label');
}
