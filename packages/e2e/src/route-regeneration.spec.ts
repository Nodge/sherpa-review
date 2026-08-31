import { asRawText, mediumRawResults, sectionFor, submit, takeTask } from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';

test('route: generate → regenerate → ready', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;
    const raw = mediumRawResults();

    await page.goto(server.url);
    expect((await worker.register('claude-code')).code).toBe(0);
    await page.getByRole('tab', { name: 'Route', exact: true }).click();

    await test.step('the first generation reaches ready', async () => {
        const skeleton = await takeTask(worker, 'route.skeleton');
        await submit(worker, skeleton.taskId, raw.skeleton);
        for (let index = 0; index < 6; index += 1) {
            const section = await takeTask(worker, 'route.section');
            await submit(worker, section.taskId, sectionFor(section.planIndexes));
        }

        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('[data-stop]')).toHaveCount(7);
    });

    await test.step('rebuilding preserves the old route and marks until the new plan arrives', async () => {
        const firstStop = page.locator('[data-stop="s01"]');
        const viewed = firstStop.locator('button.route-stop__viewed');
        await expect(viewed).toHaveAccessibleName('Mark viewed');
        await viewed.click();
        await expect(viewed).toHaveAccessibleName('Viewed');

        await page.keyboard.press(`${MOD_KEY}+KeyK`);
        const palette = page.getByRole('dialog', { name: 'Command palette' });
        await palette.getByRole('textbox').fill('Regenerate the route');
        await expect(palette.getByRole('option', { name: /Regenerate the route/ })).toBeVisible();
        await page.keyboard.press('Enter');

        await expect(page.getByText('Building a new route — stop marks go away once it lands')).toBeVisible();
        await expect(page.locator('[data-stop]')).toHaveCount(7);
        await expect(viewed).toHaveAccessibleName('Viewed');
    });

    await test.step('the new plan replaces the old one and the route reaches ready again', async () => {
        const skeleton = await takeTask(worker, 'route.skeleton');
        const complete = await worker.complete(skeleton.taskId, asRawText(raw.skeleton));
        expect(complete.code, `${complete.stdout}${complete.stderr}`).toBe(0);
        expect(complete.stdout).not.toContain('was rejected');

        await expect(page.locator('.route-skeleton-card')).toHaveCount(6);
        await expect(page.locator('[data-stop="s01"] button.route-stop__viewed')).toHaveAccessibleName(
            'Mark viewed',
        );

        for (let index = 0; index < 6; index += 1) {
            const section = await takeTask(worker, 'route.section');
            await submit(worker, section.taskId, sectionFor(section.planIndexes));
        }

        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('.coverage__legend-text')).toHaveText(
            '860 changed lines · 96% explained · 32 lines not explained',
        );
    });
});
