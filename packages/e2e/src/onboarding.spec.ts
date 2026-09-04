import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { fillSections, mediumRawResults, MEDIUM_SECTION_COUNT, sectionFor, submit, takeTask } from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

/**
 * Onboarding tour (M5-T8). Completion flag and step number live in `<sherpaDir>/settings.json`,
 * so a "second visit" here means a second server with the same state root, rather than a tab reload.
 *
 * The tour starts as soon as the UI first opens, without waiting for a route. Until one exists, step anchors
 * come from a scaffold with a placeholder (Alice Ingram's decision, 2026-09-04).
 */

const CARD = '.tour-card';
const COUNTER = '.tour-card__counter';
const RING = '.tour-ring';

test('first visit: the tour appears immediately on Route, with a / 07 counter without an agent', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium', { onboarding: 'pending' });
    await page.goto(server.url);

    // An unfinished tour starts on Route, although the default tab is Overview.
    await expect(page.getByRole('tab', { name: 'Route', exact: true })).toHaveAttribute('aria-selected', 'true');

    await expect(page.locator(CARD)).toBeVisible();
    await expect(page.locator(COUNTER)).toHaveText('01 / 07');
    await expect(page.locator(CARD)).toContainText('The route decides what you read first');
    // No route yet, so the scaffold placeholder holds the anchor and the ring outlines it.
    await expect(page.locator('.tour-scaffold [data-tour="narrative"]')).toBeVisible();
    await expectRingAround(page, '[data-tour="narrative"]');
});

test('a route arrives during the tour: the ring moves to a real stop', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium', { onboarding: 'pending' });
    const worker = server.worker;
    await page.goto(server.url);
    await expect(page.locator(CARD)).toBeVisible();
    await expect(page.locator('.tour-scaffold')).toBeVisible();

    expect((await worker.register('claude-code')).code).toBe(0);
    const skeleton = await takeTask(worker, 'route.skeleton');
    await submit(worker, skeleton.taskId, mediumRawResults().skeleton);
    const section = await takeTask(worker, 'route.section');
    await submit(worker, section.taskId, sectionFor(section.planIndexes));

    // The route replaces the scaffold, and the step anchor moves to the first stop.
    await expect(page.locator('.tour-scaffold')).toHaveCount(0);
    await expect(page.locator('[data-stop="s01"] [data-tour="narrative"]')).toBeVisible();
    await expectRingAround(page, '[data-tour="narrative"]');

    // Scrolling belongs to the reviewer: stops arriving over SSE are remeasured without scrolling (§3).
    await page.locator('#view-route').evaluate((element) => {
        element.scrollTop = 400;
    });
    await fillSections(worker, MEDIUM_SECTION_COUNT - 1);
    await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
    expect(await routeScrollTop(page)).toBe(400);

    // Step 02 targets a collapsed low-tier stop far below: the first measurement scrolls to it.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator(COUNTER)).toHaveText('02 / 07');
    await expectRingAround(page, '[data-tour^="fold-"]');
    expect(await routeScrollTop(page)).toBeGreaterThan(0);

    await page.keyboard.press('ArrowRight');
    // The tour started without an agent: connecting one mid-tour does not restore the chat step (§5).
    await expect(page.locator(COUNTER)).toHaveText('03 / 07');
    await expectRingAround(page, '[data-tour="stopdiff"]');
});

test('clicking the UI and Esc keep the tour open, Enter advances it', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium', { onboarding: 'pending' });
    await page.goto(server.url);
    await expect(page.locator(COUNTER)).toHaveText('01 / 07');

    await page.keyboard.press('Enter');
    await expect(page.locator(COUNTER)).toHaveText('02 / 07');

    await page.locator('.tour-scaffold .route-stop__title').click();
    await expect(page.locator(CARD)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(CARD)).toBeVisible();
    await expect(page.locator(COUNTER)).toHaveText('02 / 07');

    // Tab moved to Skip: Enter belongs to that button, rather than Next (§6, §7).
    await page.locator(CARD).focus();
    await page.keyboard.press('Tab');
    await expect(page.locator(CARD).getByRole('button', { name: 'Skip tour' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator(CARD)).toHaveCount(0);
});

test('an unfinished tour resumes at the same step on a new server', async ({ page, launchSherpa }) => {
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-tour-'));
    try {
        const first = await launchSherpa('fixture-medium', { sherpaDir, onboarding: 'pending' });
        await page.goto(first.url);
        await expect(page.locator(COUNTER)).toHaveText('01 / 07');

        for (let step = 0; step < 3; step += 1) {
            const saved = settingsSaved(page);
            await page.keyboard.press('ArrowRight');
            await saved;
        }
        await expect(page.locator(COUNTER)).toHaveText('04 / 07');

        await first.stop();
        const second = await launchSherpa('fixture-medium', { sherpaDir, onboarding: 'pending' });
        await page.goto(second.url);

        await expect(page.locator(COUNTER)).toHaveText('04 / 07');
        await expect(page.locator(CARD)).toContainText('Progress counts two different things');
    } finally {
        await rm(sherpaDir, { recursive: true, force: true });
    }
});

test('Skip dismisses the tour permanently and the palette restarts it from 01', async ({ page, launchSherpa }) => {
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-tour-skip-'));
    try {
        const first = await launchSherpa('fixture-medium', { sherpaDir, onboarding: 'pending' });
        await page.goto(first.url);
        await expect(page.locator(CARD)).toBeVisible();

        const saved = settingsSaved(page);
        await page.locator(CARD).getByRole('button', { name: 'Skip tour' }).click();
        await saved;
        await expect(page.locator(CARD)).toHaveCount(0);

        await first.stop();
        const second = await launchSherpa('fixture-medium', { sherpaDir, onboarding: 'pending' });
        await page.goto(second.url);
        await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator(CARD)).toHaveCount(0);

        // An agent is connected: the new tour pass has eight steps again.
        expect((await second.worker.register('claude-code')).code).toBe(0);
        await expect(page.locator('.agent-pill__label')).not.toHaveText('Agent disconnected');

        await replayFromPalette(page);
        await expect(page.locator(COUNTER)).toHaveText('01 / 08');
        await expect(page.locator(CARD)).toContainText('The route decides what you read first');
    } finally {
        await rm(sherpaDir, { recursive: true, force: true });
    }
});

test('the agent step opens the chat panel and the next step closes it', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium', { onboarding: 'pending' });
    await page.goto(server.url);
    await expect(page.locator(CARD)).toBeVisible();

    expect((await server.worker.register('claude-code')).code).toBe(0);
    await replayFromPalette(page);
    await expect(page.locator(COUNTER)).toHaveText('01 / 08');
    await expect(page.locator('.chat-panel')).toHaveCount(0);

    for (let step = 0; step < 5; step += 1) {
        await page.keyboard.press('ArrowRight');
    }
    await expect(page.locator(COUNTER)).toHaveText('06 / 08');
    await expect(page.locator('.chat-panel')).toBeVisible();
    await expectRingAround(page, '[data-tour="chat"]');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator(COUNTER)).toHaveText('07 / 08');
    await expect(page.locator('.chat-panel')).toHaveCount(0);

    // Back returns to the same step: the panel opens again.
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator(COUNTER)).toHaveText('06 / 08');
    await expect(page.locator('.chat-panel')).toBeVisible();
});

/** Route-view scroll position shows whether the first step measurement reached the target. */
function routeScrollTop(page: Page): Promise<number> {
    return page.locator('#view-route').evaluate((element) => element.scrollTop);
}

/** Wait for the setting write itself: the next server reads the saved step number. */
function settingsSaved(page: Page): Promise<unknown> {
    return page.waitForResponse(
        (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
    );
}

async function replayFromPalette(page: Page): Promise<void> {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+KeyK`);
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await palette.getByRole('textbox').fill('onboarding');
    await palette.getByRole('option', { name: /Replay the onboarding tour/u }).first().click();
    await expect(palette).toHaveCount(0);
}

/** The ring outlines the target with a 5px gap (onboarding spec §3). */
async function expectRingAround(page: Page, selector: string): Promise<void> {
    const ring: Locator = page.locator(RING);
    await expect(ring).toBeVisible();
    await expect
        .poll(async () => {
            const ringBox = await ring.boundingBox();
            const targetBox = await page.locator(selector).first().boundingBox();
            if (ringBox === null || targetBox === null) {
                return null;
            }
            return {
                left: Math.round(targetBox.x - ringBox.x),
                top: Math.round(targetBox.y - ringBox.y),
            };
        })
        .toEqual({ left: 5, top: 5 });
}
