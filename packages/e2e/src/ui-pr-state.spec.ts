import type { Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

/**
 * This PR's UI state lives in its SQLite database, not `localStorage`. The server listens on
 * a random port, and browser storage is empty for a new port.
 */

test('a collapsed tree directory and file card survive a reload', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await openFullDiff(page, server.url);

    const dir = page.locator('.file-tree__row--dir').first();
    const dirLabel = (await dir.textContent()) ?? '';
    // A generated card starts collapsed. Test manual collapse on a regular one.
    const card = page.locator('.file-card:not(.file-card--generated)').first();
    const cardPath = (await card.locator('.file-card__name').textContent()) ?? '';
    await expect(dir).toHaveAttribute('aria-expanded', 'true');

    await savingPrState(page, async () => {
        await dir.click();
    });
    await expect(dir).toHaveAttribute('aria-expanded', 'false');

    await savingPrState(page, async () => {
        await card.locator('.file-card__name').click();
    });
    await expect(card.locator('.file-card__collapsed--file')).toContainText('collapsed by hand');

    await page.reload();
    await openFullDiff(page, server.url, { reloaded: true });

    const reloadedDir = page.locator('.file-tree__row--dir').first();
    await expect(reloadedDir).toHaveText(dirLabel);
    await expect(reloadedDir).toHaveAttribute('aria-expanded', 'false');
    const reloadedCard = page.locator('.file-card:not(.file-card--generated)').first();
    await expect(reloadedCard.locator('.file-card__name')).toHaveText(cardPath);
    await expect(reloadedCard.locator('.file-card__collapsed--file')).toContainText('collapsed by hand');
});

async function openFullDiff(page: Page, url: string, options: { reloaded?: boolean } = {}): Promise<void> {
    if (options.reloaded !== true) {
        await page.goto(url);
    }
    await page.getByRole('tab', { name: 'Full diff', exact: true }).click();
}

/** State writes wait for activity to stop. Wait for the PATCH itself so a reload does not get ahead of it. */
async function savingPrState(page: Page, action: () => Promise<void>): Promise<void> {
    const saved = page.waitForResponse(
        (response) => response.url().includes('/api/ui/pr-state') && response.request().method() === 'PATCH',
    );
    await action();
    await saved;
}
