import type { Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

/**
 * This PR's UI state (M3-T18) lives in its SQLite, not `localStorage`: the server listens
 * a random port, and browser storage is empty for a new port.
 */

test('a collapsed tree directory and file card survive a reload', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await openFullDiff(page, server.url);

    const dir = page.locator('.file-tree__row--dir').first();
    const dirLabel = (await dir.textContent()) ?? '';
    const card = page.locator('.file-card').first();
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
    const reloadedCard = page.locator('.file-card').first();
    await expect(reloadedCard.locator('.file-card__name')).toHaveText(cardPath);
    await expect(reloadedCard.locator('.file-card__collapsed--file')).toContainText('collapsed by hand');
});

async function openFullDiff(page: Page, url: string, options: { reloaded?: boolean } = {}): Promise<void> {
    if (options.reloaded !== true) {
        await page.goto(url);
    }
    await page.getByRole('tab', { name: 'Full diff', exact: true }).click();
}

/** State writes are debounced. Wait for PATCH itself, otherwise reload can overtake it. */
async function savingPrState(page: Page, action: () => Promise<void>): Promise<void> {
    const saved = page.waitForResponse(
        (response) => response.url().includes('/api/ui/pr-state') && response.request().method() === 'PATCH',
    );
    await action();
    await saved;
}
