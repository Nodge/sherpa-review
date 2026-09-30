import type { Page } from '@playwright/test';

import type { SherpaServerHandle } from './sherpa-fixture.js';
import { expect, test } from './sherpa-fixture.js';

/**
 * Publishing without a verdict (`comment`) is the third mode in the Ship menu. The draft goes to the host, no one
 * approves the PR or requests changes, the completion screen calls it publishing comments, and the main
 * button remembers the selected mode after a reload.
 */

const DRAFT = 'E2E: a comment without a verdict.';

test('Comment in the Ship menu publishes the draft without a verdict and is remembered', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url);
    const bar = page.locator('.review-action-bar');
    const comment = page.locator('#review-ship-option-2');
    await expect(bar).toContainText('no unpublished comments');

    await test.step('Comment is disabled without drafts', async () => {
        await bar.locator('.review-action-bar__ship-caret').click();
        await expect(comment).toContainText('Comment');
        await expect(comment).toHaveAttribute('aria-disabled', 'true');
        await expect(comment).toHaveAttribute('title', 'no unpublished comments');
        await page.keyboard.press('Escape');
        await expect(page.locator('.review-action-menu')).toHaveCount(0);
    });

    await test.step('the draft appears in the counter and in the Comment menu item', async () => {
        await saveDraft(page, server, DRAFT);
        await expect(bar).toContainText('1 draft goes out when you publish');
        await bar.locator('.review-action-bar__ship-caret').click();
        await expect(comment).toHaveAttribute('aria-disabled', 'false');
        await expect(comment).toContainText('Publishes 1 draft without a verdict');
    });

    await test.step('publishing: the completion screen has no verdict and the draft is published', async () => {
        const saved = page.waitForResponse(
            (response) => response.url().includes('/api/ui/settings') && response.request().method() === 'PATCH',
        );
        await comment.click();

        await expect(page.getByRole('heading', { name: 'Comments published · PR 4821', exact: true })).toBeVisible();
        await expect(page.locator('.review-complete__provenance')).toHaveText(/^comment · [0-9a-f]{7}$/);
        await expect(page.getByText('1 comment published as one batch', { exact: true })).toBeVisible();
        expect((await saved).ok()).toBe(true);

        const published = (await threads(page, server)).find((thread) => thread.root.body === DRAFT);
        expect(published?.root.draft).toBe(false);
    });

    await test.step('the main button remembers Comment after a reload', async () => {
        await page.reload();
        const primary = page.locator('.review-action-bar__ship-primary');
        await expect(primary).toHaveText('Comment');
        // No drafts remain, so Comment has nothing to publish, but the caret still opens the menu.
        await expect(primary).toBeDisabled();
        await expect(page.locator('.review-action-bar__ship-caret')).toBeEnabled();
    });
});

interface HostThread {
    readonly root: { readonly body: string; readonly draft: boolean };
}

function authOf(server: SherpaServerHandle): { readonly origin: string; readonly headers: Record<string, string> } {
    const url = new URL(server.url);
    const token = new URLSearchParams(url.hash.slice(1)).get('t') ?? '';
    return { origin: url.origin, headers: { Authorization: `Bearer ${token}` } };
}

/** A PR-level draft sent through the same endpoint as the composer. */
async function saveDraft(page: Page, server: SherpaServerHandle, body: string): Promise<void> {
    const { origin, headers } = authOf(server);
    const response = await page.request.post(new URL('/api/ui/review/draft', origin).href, {
        headers,
        data: { draft: { body, parentId: null, anchor: null }, clientKey: 'e2e-publish-comment' },
    });
    expect(response.status(), await response.text()).toBe(200);
}

async function threads(page: Page, server: SherpaServerHandle): Promise<readonly HostThread[]> {
    const { origin, headers } = authOf(server);
    const response = await page.request.get(new URL('/api/ui/review/threads', origin).href, { headers });
    expect(response.status(), await response.text()).toBe(200);
    return ((await response.json()) as { readonly threads: readonly HostThread[] }).threads;
}
