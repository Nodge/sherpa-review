import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, sherpaAuth, test } from './sherpa-fixture.js';

test('Auto follows the system, the theme choice survives reloads and another PR', async ({
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
        await page.getByRole('tab', { name: 'Full diff', exact: true }).click();

        
        
        
        await expectGeometry(page, true);
        await switchTheme(page, 'Тёмная');
        
        await expectGeometry(page, true);
        
        
        await page.emulateMedia({ colorScheme: 'light' });
        await page.reload();
        
        await page.goto(first.url);
        
        await page.getByRole('tab', { name: 'Full diff', exact: true }).click();

        // Switching styles in an open diff preserves the theme mode and recalculates virtual positions.
        
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expectGeometry(page, false);
        
        
        await expectGeometry(page, true);

        
        await switchTheme(page, 'Auto');
        
        await expectGeometry(page, true);
        await page.emulateMedia({ colorScheme: 'dark' });
        
        await expectGeometry(page, true);
        
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expectGeometry(page, false);
        await page.emulateMedia({ colorScheme: 'light' });
        await expectLight(page);
        await expectGeometry(page, false);

        
        await switchTheme(page, 'Light');
        
        
        
        
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.reload();
        
        await page.goto(second.url);
        
    } finally {
        await rm(sherpaDir, { recursive: true, force: true });
    }
});

test('a nested theme sets geometry and virtual positions independently of settings', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');
    await page.goto(`${server.url}&view=diff`);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectGeometry(page, false);

    // As in the gallery cards, change only the subtree theme and leave the settings alone.
    for (const theme of ['light', 'dark']) {
        await page.locator('#root').evaluate((root, value) => { root.setAttribute('data-theme', value); }, theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expectGeometry(page);
    }
});

for (const theme of ['dark', 'light'] as const) {
    for (const outcome of ['failed', 'pending'] as const) {
        
            const server = await launchSherpa('fixture-medium');
            const settingsUrl = new URL('/api/ui/settings', server.url).href;
            const saved = await page.request.patch(settingsUrl, {
                headers: sherpaAuth(server),
                data: { theme, textSize: 'l' },
            });
            expect(saved.status()).toBe(200);

            let release = (): void => undefined;
            const pending = new Promise<void>((resolve) => { release = resolve; });
            await page.route('**/api/ui/settings', async (route) => {
                if (route.request().method() !== 'GET') {
                    await route.continue();
                } else if (outcome === 'failed') {
                    await route.abort();
                } else {
                    await pending;
                    await route.continue();
                }
            });
            try {
                await page.goto(`${server.url}&view=diff`);
                
                await expect(page.locator('html')).toHaveAttribute('data-textsize', 'l');
                await expectGeometry(page, true);

                // The switch works even if GET fails. For the light palette, also check
                // that a late response does not override the locally selected style.
                const changedLocally = outcome === 'failed' || theme === 'light';
                if (changedLocally) {
                    
                    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
                    await expectGeometry(page, false);
                }
                if (outcome === 'pending') {
                    const nextTheme = theme === 'dark' ? 'light' : 'dark';
                    const changed = await page.request.patch(settingsUrl, {
                        headers: sherpaAuth(server),
                        data: { theme: nextTheme, textSize: 'm' },
                    });
                    expect(changed.status()).toBe(200);
                    release();
                    // Size m confirms that the late response was applied. The local flag
                    // stays false, while untouched fields take the new values from the server.
                    await expect(page.locator('html')).toHaveAttribute('data-textsize', 'm');
                    await expect(page.locator('html')).toHaveAttribute('data-theme', nextTheme);
                    await expectGeometry(page, false);
                }
            } finally {
                release();
                await page.unrouteAll({ behavior: 'wait' });
            }
        });
    }
}

async function expectLight(page: Page): Promise<void> {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
    // Light theme's `--surface-app` (packages/ui/src/styles/tokens.css).
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(246, 247, 249)');
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
}


    
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
    await expect(page.locator('body')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(45, 44, 51)' : 'rgb(255, 255, 255)');
    
}

async function expectGeometry(page: Page): Promise<void> {
    await expect(page.locator('.diff-row__code').first()).toHaveCSS('line-height', '20px');
    await expect(page.locator('.file-tree__row').first()).toHaveCSS('height', '26px');
    await expect(page.locator('.file-card__name').first()).toHaveCSS('font-family', /IBM Plex Mono/);
    await expectTreeSpacing(page, 26);
}

/** An independent switch saves the style without changing the theme segment. */

    const saved = page.waitForResponse(
        (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    
    await expect(toggle).toHaveAttribute('aria-checked', String(!enabled));
    await toggle.focus();
    await toggle.press('Enter');
    expect((await saved).status()).toBe(200);
    await expect(toggle).toHaveAttribute('aria-checked', String(enabled));
    await page.keyboard.press('Escape');
    await expect(page.locator('.settings-menu__panel')).toHaveCount(0);
}

/** The theme is switched by a segment in the settings menu. Esc closes it like any other popover. */
async function switchTheme(page: Page, name: string): Promise<void> {
    const saved = page.waitForResponse(
        (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const segment = page.locator('.settings-menu__panel')
        .getByRole('group', { name: 'Theme', exact: true })
        .getByRole('button', { name, exact: true });
    await segment.focus();
    await segment.press('Enter');
    expect((await saved).status()).toBe(200);
    await expect(segment).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('.settings-menu__panel')).toHaveCount(0);
}

/** Virtual positions must change along with CSS height, otherwise rows overlap. */
async function expectTreeSpacing(page: Page, height: number): Promise<void> {
    await expect.poll(async () => page.locator('.file-tree__row').evaluateAll((rows) => {
        const first = rows[0];
        const second = rows[1];
        return first && second ? second.getBoundingClientRect().top - first.getBoundingClientRect().top : 0;
    })).toBe(height);
}
