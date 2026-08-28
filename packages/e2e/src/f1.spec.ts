import type { Locator, Page } from '@playwright/test';

import { asRawText, mediumRawResults, sectionFor, submit, takeTask } from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

/**
 * F1 (brief §7): the reviewer runs the skill, the UI opens with the diff immediately, and the route fills in
 * as generation progresses. The reviewer reads high/medium stops, leaves two drafts and ships.
 *
 * The agent uses the same CLI bundle as the model in its harness. It submits prepared results
 * the `medium` fixture, so the screen counts are known in advance and must agree (SPEC §8 items 3–4).
 *
 * The worker loop lives in the test: `worker next` long-polls for four minutes, and a task is claimed
 * only when the server is known to have enqueued one.
 */

/** Fixture tiers: 01–02 high, 03–04 medium, 05–06 low, 07 is the synthetic Other stop. */
const IMPORTANT_STOPS = ['s01', 's02', 's03', 's04'] as const;
const LOW_STOPS = ['s05', 's06'] as const;
const PLAN_ORDER = ['s01', 's02', 's03', 's04', 's05', 's06', 'other'];
const TOUR_ORDER = ['s03', 's01', 's02', 's05', 's06', 's04', 'other'];
const FIRST_DRAFT = 'E2E F1: the window is calculated in one place. This belongs in the docs.';
const SECOND_DRAFT = 'E2E F1: 409 versus 400. We should check on the client.';

test('F1: queue → validator → snapshot → SSE → UI, through Review complete', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;
    const raw = mediumRawResults();

    await test.step('UI opens immediately: diff and reader do not wait for the agent', async () => {
        await page.goto(server.url);

        await expect(page.getByRole('tab', { name: 'Route', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Agent disconnected', exact: true })).toBeVisible();

        await page.getByRole('tab', { name: 'Full diff', exact: true }).click();
        await expect(page.locator('.full-diff')).toHaveAttribute('data-shown-files', '18');
        await expect(page.locator('.diff-row').first()).toBeVisible();
    });

    const skeletonTask = await test.step('agent connects and the server enqueues the route skeleton automatically', async () => {
        expect((await worker.register('claude-code')).code).toBe(0);
        await page.getByRole('tab', { name: 'Route', exact: true }).click();

        const task = await takeTask(worker, 'route.skeleton');
        expect(task.attempt).toBe(1);
        // Reading phase: there is no plan yet, so placeholders have neither numbers nor a denominator.
        await expect(page.locator('.route-skeleton__note')).toContainText('The plan is still being built');
        await expect(page.locator('.route-stop__number')).toHaveCount(3);
        await expect(page.locator('.route-stop__number').first()).toHaveText('— / ?');
        await expect(page.locator('.coverage__legend-text')).toHaveText('coverage known after the plan');
        return task;
    });

    await test.step('plan arrives: slots and summary are in place before filling', async () => {
        await submit(worker, skeletonTask.taskId, raw.skeleton);

        await expect(stopNumbers(page)).toHaveText(['01 / 7', '02 / 7', '03 / 7', '04 / 7', '05 / 7', '06 / 7', '07 / 7']);
        expect(await stopOrder(page)).toEqual(PLAN_ORDER);
        // None filled yet: six model skeletons plus the ready "Other" stop.
        await expect(page.locator('.route-skeleton-card')).toHaveCount(6);
        await expect(page.locator('.coverage__legend-text')).toHaveText('coverage known after the plan');

        // F1 progressive rendering (brief §7): the summary is readable here, before the first section.
        await page.getByRole('tab', { name: 'Overview', exact: true }).click();
        await expectSummary(page);
        await page.getByRole('tab', { name: 'Route', exact: true }).click();
    });

    await test.step('stops fill one at a time: completed stops are readable and the rest stay as skeletons', async () => {
        for (let filled = 0; filled < 6; filled += 1) {
            const task = await takeTask(worker, 'route.section');
            expect(task.planIndexes).toHaveLength(1);

            if (filled === 3) {
                await expectHalfFilled(page);
            }
            await submit(worker, task.taskId, sectionFor(task.planIndexes));
        }
    });

    await test.step('route ready: coverage bar and stop counter agree', async () => {
        await expect(page.locator('.coverage__legend-text')).toHaveText(
            '860 changed lines · 96% explained · 32 lines not explained',
        );
        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('.coverage__stops')).toHaveText('0 of 7 stops viewed');
        // The same 32 lines as in the legend: Other promises exactly what it will expand.
        await expect(stop(page, 'other')).toContainText('Open 32 lines');
        // Bar segments use the fixture tiers and add up to the same 860 lines
        // (the patches contain 862: 2 empty lines outside anchors are excluded from the counts).
        await expect(segment(page, 'high')).toHaveAttribute('aria-label', 'high · stops 01–02 · 196 lines');
        await expect(segment(page, 'medium')).toHaveAttribute('aria-label', 'medium · stops 03–04 · 327 lines');
        await expect(segment(page, 'low')).toHaveAttribute('aria-label', 'low · stops 05–06 · 305 lines');
        await expect(segment(page, 'other')).toHaveAttribute('aria-label', 'not explained · 32 lines');

        await page.getByRole('tab', { name: 'Overview', exact: true }).click();
        await expectSummary(page);
        await expect(page.locator('.gen-card__title')).toHaveText('Route ready · 7 stops');
        await page.getByRole('tab', { name: 'Route', exact: true }).click();
    });

    await test.step('plan numbers do not depend on the preset (SPEC §8 item 4)', async () => {
        await page.keyboard.press('t');
        await expect(page.getByRole('button', { name: 'Full tour', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect(await stopOrder(page)).toEqual(TOUR_ORDER);
        // Stop 03 comes first, keeping its plan number instead of becoming "01".
        await expect(stopNumbers(page).first()).toHaveText('03 / 7');
        await expect(stop(page, 's01').locator('.route-stop__number')).toHaveText('01 / 7');

        await page.keyboard.press('t');
        await expect(page.getByRole('button', { name: 'Triage', exact: true })).toHaveAttribute('aria-pressed', 'true');
        expect(await stopOrder(page)).toEqual(PLAN_ORDER);
    });

    await test.step('two drafts at different stops along the way', async () => {
        await addDraft(page, 's01', FIRST_DRAFT);
        await expect(page.locator('.review-action-bar')).toContainText('1 draft goes out on ship');

        await addDraft(page, 's03', SECOND_DRAFT);
        await expect(page.locator('.review-action-bar')).toContainText('2 drafts go out when you publish');
    });

    await test.step('high and medium are marked, low and Other stay collapsed', async () => {
        for (const [index, stopId] of IMPORTANT_STOPS.entries()) {
            await stop(page, stopId).locator('.route-stop__viewed').click();
            await expect(page.locator('.coverage__stops')).toHaveText(
                `${String(index + 1)} of 7 stops viewed`,
            );
        }

        for (const stopId of LOW_STOPS) {
            await expect(stop(page, stopId)).toContainText('low tier');
            await expect(stop(page, stopId).locator('.route-stop__viewed')).toHaveAttribute('aria-pressed', 'false');
        }
        await expect(stop(page, 'other').locator('.route-stop__viewed')).toHaveAttribute('aria-pressed', 'false');
    });

    await test.step('Ship: guardrail counts stops and publishing sends one batch', async () => {
        await page.locator('.review-action-bar__ship-caret').click();
        await expect(page.locator('.review-action-menu__guard')).toHaveText(
            '3 stops not viewed — ship anyway?',
        );
        await page.locator('#review-ship-option-0').click();

        await expect(page.getByRole('heading', { name: 'Shipped · PR 4821', exact: true })).toBeVisible();
        await expect(page.getByText('2 comments published as one batch', { exact: true })).toBeVisible();
        // Review complete counters (README §13) agree with the actions taken by hand.
        await expect(counter(page, 'Stops viewed')).toHaveText('4 of 7');
        await expect(counter(page, 'Comments published')).toHaveText('2 (0 of them replies)');
        // 88% versus 39% at the start (generated files and the host mark). The difference was recorded by
        // by exactly four stop marks: if recording seen ranges breaks, the count drops to 39%.
        // 95 → 88: T7 added 63 documentation lines outside stop anchors to the medium fixture.
        await expect(counter(page, 'Diff seen')).toHaveText('88% of 862 lines');
        // "Other" is unmarked, so the line about reading outside the route must be absent.
        await expect(page.getByText('Of it read outside the route', { exact: true })).toHaveCount(0);
    });

    await test.step('no unpublished comments remain after ship', async () => {
        await page.getByRole('button', { name: 'To the full diff', exact: true }).click();

        await expect(page.locator('.full-diff')).toBeVisible();
        await expect(page.locator('.review-action-bar')).toContainText('no unpublished comments');
    });
});

test('F1 failure: a broken plan fails generation, Retry finishes the route', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;
    const raw = mediumRawResults();
    const broken = asRawText(raw.broken.skeletonTourOrderNotPermutation);

    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Route', exact: true }).click();
    expect((await worker.register('claude-code')).code).toBe(0);

    await test.step('3 validator rejections exhaust the task budget', async () => {
        const task = await takeTask(worker, 'route.skeleton');

        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const rejected = await worker.complete(task.taskId, broken);
            // Rejection is part of the normal loop. The CLI exits with zero and prints what to fix.
            expect(rejected.code, `attempt ${String(attempt)}: ${rejected.stderr}`).toBe(0);
            expect(rejected.stdout, `attempt ${String(attempt)}`).toContain('was rejected');
            expect(rejected.stdout).toContain('tourOrder');
        }
    });

    await test.step('failed phase: the reason and raw model output are on screen (README §12)', async () => {
        await expect(page.locator('.gen-failed__title')).toHaveText('The route was not built');
        await expect(page.locator('.gen-failed__reason')).toContainText('The agent did not plan the route');

        await page.getByRole('button', { name: 'Show the raw output', exact: true }).click();
        await expect(page.locator('.gen-failed__raw')).toHaveText(broken);
    });

    await test.step('Retry queues a new plan task, valid results reach ready', async () => {
        await page.getByRole('button', { name: 'Retry', exact: true }).click();

        const retried = await takeTask(worker, 'route.skeleton');
        expect(retried.taskId).not.toBe(0);
        await submit(worker, retried.taskId, raw.skeleton);

        for (let filled = 0; filled < 6; filled += 1) {
            const task = await takeTask(worker, 'route.section');
            await submit(worker, task.taskId, sectionFor(task.planIndexes));
        }

        await expect(page.locator('.coverage__legend-text')).toHaveText(
            '860 changed lines · 96% explained · 32 lines not explained',
        );
        expect(await stopOrder(page)).toEqual(PLAN_ORDER);
    });
});

/** Half the route is filled. Completed stops are readable, unfilled stops show skeletons. */
async function expectHalfFilled(page: Page): Promise<void> {
    // 3 stops submitted, the fourth is leased and filling. 05 and 06 are still queued.
    await expect(page.locator('.route-skeleton-card')).toHaveCount(3);
    // The Markdown renderer consumes model backticks. `EditWindow` appears as monospace code without backticks.
    await expect(stop(page, 's01')).toContainText('The EditWindow class and an injectable time source have been added');
    await expect(stop(page, 's01').locator('.route-stop__paragraph code.md-code').first()).toHaveText('EditWindow');
    await expect(stop(page, 's04')).toContainText('The agent has not filled this stop yet');
    await expect(page.locator('.coverage__legend-text')).toHaveText('coverage known after the plan');

    // The Overview plan card and the route use the same numbers (SPEC §8 item 4).
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await expect(page.locator('.gen-plan__number')).toHaveText(['01', '02', '03', '04', '05', '06', '07']);
    await expect(page.locator('.gen-card__counter')).toHaveText('4 of 7 ready');
    await expectSummary(page);
    await page.getByRole('tab', { name: 'Route', exact: true }).click();
}

/**
 * The full summary is on the Overview tab. The provenance line only renders with a snapshot,
 * so it distinguishes the actual description from the "No route for this PR yet" / "The route was not built" placeholders.
 */
async function expectSummary(page: Page): Promise<void> {
    await expect(page.locator('.overview-card__text').first()).toContainText(
        'The PR introduces a 30-minute editing window',
    );
    await expect(page.locator('.summary-card__provenance')).toBeVisible();
}

/** A draft on a stop line uses the same composer as the full diff. */
async function addDraft(page: Page, stopId: string, text: string): Promise<void> {
    const button = stop(page, stopId).getByRole('button', { name: /Comment on line \d+/ }).first();
    await button.locator('..').hover();
    await button.click();
    const composer = stop(page, stopId).getByRole('textbox', { name: 'New comment' });
    await composer.fill(text);
    await expect(stop(page, stopId).getByText('saved as a draft', { exact: true })).toBeVisible({
        timeout: 6_000,
    });
}

function stop(page: Page, stopId: string): Locator {
    return page.locator(`[data-stop="${stopId}"]`);
}

function segment(page: Page, tier: string): Locator {
    return page.locator(`.coverage__segment--${tier}`);
}

function stopNumbers(page: Page): Locator {
    return page.locator('[data-stop] .route-stop__number');
}

async function stopOrder(page: Page): Promise<string[]> {
    return page.locator('[data-stop]').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('data-stop') ?? ''),
    );
}

function counter(page: Page, label: string): Locator {
    return page.locator('.review-complete__counter').filter({ hasText: label }).locator('dd');
}
