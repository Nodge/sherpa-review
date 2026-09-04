import type { Locator } from '@playwright/test';

import { mediumRawResults, sectionFor, submit, takeTask } from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

/**
 * A distant stop's diff column is removed from the DOM (M5-T13). Checks what this
 * might break: the section stays in place, the document does not shrink (the placeholder keeps
 * the measured height), and a jump from the coverage bar reaches the unmounted stop. The
 * "section → card" sequence waits for the column to return.
 */
test('route: an unmounted stop keeps its space and accepts a jump', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const raw = mediumRawResults();

    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Route', exact: true }).click();
    expect((await server.worker.register('claude-code')).code).toBe(0);
    const skeleton = await takeTask(server.worker, 'route.skeleton');
    await submit(server.worker, skeleton.taskId, raw.skeleton);
    for (const _sectionIndex of raw.sections.keys()) {
        const section = await takeTask(server.worker, 'route.section');
        await submit(server.worker, section.taskId, sectionFor(section.planIndexes));
    }
    await expect(page.locator('.route-skeleton-card')).toHaveCount(0);

    const route = page.locator('main.route');
    const stops = await page.locator('[data-stop]').count();

    // Walk the route. A stop's column is removed only after it has been on screen and
    // shown all its cards. Height is not measured from skeletons or the start of the list.
    await passRoute(route);

    const target = page.locator('[data-stop]').filter({ has: page.locator('.route-stop__placeholder') }).first();
    let targetId = '';

    await test.step('the column is gone, the section and document height remain', async () => {
        await expect(target).toHaveCount(1);
        targetId = (await target.getAttribute('data-stop')) ?? '';
        expect(targetId).not.toBe('');
        await expect(target.locator('.file-card')).toHaveCount(0);
        // Both top stop selection and jumps count sections. Their number stays the same.
        await expect(page.locator('[data-stop]')).toHaveCount(stops);
    });

    await test.step('the column returns and leaves without changing the section height', async () => {
        const section = page.locator(`[data-stop="${targetId}"]`);
        await section.scrollIntoViewIfNeeded();
        await expect(section.locator('.file-card').first()).toBeAttached();
        const mountedHeight = (await section.boundingBox())?.height ?? 0;
        expect(mountedHeight).toBeGreaterThan(0);

        await route.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        await expect(section.locator('.route-stop__placeholder')).toHaveCount(1);
        const unmountedHeight = (await section.boundingBox())?.height ?? 0;

        // The placeholder keeps the column's exact height, so the document below the section does not move.
        expect(Math.abs(unmountedHeight - mountedHeight)).toBeLessThanOrEqual(2);
    });

    await test.step('a jump from the palette restores the column and reaches the card', async () => {
        // Read the stop's plan number from its sticky column. It stays mounted even when the diff column is gone.
        const number = (await target.locator('.route-stop__number').textContent()) ?? '';
        const label = number.split('/')[0]?.trim() ?? '';
        expect(label).not.toBe('');

        await page.locator('.search-button').click();
        await page.locator('.command-palette__query').fill(`Go to stop ${label}`);
        await page.locator('.command-palette__item').first().click();

        const jumped = page.locator(`[data-stop="${targetId}"]`);
        await expect(jumped.locator('.route-stop__placeholder')).toHaveCount(0);
        await expect(jumped.locator('.file-card').first()).toBeVisible();
    });
});

/** Scroll through the whole route one screen at a time, as a reviewer would. */
async function passRoute(route: Locator): Promise<void> {
    await route.evaluate(async (element) => {
        const frame = (): Promise<unknown> =>
            new Promise((resolve) => {
                requestAnimationFrame(() => {
                    resolve(null);
                });
            });
        for (let top = 0; top <= element.scrollHeight; top += element.clientHeight) {
            element.scrollTop = top;
            // Two frames: the intersection observer reports after a frame, and rendering follows.
            await frame();
            await frame();
        }
        element.scrollTop = element.scrollHeight;
        await frame();
        await frame();
    });
}
