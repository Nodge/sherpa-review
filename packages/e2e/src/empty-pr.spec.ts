import { expect, test } from './sherpa-fixture.js';

/**
 * Empty PR (SPEC §4.1): no changes against the base. Both views say so explicitly
 * instead of showing empty lists, while ship stays available. The reviewer can still approve an empty PR.
 */

test('empty PR: both views show "Nothing to review" and ship is available', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-empty');
    await page.goto(server.url);

    await test.step('Overview opens with an empty-state screen instead of cards', async () => {
        await expect(page.locator('#view-overview')).toContainText('Nothing to review');
        await expect(page.locator('#view-overview')).toContainText('This PR has no changes against the base.');
        await expect(page.locator('.ownership-card')).toHaveCount(0);
    });

    await test.step('Full diff shows the same message', async () => {
        await page.getByRole('tab', { name: 'Full diff', exact: true }).click();
        const zero = page.locator('.full-diff__zero--empty-pr');
        await expect(zero).toContainText('Nothing to review');
        await expect(zero).toContainText('This PR has no changes against the base.');
        await expect(page.locator('.file-card')).toHaveCount(0);
    });

    await test.step('action bar is present and Ship is available without a guardrail', async () => {
        const bar = page.locator('.review-action-bar');
        await expect(bar).toContainText('0 / 0 files');
        const ship = bar.locator('.review-action-bar__ship-primary');
        await expect(ship).toBeEnabled();

        await bar.locator('.review-action-bar__ship-caret').click();
        await expect(page.locator('.review-action-menu__guard')).toHaveCount(0);
    });
});
