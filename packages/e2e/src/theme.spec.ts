import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

test('theme: Auto follows the system, explicit choice survives reload and another PR', async ({
    page,
    launchSherpa,
}) => {
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-theme-'));
    try {
        const first = await launchSherpa('fixture-medium', { sherpaDir });
        const second = await launchSherpa('fixture-large', { sherpaDir });

        // A fresh state root uses Auto. The theme comes from the system and changes without a reload.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto(first.url);
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(13, 14, 16)');
        await page.emulateMedia({ colorScheme: 'light' });
        await expectLight(page);

        // An explicit choice stops following the system theme.
        await page.emulateMedia({ colorScheme: 'dark' });
        await switchTheme(page, 'Light');
        await expectLight(page);
        await page.getByRole('tab', { name: 'Full diff', exact: true }).click();
        await expect(page.locator('.diff-rows--unified').first()).toBeVisible();
        // Light theme's `--code-text` (packages/ui/src/styles/tokens.css).
        await expect(page.locator('.diff-row--add .diff-row__code').first()).toHaveCSS('color', 'rgb(0, 0, 0)');

        // The first frame is already light. The document itself sets the theme, before the endpoint responds.
        const document = await page.request.get(first.url.split('#')[0] ?? first.url);
        expect(await document.text()).toContain('data-theme="light"');

        await page.reload();
        await expectLight(page);
        await page.goto(second.url);
        await expectLight(page);
        await switchTheme(page, 'Тёмная');
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto(first.url);
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(13, 14, 16)');
    } finally {
        await rm(sherpaDir, { recursive: true, force: true });
    }
});

async function expectLight(page: Page): Promise<void> {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
    // Light theme's `--surface-app` (packages/ui/src/styles/tokens.css).
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(246, 247, 249)');
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
}

/** The theme is switched by a segment in the settings menu. Esc closes it like any other popover. */
async function switchTheme(page: Page, name: string): Promise<void> {
    const saved = page.waitForResponse(
        (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const segment = page.locator('.settings-menu__panel').getByRole('button', { name, exact: true });
    await segment.focus();
    await segment.press('Enter');
    expect((await saved).status()).toBe(200);
    await expect(segment).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('.settings-menu__panel')).toHaveCount(0);
}
