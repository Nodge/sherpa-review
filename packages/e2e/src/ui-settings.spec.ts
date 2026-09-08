import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

/**
 * Global UI settings live in `<sherpaDir>/settings.json`, not `localStorage`.
 * Each PR server listens on a random port, and browser storage is empty for a new port.
 */

test('the diff mode survives a page reload', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await openFullDiff(page, server.url);
    await expect(page.locator('.diff-rows--unified').first()).toBeVisible();

    await toggleDiffMode(page);
    await expect(page.locator('.diff-rows--split').first()).toBeVisible();

    await page.reload();
    await openFullDiff(page, server.url, { reloaded: true });

    await expect(page.locator('.diff-rows--split').first()).toBeVisible();
    await expect(page.locator('.diff-mode-toggle')).toHaveText('side by side');
});

test('a second PR opens in the same mode', async ({ page, launchSherpa }) => {
    // A shared state root means "one user": two servers, one settings.json.
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-settings-'));
    try {
        const first = await launchSherpa('fixture-medium', { sherpaDir });
        const second = await launchSherpa('fixture-large', { sherpaDir });

        await openFullDiff(page, first.url);
        await toggleDiffMode(page);
        await expect(page.locator('.diff-rows--split').first()).toBeVisible();

        await openFullDiff(page, second.url);

        await expect(page.locator('.diff-rows--split').first()).toBeVisible();
        await expect(page.locator('.diff-mode-toggle')).toHaveText('side by side');
    } finally {
        await rm(sherpaDir, { recursive: true, force: true });
    }
});

async function openFullDiff(page: Page, url: string, options: { reloaded?: boolean } = {}): Promise<void> {
    if (options.reloaded !== true) {
        await page.goto(url);
    }
    await page.getByRole('tab', { name: 'Full diff', exact: true }).click();
}

/** Wait for the settings write itself. Reloading must not interrupt the PATCH halfway through. */
async function toggleDiffMode(page: Page): Promise<void> {
    const saved = page.waitForResponse(
        (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
    );
    await page.locator('.diff-mode-toggle').click();
    await saved;
}
