import type { Locator, Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

const COMMENT = 'E2E: audit retention must stay explicit.';
const SEARCH_TEXT = 'Retention is 13 months';

/** The UI registry treats `mod` as Meta or Ctrl. Playwright sends the platform's native modifier. */
const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Labels the spec uses to find elements. The UI dictionary is deliberately not imported: the test must break
 * when a label changes, rather than change along with it. Russian labels are `\u` escapes of the dictionary text.
 */
interface Strings {
    readonly overviewTab: string;
    readonly routeTab: string;
    readonly diffTab: string;
    readonly agentDisconnected: string;
    readonly commandBox: string;
    readonly fileTree: string;
    readonly allFiles: string;
    readonly myFiles: string;
    readonly filterFiles: string;
    readonly markViewed: string;
    readonly viewedCollapsed: string;
    readonly viewedToggle: string;
    readonly palette: string;
    readonly commentLine: RegExp;
    readonly newComment: string;
    readonly saveDraft: string;
    readonly draftChip: string;
    readonly draftsCounter: string;
    readonly progressBefore: string;
    readonly progressAfter: string;
    readonly shipped: string;
    readonly publishedBatch: string;
    readonly stopsOrFiles: string;
    readonly diffSeen: RegExp;
    readonly publishedWithReplies: string;
    readonly toFullDiff: string;
    readonly noDrafts: string;
    /** Relative time in the thread metadata: `Intl` formats it in the UI language. */
    readonly relativeTime: RegExp;
}

const RU: Strings = {
    overviewTab: '\u041e\u0431\u0437\u043e\u0440',
    routeTab: '\u041c\u0430\u0440\u0448\u0440\u0443\u0442',
    diffTab: '\u041f\u043e\u043b\u043d\u044b\u0439 \u0434\u0438\u0444\u0444',
    agentDisconnected: '\u0410\u0433\u0435\u043d\u0442 \u043e\u0442\u043a\u043b\u044e\u0447\u0451\u043d',
    commandBox: '\u041a\u043e\u043c\u0430\u043d\u0434\u0430 \u0437\u0430\u043f\u0443\u0441\u043a\u0430 \u0428\u0435\u0440\u043f\u044b',
    fileTree: '\u0414\u0435\u0440\u0435\u0432\u043e \u0444\u0430\u0439\u043b\u043e\u0432',
    allFiles: '\u0412\u0441\u0435 21',
    myFiles: '\u041c\u043e\u0438 12',
    filterFiles: '\u0424\u0438\u043b\u044c\u0442\u0440 \u0444\u0430\u0439\u043b\u043e\u0432 \u043f\u043e \u0438\u043c\u0435\u043d\u0438',
    markViewed: '\u041e\u0442\u043c\u0435\u0442\u0438\u0442\u044c \u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440\u0435\u043d\u043d\u044b\u043c',
    viewedCollapsed: '\u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440\u0435\u043d\u043e',
    viewedToggle: '\u041f\u0440\u043e\u0441\u043c\u043e\u0442\u0440\u0435\u043d\u043e',
    palette: '\u041f\u0430\u043b\u0438\u0442\u0440\u0430 \u043a\u043e\u043c\u0430\u043d\u0434',
    commentLine: /\u041a\u043e\u043c\u043c\u0435\u043d\u0442\u0438\u0440\u043e\u0432\u0430\u0442\u044c \u0441\u0442\u0440\u043e\u043a\u0443 \d+/,
    newComment: '\u041d\u043e\u0432\u044b\u0439 \u043a\u043e\u043c\u043c\u0435\u043d\u0442\u0430\u0440\u0438\u0439',
    saveDraft: '\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u0447\u0435\u0440\u043d\u043e\u0432\u0438\u043a',
    draftChip: 'draft',
    draftsCounter: '1 \u0447\u0435\u0440\u043d\u043e\u0432\u0438\u043a \u0443\u0439\u0434\u0451\u0442 \u043f\u0440\u0438 \u043f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u0438',
    progressBefore: '4 / 21 \u0444\u0430\u0439\u043b\u043e\u0432',
    progressAfter: '5 / 21 \u0444\u0430\u0439\u043b\u043e\u0432',
    shipped: 'Shipped · PR 4821',
    publishedBatch: '1 \u043a\u043e\u043c\u043c\u0435\u043d\u0442\u0430\u0440\u0438\u0439 \u043e\u043f\u0443\u0431\u043b\u0438\u043a\u043e\u0432\u0430\u043d \u043e\u0434\u043d\u0438\u043c \u043f\u0430\u043a\u0435\u0442\u043e\u043c',
    stopsOrFiles: '5 \u0438\u0437 21',
    diffSeen: /\d+% \u0438\u0437 868 \u0441\u0442\u0440\u043e\u043a/,
    publishedWithReplies: '1 (\u0438\u0437 \u043d\u0438\u0445 0 \u043e\u0442\u0432\u0435\u0442\u043e\u0432)',
    toFullDiff: '\u041a \u043f\u043e\u043b\u043d\u043e\u043c\u0443 \u0434\u0438\u0444\u0444\u0443',
    noDrafts: '\u043d\u0435\u0442 \u043d\u0435\u043e\u043f\u0443\u0431\u043b\u0438\u043a\u043e\u0432\u0430\u043d\u043d\u044b\u0445 \u043a\u043e\u043c\u043c\u0435\u043d\u0442\u0430\u0440\u0438\u0435\u0432',
    relativeTime: /\u043d\u0430\u0437\u0430\u0434|\u0432\u0447\u0435\u0440\u0430|\u0442\u043e\u043b\u044c\u043a\u043e \u0447\u0442\u043e/u,
};

const EN: Strings = {
    overviewTab: 'Overview',
    routeTab: 'Route',
    diffTab: 'Full diff',
    agentDisconnected: 'Agent disconnected',
    commandBox: 'Sherpa launch command',
    fileTree: 'File tree',
    allFiles: 'All 21',
    myFiles: 'Mine 12',
    filterFiles: 'Filter files by name',
    markViewed: 'Mark viewed',
    viewedCollapsed: 'viewed',
    viewedToggle: 'Viewed',
    palette: 'Command palette',
    commentLine: /Comment on line \d+/,
    newComment: 'New comment',
    saveDraft: 'Save draft',
    draftChip: 'draft',
    draftsCounter: '1 draft goes out when you publish',
    progressBefore: '4 / 21 files',
    progressAfter: '5 / 21 files',
    shipped: 'Shipped · PR 4821',
    publishedBatch: '1 comment published as one batch',
    stopsOrFiles: '5 of 21',
    diffSeen: /\d+% of 868 lines/,
    publishedWithReplies: '1 (0 of them replies)',
    toFullDiff: 'To the full diff',
    noDrafts: 'no unpublished comments',
    relativeTime: /ago|yesterday|just now/u,
};

test.describe('browser locale ru-RU', () => {
    test.use({ locale: 'ru-RU' });
    fullReviewSpec('ru', RU);
});

/**
 * The same scenario in English. Each test has its own state directory, with the default
 * language setting (`auto`). F5 has no agent, so the language comes from the browser.
 */
test.describe('browser locale en-US', () => {
    test.use({ locale: 'en-US' });
    fullReviewSpec('en', EN);
});

function fullReviewSpec(locale: 'ru' | 'en', s: Strings): void {
    test(`F5: a full review of fixture-medium without an agent (${locale})`, async ({ page, launchSherpa }) => {
        // Fixture comment dates are fixed: localization must not depend on the day the test runs.
        await page.clock.setFixedTime(new Date('2026-08-20T12:00:00.000Z'));
        const server = await launchSherpa('fixture-medium');

        await test.step('the reader and reduced functionality without a worker', async () => {
            await page.goto(server.url);

            await expect(page.locator('html')).toHaveAttribute('lang', locale);
            await expect(page.getByRole('tab', { name: s.overviewTab, exact: true })).toBeVisible();
            await expect(page.getByRole('tab', { name: s.routeTab, exact: true })).toBeVisible();
            await expect(page.getByRole('tab', { name: s.diffTab, exact: true })).toBeVisible();
            await expect(page.getByRole('button', { name: s.agentDisconnected, exact: true })).toBeVisible();
            await expect(page.getByRole('textbox', { name: s.commandBox })).toHaveValue('/sherpa fixture-medium');

            await page.getByRole('tab', { name: s.diffTab, exact: true }).click();
            await expect(page.locator('.full-diff')).toBeVisible();
            await expect(page.getByRole('tree', { name: s.fileTree })).toBeVisible();
            await expect(page.getByRole('button', { name: s.allFiles, exact: true })).toBeVisible();
            await expect(page.locator('.full-diff')).toHaveAttribute('data-shown-files', '21');
            await expect(page.locator('.file-card').first()).toBeVisible();
            await expect(page.locator('.diff-row').first()).toBeVisible();
            // Relative time in the thread metadata uses `Intl`, in the UI language.
            await expect(page.locator('.thread__meta').first()).toHaveText(s.relativeTime);
        });

        await test.step('the lens and file-name filter', async () => {
            await page.getByRole('button', { name: s.myFiles, exact: true }).click();
            await expect(page.getByRole('button', { name: s.myFiles, exact: true })).toHaveAttribute(
                'aria-pressed',
                'true',
            );
            await expect(page.locator('.full-diff')).toHaveAttribute('data-shown-files', '12');

            await page.getByRole('button', { name: s.allFiles, exact: true }).click();
            await expect(page.locator('.full-diff')).toHaveAttribute('data-shown-files', '21');

            const filterInput = page.getByRole('searchbox', { name: s.filterFiles });
            // The file path is in the row `title`: the label only has the name (SPEC-theming §6a).
            const pciAuditFile = page.locator(
                '.file-tree__row--file[title^="services/orders/src/payments/pci-audit.ts · "]',
            );
            const unrelatedFile = page.locator('.file-tree__row--file[title^="services/orders/.github/CODEOWNERS · "]');
            await expect(pciAuditFile).toHaveCount(1);
            await expect(unrelatedFile).toHaveCount(1);

            await filterInput.fill('pci-audit');
            await expect(pciAuditFile).toHaveCount(1);
            await expect(unrelatedFile).toHaveCount(0);
            await filterInput.fill('');
        });

        await test.step('content search and scrolling to the line', async () => {
            await openPciAuditBySearch(page, s);
        });

        await test.step('viewed survives a reload', async () => {
            const bar = page.locator('.review-action-bar');
            await expect(bar).toContainText(s.progressBefore);

            const card = pciAuditCard(page);
            await card.getByRole('button', { name: s.markViewed, exact: true }).click();
            await expect(bar).toContainText(s.progressAfter);
            await expect(
                card.locator('.file-card__collapsed--file').filter({ hasText: s.viewedCollapsed }),
            ).toBeVisible();

            await page.reload();
            await expect(page.locator('.review-action-bar')).toContainText(s.progressAfter);
            const filterInput = page.getByRole('searchbox', { name: s.filterFiles });
            await filterInput.fill('pci-audit');
            await expect(
                page.getByRole('treeitem').filter({ hasText: 'pci-audit.ts' }).locator('svg[data-icon="check"]'),
            ).toBeVisible();
            await filterInput.fill('');
            // Navigating to a line first temporarily expands the viewed card, then scrolls to it.
            await openPciAuditBySearch(page, s);
            await expect(pciAuditCard(page).locator('.file-card__collapsed--file')).toHaveCount(0);
            await expect(
                pciAuditCard(page).getByRole('button', { name: s.viewedToggle, exact: true }),
            ).toHaveAttribute('aria-pressed', 'true');
        });

        await test.step('a draft is saved and included in the ship batch', async () => {
            const card = pciAuditCard(page);
            const button = card.getByRole('button', { name: s.commentLine }).first();
            await button.locator('..').hover();
            await button.click();
            const composer = page.getByRole('textbox', { name: s.newComment });
            await composer.fill(COMMENT);
            await page.getByRole('button', { name: s.saveDraft, exact: true }).click();
            await expect(composer).toHaveCount(0, { timeout: 6_000 });
            await expect(card.getByText(COMMENT, { exact: true })).toBeVisible();
            // A single draft: the counter must use the singular form in both languages.
            await expect(page.locator('.review-action-bar')).toContainText(s.draftsCounter);
            await expect(page.getByText(s.draftChip, { exact: true })).toBeVisible();
        });

        await test.step('Ship shows the result and publishes the thread', async () => {
            await page.getByRole('button', { name: 'Ship · 1', exact: true }).click();

            await expect(page.getByRole('heading', { name: s.shipped, exact: true })).toBeVisible();
            await expect(page.getByText(s.publishedBatch, { exact: true })).toBeVisible();
            await expect(page.getByText(s.stopsOrFiles, { exact: true })).toBeVisible();
            await expect(page.getByText(s.diffSeen)).toBeVisible();
            await expect(page.getByText(s.publishedWithReplies, { exact: true })).toBeVisible();

            await page.getByRole('button', { name: s.toFullDiff, exact: true }).click();
            await expect(page.locator('.full-diff')).toBeVisible();
            await expect(page.locator('.toolbar-right-cluster')).toBeVisible();
            await expect(page.locator('.review-action-bar')).toContainText(s.noDrafts);

            await openPciAuditBySearch(page, s);
            await expect(pciAuditCard(page).getByText(COMMENT, { exact: true })).toBeVisible();
            await expect(page.getByText(s.draftChip, { exact: true })).toHaveCount(0);
        });
    });
}

function pciAuditCard(page: Page): Locator {
    return page.locator('.file-card').filter({ hasText: 'pci-audit.ts' });
}

async function openPciAuditBySearch(page: Page, s: Strings): Promise<void> {
    await page.keyboard.press(`${MOD_KEY}+KeyK`);
    const palette = page.getByRole('dialog', { name: s.palette });
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
