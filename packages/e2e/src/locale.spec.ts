import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

/**
 * UI language precedence (M5 task breakdown decision 1): explicit setting → session `--lang` label
 * tag → browser language. The spec runs through the full sequence with one state directory: the setting lives
 * in `<sherpaDir>/settings.json`, the session tag in the PR database, and both survive server restarts.
 */

/** The browser uses English: without an agent or a setting, the UI uses it too. */
test.use({ locale: 'en-US' });

const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';

test('language: the setting overrides the agent and the agent overrides the browser', async ({ page, launchSherpa }) => {
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-locale-'));
    try {
        const first = await launchSherpa('fixture-medium', { sherpaDir });

        await test.step('without an agent the language comes from the browser', async () => {
            await page.goto(first.url);
            await expectLocale(page, 'en');
            await expect(page.getByRole('tab', { name: 'Full diff', exact: true })).toBeVisible();
        });

        await test.step('registering a session with --lang ru switches the UI over SSE', async () => {
            const registered = await first.worker.register('claude-code', 'ru');
            expect(registered.code, registered.stderr).toBe(0);

            // No reload or navigation: the tag update arrives on the same stream as the status.
            await expectLocale(page, 'ru');
            await expect(page.getByRole('tab', { name: '\u041f\u043e\u043b\u043d\u044b\u0439 \u0434\u0438\u0444\u0444', exact: true })).toBeVisible(); // the Russian "Full diff" tab
        });

        await test.step('the English palette command overrides the agent', async () => {
            await pickLocaleCommand(page, '\u042f\u0437\u044b\u043a \u0438\u043d\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0430: \u0430\u043d\u0433\u043b\u0438\u0439\u0441\u043a\u0438\u0439'); // "Interface language: English"

            await expectLocale(page, 'en');
            await expect(page.getByRole('tab', { name: 'Full diff', exact: true })).toBeVisible();
        });

        await first.stop();

        const second = await launchSherpa('fixture-medium', { sherpaDir });

        await test.step('the choice stays English after the server restarts', async () => {
            await page.goto(second.url);
            await expectLocale(page, 'en');
            await expect(page.getByRole('tab', { name: 'Full diff', exact: true })).toBeVisible();
        });

        await test.step('auto restores the agent language', async () => {
            await pickLocaleCommand(page, 'Language: auto (from the agent or the browser)');

            await expectLocale(page, 'ru');
            await expect(page.getByRole('tab', { name: '\u041f\u043e\u043b\u043d\u044b\u0439 \u0434\u0438\u0444\u0444', exact: true })).toBeVisible(); // the Russian "Full diff" tab
        });
    } finally {
        await rm(sherpaDir, { recursive: true, force: true });
    }
});

async function expectLocale(page: Page, locale: 'ru' | 'en'): Promise<void> {
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
}

/** Language selection lives in the palette: the design has no separate settings popover. */
async function pickLocaleCommand(page: Page, label: string): Promise<void> {
    // Wait for the setting write itself: the next step may restart the server.
    const saved = page.waitForResponse(
        (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
    );
    await page.keyboard.press(`${MOD_KEY}+KeyK`);
    const palette = page.getByRole('dialog');
    await expect(palette).toBeVisible();
    await palette.getByRole('textbox').fill(label);
    await palette.getByRole('option', { name: label }).first().click();
    await saved;
}
