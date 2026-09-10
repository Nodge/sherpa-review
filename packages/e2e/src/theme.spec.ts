import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

test('theme changes by keyboard and survives reload and opening another PR', async ({ page, launchSherpa }) => {
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-theme-'));
    try {
        const first = await launchSherpa('fixture-medium', { sherpaDir });
        const second = await launchSherpa('fixture-large', { sherpaDir });
        await page.goto(first.url);
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(13, 14, 16)');

        await switchTheme(page, 'Включить светлую тему');
        await expectLight(page);
        await page.getByRole('tab', { name: 'Full diff', exact: true }).click();
        await expect(page.locator('.diff-rows--unified').first()).toBeVisible();
        await expect(page.locator('.diff-row--add .diff-row__code').first()).toHaveCSS('color', 'rgb(48, 59, 75)');

        await page.reload();
        await expectLight(page);
        await page.goto(second.url);
        await expectLight(page);
        await switchTheme(page, 'Включить тёмную тему');
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
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
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(245, 246, 248)');
    await expect(page.getByRole('button', { name: 'Включить тёмную тему', exact: true })).toBeVisible();
}

async function switchTheme(page: Page, name: string): Promise<void> {
    const saved = page.waitForResponse(
        (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
    );
    const button = page.getByRole('button', { name, exact: true });
    await button.focus();
    await button.press('Enter');
    expect((await saved).status()).toBe(200);
}
