import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Page } from '@playwright/test';

import type { ExtraStyleE2e, ExtraStyleGeometry } from './extra-styles.js';
import { loadExtraStyles } from './extra-styles.js';
import { expect, sherpaAuth, test } from './sherpa-fixture.js';

/**
 * Theme and extra build styles. Style scenarios run for each directory
 * `packages/ui/src/styles/extra/<id>/`, with expectations from its `e2e.ts`. A build without these directories
 * checks only the base style and the absence of a toggle.
 */

const STYLES = await loadExtraStyles();

/** Base style geometry (`packages/ui/src/styles/tokens.css`). */
const BASE_GEOMETRY: ExtraStyleGeometry = { codeLineHeight: 20, treeRowHeight: 26, fileNameFont: /IBM Plex Mono/ };

test('Auto follows the system, an explicit theme survives a reload and another PR', async ({ page, launchSherpa }) => {
    const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-theme-'));
    try {
        const first = await launchSherpa('fixture-medium', { sherpaDir });
        const second = await launchSherpa('fixture-large', { sherpaDir });

        // A fresh state root uses Auto. The theme comes from the system and changes without a reload.
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto(first.url);
        await expectDark(page);
        await page.emulateMedia({ colorScheme: 'light' });
        await expectLight(page);

        // An explicit choice stops following the system theme.
        await page.emulateMedia({ colorScheme: 'dark' });
        await switchTheme(page, 'Light');
        await expectLight(page);
        await openFullDiff(page);
        // Light theme's `--code-text` (packages/ui/src/styles/tokens.css).
        await expect(page.locator('.diff-row--add .diff-row__code').first()).toHaveCSS('color', 'rgb(0, 0, 0)');
        await expectGeometry(page, BASE_GEOMETRY);

        // The first frame is already light. The document itself sets the theme, before the endpoint responds.
        expect(await firstHtml(page, first.url)).toContain('data-theme="light"');

        await page.reload();
        await expectLight(page);
        await page.goto(second.url);
        await expectLight(page);

        // Returning to Auto lets the system control the theme again.
        await switchTheme(page, 'Auto');
        await expectDark(page);
        await page.emulateMedia({ colorScheme: 'light' });
        await expectLight(page);
    } finally {
        await rm(sherpaDir, { recursive: true, force: true });
    }
});

test('the settings menu has toggles for exactly the styles included in the build', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const panel = page.locator('.settings-menu__panel');
    await expect(panel.getByRole('group', { name: 'Theme', exact: true })).toBeVisible();

    const switches = panel.getByRole('switch');
    await expect(switches).toHaveCount(STYLES.length);
    for (const [index, style] of STYLES.entries()) {
        await expect(switches.nth(index)).toHaveAccessibleName(style.label.en);
    }
});

test('a nested base style theme sets geometry and virtual positions', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');
    await page.goto(`${server.url}&view=diff`);
    await expectDark(page);
    await expectGeometry(page, BASE_GEOMETRY);

    // As in the gallery cards, change only the subtree theme and leave the settings alone.
    for (const theme of ['light', 'dark']) {
        await setNestedTheme(page, theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expectGeometry(page, BASE_GEOMETRY);
    }
});

for (const style of STYLES) {
    test(`style ${style.id}: the toggle preserves the theme, Auto changes only the palette, the choice survives a reload and another PR`, async ({
        page,
        launchSherpa,
    }) => {
        const sherpaDir = await mkdtemp(path.join(tmpdir(), 'sherpa-e2e-theme-'));
        try {
            const first = await launchSherpa('fixture-medium', { sherpaDir });
            const second = await launchSherpa('fixture-large', { sherpaDir });

            await page.emulateMedia({ colorScheme: 'dark' });
            await page.goto(second.url);
            await switchTheme(page, 'Light');
            await expectLight(page);
            await openFullDiff(page);

            // The style preserves the selected light theme. Both palettes use the same geometry.
            await toggleStyle(page, style, true);
            await expectStyle(page, style, 'light');
            await expectGeometry(page, style.geometry);
            await switchTheme(page, 'Dark');
            await expectStyle(page, style, 'dark');
            await expectGeometry(page, style.geometry);
            expect(await firstHtml(page, second.url)).toContain(`data-theme="${style.id}-dark"`);
            await page.emulateMedia({ colorScheme: 'light' });
            await page.reload();
            await expectStyle(page, style, 'dark');
            await page.goto(first.url);
            await expectStyle(page, style, 'dark');
            await openFullDiff(page);

            // Switching styles with the diff open preserves the theme mode and recalculates virtual positions.
            await toggleStyle(page, style, false);
            await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
            await expectGeometry(page, BASE_GEOMETRY);
            await toggleStyle(page, style, true);
            await expectStyle(page, style, 'dark');
            await expectGeometry(page, style.geometry);

            // Auto changes only the palette, leaving the style enabled.
            await switchTheme(page, 'Auto');
            await expectStyle(page, style, 'light');
            await expectGeometry(page, style.geometry);
            await page.emulateMedia({ colorScheme: 'dark' });
            await expectStyle(page, style, 'dark');
            await expectGeometry(page, style.geometry);
            await toggleStyle(page, style, false);
            await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
            await expectGeometry(page, BASE_GEOMETRY);
            await page.emulateMedia({ colorScheme: 'light' });
            await expectLight(page);
            await expectGeometry(page, BASE_GEOMETRY);

            // The style's light palette also persists for the initial HTML, reloads and another PR.
            await switchTheme(page, 'Light');
            await toggleStyle(page, style, true);
            await expectStyle(page, style, 'light');
            expect(await firstHtml(page, first.url)).toContain(`data-theme="${style.id}-light"`);
            await page.emulateMedia({ colorScheme: 'dark' });
            await page.reload();
            await expectStyle(page, style, 'light');
            await page.goto(second.url);
            await expectStyle(page, style, 'light');
        } finally {
            await rm(sherpaDir, { recursive: true, force: true });
        }
    });

    test(`style ${style.id}: a nested theme sets geometry and virtual positions independently of settings`, async ({
        page,
        launchSherpa,
    }) => {
        const server = await launchSherpa('fixture-large');
        await page.goto(`${server.url}&view=diff`);
        await expectDark(page);
        await expectGeometry(page, BASE_GEOMETRY);

        for (const theme of [`${style.id}-light`, 'light', `${style.id}-dark`, 'dark']) {
            await setNestedTheme(page, theme);
            await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
            await expectGeometry(page, theme.startsWith(`${style.id}-`) ? style.geometry : BASE_GEOMETRY);
        }
    });

    for (const theme of ['dark', 'light'] as const) {
        for (const outcome of ['failed', 'pending'] as const) {
            test(`style ${style.id}, ${theme}: initial HTML and geometry when settings GET ${outcome}`, async ({
                page,
                launchSherpa,
            }) => {
                const server = await launchSherpa('fixture-medium');
                const settingsUrl = new URL('/api/ui/settings', server.url).href;
                const saved = await page.request.patch(settingsUrl, {
                    headers: sherpaAuth(server),
                    data: { theme, style: style.id, textSize: 'l' },
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
                    await expectStyle(page, style, theme);
                    await expect(page.locator('html')).toHaveAttribute('data-textsize', 'l');
                    await expectGeometry(page, style.geometry);

                    // The toggle works even if GET fails. For the light palette, also check
                    // that a late response does not undo the style already selected locally.
                    const changedLocally = outcome === 'failed' || theme === 'light';
                    if (changedLocally) {
                        await toggleStyle(page, style, false);
                        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
                        await expectGeometry(page, BASE_GEOMETRY);
                    }
                    if (outcome === 'pending') {
                        const nextTheme = theme === 'dark' ? 'light' : 'dark';
                        const changed = await page.request.patch(settingsUrl, {
                            headers: sherpaAuth(server),
                            data: { theme: nextTheme, style: changedLocally ? style.id : null, textSize: 'm' },
                        });
                        expect(changed.status()).toBe(200);
                        release();
                        // Size m confirms that the late response applied. The local style choice
                        // remains disabled, while untouched fields accept new values from the server.
                        await expect(page.locator('html')).toHaveAttribute('data-textsize', 'm');
                        await expect(page.locator('html')).toHaveAttribute('data-theme', nextTheme);
                        await expectGeometry(page, BASE_GEOMETRY);
                    }
                } finally {
                    release();
                    await page.unrouteAll({ behavior: 'wait' });
                }
            });
        }
    }
}

async function expectDark(page: Page): Promise<void> {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // Dark theme's `--surface-app` (packages/ui/src/styles/tokens.css).
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(13, 14, 16)');
}

async function expectLight(page: Page): Promise<void> {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
    // Light theme's `--surface-app` (packages/ui/src/styles/tokens.css).
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(246, 247, 249)');
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
}

async function expectStyle(page: Page, style: ExtraStyleE2e, theme: 'dark' | 'light'): Promise<void> {
    await expect(page.locator('html')).toHaveAttribute('data-theme', `${style.id}-${theme}`);
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
    await expect(page.locator('body')).toHaveCSS('background-color', style[theme].background);
    await expect(page.locator('body')).toHaveCSS('font-family', style.fontFamily);
}

async function expectGeometry(page: Page, geometry: ExtraStyleGeometry): Promise<void> {
    await expect(page.locator('.diff-row__code').first()).toHaveCSS('line-height', `${String(geometry.codeLineHeight)}px`);
    await expect(page.locator('.file-tree__row').first()).toHaveCSS('height', `${String(geometry.treeRowHeight)}px`);
    await expect(page.locator('.file-card__name').first()).toHaveCSS('font-family', geometry.fileNameFont);
    await expectTreeSpacing(page, geometry.treeRowHeight);
}

async function openFullDiff(page: Page): Promise<void> {
    await page.getByRole('tab', { name: 'Full diff', exact: true }).click();
    await expect(page.locator('.diff-rows--unified').first()).toBeVisible();
}

/** The document the server returns before the first settings request. */
async function firstHtml(page: Page, url: string): Promise<string> {
    const document = await page.request.get(url.split('#')[0] ?? url);
    return document.text();
}

async function setNestedTheme(page: Page, theme: string): Promise<void> {
    await page.locator('#root').evaluate((root, value) => { root.setAttribute('data-theme', value); }, theme);
}

/** An independent switch saves the style without changing the theme segment. */
async function toggleStyle(page: Page, style: ExtraStyleE2e, enabled: boolean): Promise<void> {
    const saved = page.waitForResponse(
        (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const toggle = page.locator('.settings-menu__panel').getByRole('switch', { name: style.label.en, exact: true });
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
