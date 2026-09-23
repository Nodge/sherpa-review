import type { Locator, Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

/**
 * The "PR comments" modal (docs/design/SPEC-changes-2026-09-20.md §4, checklist §7 items 8–10):
 * its width grows with the window, the list is bounded, the comment body is 760 wide, replies are written
 * inline, and Esc closes the composer first, then the modal.
 */

const MODAL = '.pr-comments-modal';
const OPEN_BUTTON = 'Comment on the PR';

test('modal width follows the window: 1440 → 979, 1920 → 1120', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.url);
    await openModal(page);

    const modal = page.locator(MODAL);
    expect(await widthOf(modal)).toBeCloseTo(979, 0);

    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect.poll(() => widthOf(modal)).toBeCloseTo(1120, 0);

    // The list scrolls independently, the header and composer stay fixed. The comment body is at most 760 wide.
    const list = await box(page.locator('.pr-comments-modal__list'));
    expect(list.height).toBeLessThanOrEqual(640);
    const body = await box(page.locator('.thread__body').first());
    expect(body.width).toBeLessThanOrEqual(760);
});

test('PR thread: replies are visible immediately, replies are written inline, Esc closes the composer', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.url);
    await openModal(page);

    const thread = page.locator(`${MODAL} [data-thread-id]`).first();
    // The medium fixture has one PR-level thread: the root and a reply from the PR author.
    await expect(thread.locator('.thread__row')).toHaveCount(2);
    await expect(thread).toContainText('Added to the migration section of the doc.');

    const reply = thread.locator('.thread__row').nth(1);
    await reply.getByRole('button', { name: 'Reply', exact: true }).click();

    const composer = reply.locator('.thread-composer');
    await expect(composer).toHaveCount(1);
    await expect(thread.locator('.thread__row').first().locator('.thread-composer')).toHaveCount(0);
    await expect(composer.getByRole('switch', { name: /Open an issue/ })).toBeVisible();

    // With the composer open, Esc closes it. The next Esc closes the modal (checklist §7.10).
    await composer.getByRole('textbox').press('Escape');
    await expect(composer).toHaveCount(0);
    await expect(page.locator(MODAL)).toBeVisible();
    await expect(thread).not.toHaveClass(/is-collapsed/);

    // The modal does not silently discard a typed reply. ✕ first asks to discard it, otherwise the publish guard
    // would hold text that is no longer visible on screen.
    await reply.getByRole('button', { name: 'Reply', exact: true }).click();
    await composer.getByRole('textbox').fill('Still writing.');
    await page.getByRole('button', { name: 'Close the PR comments' }).click();
    await expect(page.locator(MODAL)).toBeVisible();
    await expect(composer).toContainText('Delete the draft?');
    await composer.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(composer).toHaveCount(0);

    await page.locator(`${MODAL} h2`).click();
    await page.keyboard.press('Escape');
    await expect(page.locator(MODAL)).toHaveCount(0);
});

async function openModal(page: Page): Promise<void> {
    await expect(page.locator('.review-action-bar')).toBeVisible();
    await page.getByRole('button', { name: OPEN_BUTTON, exact: true }).click();
    await expect(page.locator(MODAL)).toBeVisible();
}

async function widthOf(locator: Locator): Promise<number> {
    return (await box(locator)).width;
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
    const found = await locator.boundingBox();
    if (found === null) {
        throw new Error('element has no geometry');
    }
    return found;
}
