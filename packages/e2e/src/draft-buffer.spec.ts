import type { Locator, Page } from '@playwright/test';

import type { SherpaServerHandle } from './sherpa-fixture.js';
import { expect, sherpaAuth, test } from './sherpa-fixture.js';

/**
 * The draft survives a host failure. The fixture host development endpoint enables the failure.
 * The text goes into the server buffer, survives a tab reload and reaches the host on retry.
 */

const COMMENT = 'E2E: this draft must survive a host failure.';
const SEARCH_TEXT = 'Retention is 13 months';
const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';

test('draft buffer: host failure → buffered text → reload → retry', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');

    await test.step('host refuses to accept drafts', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Full diff', exact: true }).click();
        await expect(page.locator('.full-diff')).toBeVisible();
        await failDraftWrites(page, server, true);
    });

    await test.step('draft is buffered: status promises delivery and ship is blocked', async () => {
        await openPciAuditBySearch(page);
        const card = pciAuditCard(page);
        const button = card.getByRole('button', { name: /Comment on line \d+/ }).first();
        await button.locator('..').hover();
        await button.click();

        const composer = page.getByRole('textbox', { name: 'New comment' });
        await composer.fill(COMMENT);
        await page.getByRole('button', { name: 'Save draft', exact: true }).click();

        await expect(page.locator('.thread-composer__status')).toContainText('we will save it once the connection is back');
        // The text stays in the field. The composer remains editable instead of being locked by the status.
        await expect(composer).toContainText(COMMENT);
        await expect(page.locator('.review-action-bar')).toContainText('1 not sent yet');
        await expect(page.locator('.review-action-bar__ship-primary')).toBeDisabled();
        await expect(page.locator('.review-action-bar__ship-primary')).toHaveAttribute(
            'title',
            '1 draft is not sent yet — ship is blocked until it is',
        );
    });

    await test.step('reloading the tab restores the text on the same line', async () => {
        await page.reload();
        await page.getByRole('tab', { name: 'Full diff', exact: true }).click();
        await openPciAuditBySearch(page);

        await expect(page.getByRole('textbox', { name: 'New comment' })).toContainText(COMMENT);
        await expect(pciAuditCard(page).locator('.thread-composer')).toHaveCount(1);
        await expect(page.locator('.thread-composer__status')).toContainText('we will save it once the connection is back');
    });

    await test.step('host recovers and retry delivers the draft to a thread', async () => {
        await failDraftWrites(page, server, false);
        await page.locator('.thread-composer__status').getByRole('button', { name: 'retry' }).click();

        await expect(page.getByText(COMMENT, { exact: true })).toBeVisible();
        await expect(page.locator('.review-action-bar')).toContainText('1 draft goes out when you publish');
        await expect(page.locator('.review-action-bar')).not.toContainText('not sent yet');
        await expect(page.locator('.review-action-bar__ship-primary')).toBeEnabled();
        expect(await draftBufferEntries(page, server)).toEqual([]);
    });
});

/** Fixture host development endpoint: draft writes start (or stop) failing. */
async function failDraftWrites(page: Page, server: SherpaServerHandle, fail: boolean): Promise<void> {
    const url = new URL('/api/dev/fixture/fail-draft-writes', server.url).href;
    const response = await page.request.post(url, { headers: sherpaAuth(server), data: { fail } });
    expect(response.status(), await response.text()).toBe(200);
}

/** Reads the draft buffer outside the UI to verify that the write reached its destination. */
async function draftBufferEntries(page: Page, server: SherpaServerHandle): Promise<readonly { id: string }[]> {
    const url = new URL('/api/ui/review/draft-buffer', server.url).href;
    const response = await page.request.get(url, { headers: sherpaAuth(server) });
    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as { readonly entries: readonly { id: string }[] };
    return body.entries;
}

function pciAuditCard(page: Page): Locator {
    return page.locator('.file-card').filter({ hasText: 'pci-audit.ts' });
}

async function openPciAuditBySearch(page: Page): Promise<void> {
    await page.keyboard.press(`${MOD_KEY}+KeyK`);
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await palette.getByRole('textbox').fill(`/${SEARCH_TEXT}`);
    await expect(palette.getByRole('option', { name: /pci-audit\.ts:\d+/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(pciAuditCard(page).getByText(/Retention is 13 months/)).toBeVisible();
}
