import type { Locator, Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

/**
 * The floating action bar centers on the content column, not the window. With
 * docked chat (≥1280), it does not overlap the chat on X. In overlay mode (<1280),
 * it sits under the scrim, and final actions wait until chat closes, including shortcuts that
 * the scrim alone would not stop.
 */

/** Docked chat width, `components/chat-panel.css`. */
const CHAT_WIDTH = 392;
/** Verdict endpoint, `protocol/ui.ts`, `UI_ENDPOINTS.reviewPublish`. */
const PUBLISH_ENDPOINT = '/api/ui/review/publish';

test('action bar makes room for docked chat at 1440', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.url);
    // The indicator opens chat only for a connected agent. No route needs to be built.
    expect((await server.worker.register('claude-code')).code).toBe(0);

    const bar = page.locator('.review-action-bar');
    await expect(bar).toBeVisible();
    const closedCenter = await centerX(bar);
    expect(closedCenter).toBeCloseTo(1440 / 2, 0);

    await page.locator('.agent-pill').click();
    const chat = page.locator('.chat-panel');
    await expect(chat).toBeVisible();

    // The move is animated. Wait for its endpoint instead of the first frame after chat opens.
    await expect
        .poll(() => centerX(bar), { message: 'bar centered on the content column' })
        .toBeCloseTo((1440 - CHAT_WIDTH) / 2, 0);

    const barBox = await box(bar);
    const chatBox = await box(chat);
    expect(barBox.x + barBox.width, 'right edge of the bar is left of chat').toBeLessThanOrEqual(chatBox.x);

    // Closing chat returns the bar to the window center. The move is animated, but the endpoint is the same.
    await page.locator('.agent-pill').click();
    await expect(chat).toHaveCount(0);
    await expect.poll(() => centerX(bar)).toBeCloseTo(1440 / 2, 0);
});

test('action bar sits under the overlay chat scrim at 1024', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(server.url);
    expect((await server.worker.register('claude-code')).code).toBe(0);

    const bar = page.locator('.review-action-bar');
    await expect(bar).toBeVisible();

    await page.locator('.agent-pill').click();
    await expect(page.locator('.chat-panel')).toBeVisible();
    await expect(page.locator('.chat-panel-scrim')).toBeVisible();

    const barBox = await box(bar);
    const point: [number, number] = [barBox.x + barBox.width / 2, barBox.y + barBox.height / 2];
    // The scrim intercepts clicks at the bar center. The same root class reorders the bar layer.
    await expect
        .poll(() => elementAt(page, point), { message: 'the bar itself is at its center point' })
        .toContain('chat-panel-scrim');

    // The scrim blocks the mouse but not the keyboard. The same flag disables publishing shortcuts.
    // Move focus out of the composer. In chat, any click on the conversation removes it.
    const publishRequests: string[] = [];
    page.on('request', (request) => {
        if (request.url().includes(PUBLISH_ENDPOINT)) {
            publishRequests.push(request.url());
        }
    });
    await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
    });

    await page.keyboard.press('ControlOrMeta+Shift+Enter');
    await page.keyboard.press('ControlOrMeta+Enter');
    // This is a negative check: both the publish request and the menu would appear in the same frame as the keypress,
    // so wait a fixed interval instead of accepting the first matching automatic retry.
    await page.waitForTimeout(1000);
    expect(publishRequests, 'verdict bypassed the covered bar').toEqual([]);
    await expect(page.locator('.review-complete')).toHaveCount(0);
    await expect(page.locator('.review-action-menu')).toHaveCount(0);

    // Control: the same key works after chat closes. Only this mode suppresses shortcuts.
    await page.locator('.chat-panel-scrim').click();
    await expect(page.locator('.chat-panel')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.locator('.review-action-menu')).toBeVisible();
});

test('docked chat leaves bar shortcuts working', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.url);
    expect((await server.worker.register('claude-code')).code).toBe(0);

    await expect(page.locator('.review-action-bar')).toBeVisible();
    await page.locator('.agent-pill').click();
    await expect(page.locator('.chat-panel')).toBeVisible();

    await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
    });
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.locator('.review-action-menu')).toBeVisible();
});

/** Classes of the topmost element at a point. Only a hit test reveals what covers the floating bar. */
function elementAt(page: Page, point: readonly [number, number]): Promise<string> {
    return page.evaluate(([x, y]) => {
        const element = document.elementFromPoint(x, y);
        return element === null ? 'nothing' : `${element.tagName} ${element.getAttribute('class') ?? ''}`;
    }, point);
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
    const found = await locator.boundingBox();
    if (found === null) {
        throw new Error('element has no geometry');
    }
    return found;
}

async function centerX(locator: Locator): Promise<number> {
    const found = await box(locator);
    return found.x + found.width / 2;
}
