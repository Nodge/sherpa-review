import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { announceUpdate, expect, test } from './sherpa-fixture.js';

/**
 * "New version available" toast (M5-T9). No live review host here: version checks are
 * disabled on the fixture host, and a dev endpoint supplies the "new version", just like in the gallery.
 */

/** Directory ending in the checkout path: determines the update command in the toast. */
const CHECKOUT_DIR = '/tmp/fake/tools/sherpa/skill';

const VERSION = '9.9.9';
const WHATS_NEW = 'Update toast and keyboard shortcuts sheet.';

test('the toast arrives through the dev endpoint and shows the update command', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium', { installDir: CHECKOUT_DIR });
    await page.goto(server.url);
    await expect(page.locator('.top-bar')).toBeVisible();

    await announceUpdate(page, server, { version: VERSION, whatsNew: WHATS_NEW, releasedAt: null });

    const toast = page.locator('.update-toast');
    await expect(toast).toBeVisible({ timeout: 2000 });
    await expect(toast).toHaveAttribute('role', 'status');
    await expect(toast).toContainText(`Sherpa ${VERSION} is available`);
    await expect(toast).toContainText(WHATS_NEW);

    await toast.getByRole('button', { name: 'How to update' }).click();

    await expect(toast.locator('.command-box__command')).toHaveValue("cd '/tmp/fake' && git pull");
});

test('"Do not remind me" survives a server restart', async ({ page, launchSherpa }) => {
    // A shared state root means the same "one user": settings live there, not in the browser.
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-update-'));
    try {
        const first = await launchSherpa('fixture-medium', { sherpaDir, installDir: CHECKOUT_DIR });
        await page.goto(first.url);
        await announceUpdate(page, first, { version: VERSION, whatsNew: WHATS_NEW, releasedAt: null });

        const toast = page.locator('.update-toast');
        await expect(toast).toBeVisible({ timeout: 2000 });

        const saved = page.waitForResponse(
            (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
        );
        await toast.getByRole('button', { name: `Don’t remind me about ${VERSION}` }).click();
        await saved;
        // After the patch, the server returns `update: null`, so the toast and dot disappear on their own.
        await expect(toast).toBeHidden();

        await first.stop();
        const second = await launchSherpa('fixture-medium', { sherpaDir, installDir: CHECKOUT_DIR });
        await page.goto(second.url);
        await expect(page.locator('.top-bar')).toBeVisible();
        await announceUpdate(page, second, { version: VERSION, whatsNew: WHATS_NEW, releasedAt: null });

        await expect(page.locator('.update-toast')).toHaveCount(0, { timeout: 3000 });
        await expect(page.locator('.top-bar__version--update')).toHaveCount(0);
    } finally {
        await rm(sherpaDir, { recursive: true, force: true });
    }
});

test('the palette command responds with a status line', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url);
    await expect(page.locator('.top-bar')).toBeVisible();

    await page.locator('.search-button').click();
    await page.locator('.command-palette__query').fill('Check for updates');
    await page.locator('.command-palette__item').first().click();

    // The palette stays open for the response. The fixture disables the check, so there is no update.
    await expect(page.locator('.command-palette')).toBeVisible();
    await expect(page.locator('.command-palette__notice')).toContainText('No updates');
});
