import type { Locator, Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

const COMMENT = 'E2E: audit retention must stay explicit.';
const SEARCH_TEXT = 'Retention is 13 months';

/** The UI registry treats `mod` as Meta or Ctrl. Playwright sends the platform's native modifier. */
const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';

test('F5: full review of fixture-medium without an agent', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');

    await test.step('reader and reduced functionality without a worker', async () => {
        await page.goto(server.url);

        await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Route', exact: true })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Full diff', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Agent disconnected', exact: true })).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'Sherpa launch command' })).toHaveValue(
            '/sherpa fixture-medium',
        );

        await page.getByRole('tab', { name: 'Full diff', exact: true }).click();
        await expect(page.locator('.full-diff')).toBeVisible();
        await expect(page.getByRole('tree', { name: 'File tree' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'All 18', exact: true })).toBeVisible();
        await expect(page.locator('.full-diff')).toHaveAttribute('data-shown-files', '18');
        await expect(page.locator('.file-card').first()).toBeVisible();
        await expect(page.locator('.diff-row').first()).toBeVisible();
    });

    await test.step('lens and filename filter', async () => {
        await page.getByRole('button', { name: 'Mine 12', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Mine 12', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.full-diff')).toHaveAttribute('data-shown-files', '12');

        await page.getByRole('button', { name: 'All 18', exact: true }).click();
        await expect(page.locator('.full-diff')).toHaveAttribute('data-shown-files', '18');

        const filterInput = page.getByRole('searchbox', { name: 'Filter files by name' });
        const pciAuditFile = page.locator(
            '.file-tree__label[title="services/orders/src/payments/pci-audit.ts"]',
        );
        const unrelatedFile = page.locator('.file-tree__label[title=".github/CODEOWNERS"]');
        await expect(pciAuditFile).toHaveCount(1);
        await expect(unrelatedFile).toHaveCount(1);

        await filterInput.fill('pci-audit');
        await expect(pciAuditFile).toHaveCount(1);
        await expect(unrelatedFile).toHaveCount(0);
        await filterInput.fill('');
    });

    await test.step('content search and scrolling to the line', async () => {
        await openPciAuditBySearch(page);
    });

    await test.step('viewed persists after a reload', async () => {
        const bar = page.locator('.review-action-bar');
        await expect(bar).toContainText('4 / 18 files');

        const card = pciAuditCard(page);
        await card.getByRole('button', { name: 'Mark viewed', exact: true }).click();
        await expect(bar).toContainText('5 / 18 files');
        await expect(card.locator('.file-card__collapsed--file').filter({ hasText: 'viewed' })).toBeVisible();

        await page.reload();
        await expect(page.locator('.review-action-bar')).toContainText('5 / 18 files');
        const filterInput = page.getByRole('searchbox', { name: 'Filter files by name' });
        await filterInput.fill('pci-audit');
        await expect(
            page.getByRole('treeitem').filter({ hasText: 'pci-audit.ts' }).locator('svg[data-icon="check"]'),
        ).toBeVisible();
        await filterInput.fill('');
        // Jumping to a line first expands the viewed card temporarily, then finishes scrolling.
        await openPciAuditBySearch(page);
        await expect(pciAuditCard(page).locator('.file-card__collapsed--file')).toHaveCount(0);
        await expect(pciAuditCard(page).getByRole('button', { name: 'Viewed', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
    });

    await test.step('a draft is saved and included in the ship batch', async () => {
        const card = pciAuditCard(page);
        const button = card.getByRole('button', { name: /Comment on line \d+/ }).first();
        await button.locator('..').hover();
        await button.click();
        const composer = page.getByRole('textbox', { name: 'New comment' });
        await composer.fill(COMMENT);
        await expect(page.locator('.thread-composer__status.is-saved')).toContainText(
            /saved as a draft · \d{2}:\d{2}/,
            { timeout: 6_000 },
        );
        await expect(page.locator('.review-action-bar')).toContainText('1 draft goes out on ship');
        await expect(page.getByText('draft · goes out on ship', { exact: true })).toBeVisible();
    });

    await test.step('Ship shows the result and publishes the thread', async () => {
        await page.getByRole('button', { name: 'Ship · 1', exact: true }).click();

        await expect(page.getByRole('heading', { name: 'Shipped · PR 4821', exact: true })).toBeVisible();
        await expect(page.getByText('1 comment published as one batch', { exact: true })).toBeVisible();
        await expect(page.getByText('5 of 18', { exact: true })).toBeVisible();
        await expect(page.getByText(/\d+% of 862 lines/)).toBeVisible();
        await expect(page.getByText('1 (0 of them replies)', { exact: true })).toBeVisible();

        await page.getByRole('button', { name: 'To the full diff', exact: true }).click();
        await expect(page.locator('.full-diff')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Humans 5', exact: true })).toBeVisible();
        await expect(page.locator('.review-action-bar')).toContainText('no unpublished comments');

        await openPciAuditBySearch(page);
        await expect(pciAuditCard(page).getByText(COMMENT, { exact: true })).toBeVisible();
        await expect(page.getByText('draft · goes out on ship', { exact: true })).toHaveCount(0);
    });
});

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

    const card = pciAuditCard(page);
    const targetLine = card.getByText(/Retention is 13 months/);
    await expect(card).toBeVisible();
    await expect(targetLine).toBeVisible();
    await expectInScrollViewport(page, targetLine);
}

async function expectInScrollViewport(page: Page, locator: Locator): Promise<void> {
    const inViewport = await locator.evaluate((element) => {
        const scroller = element.closest('.full-diff');
        if (!(scroller instanceof HTMLElement)) {
            return false;
        }
        const elementBox = element.getBoundingClientRect();
        const scrollerBox = scroller.getBoundingClientRect();
        const toolbarBottom = scroller.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom;
        const viewportTop = Math.max(scrollerBox.top, toolbarBottom ?? 0);
        return elementBox.bottom > viewportTop && elementBox.top < scrollerBox.bottom;
    });
    expect(inViewport).toBe(true);
}
