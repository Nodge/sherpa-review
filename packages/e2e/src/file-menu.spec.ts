import { expect, test } from './sherpa-fixture.js';

/**
 * File context menu (docs/design/SPEC-elements.md §2.11 with the 2026-09-03 amendments):
 * right-clicking a tree row and the "⋯" button in the card header open the same menu. Copy path writes to the clipboard, the viewed mark
 * follows the same chain as the read checkbox, and Esc only closes the menu.
 */

test('file menu: tree right-click, card-header ⋯, clipboard and viewed mark', async ({
    page,
    context,
    launchSherpa,
}) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Full diff', exact: true }).click();

    const menu = page.getByRole('menu');
    const row = page.locator('.file-tree__row--file').first();

    await test.step('right-clicking a tree row opens the menu', async () => {
        await row.click({ button: 'right' });
        await expect(menu.getByRole('menuitem')).toHaveText([
            'Copy path',
            'Copy file link',
            'Open on the web',
            'Viewed',
        ]);
    });

    await test.step('Copy path writes the file path to the clipboard', async () => {
        // The row `title` is "path · reading progress": check the clipboard against the first half.
        const path = (await row.getAttribute('title'))?.split(' · ')[0];
        await menu.getByRole('menuitem', { name: 'Copy path', exact: true }).click();

        await expect(menu).toHaveCount(0);
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(path);
    });

    await test.step('⋯ in the card header marks the file viewed', async () => {
        const card = page.locator('.file-card').first();
        const fileId = await card.getAttribute('data-file');
        const path = await card.locator('.file-card__path').getAttribute('title');
        // The tree row for the same file: its read checkbox must change.
        const rowId = `tree-row-${encodeURIComponent(`file:${String(path)}`)}`;
        const box = page.locator(`[id="${rowId}"] .file-tree__read`);
        await expect(box).toHaveAttribute('aria-pressed', 'false');

        await card.getByRole('button', { name: 'File actions', exact: true }).click();
        await menu.getByRole('menuitem', { name: 'Viewed', exact: true }).click();

        await expect(menu).toHaveCount(0);
        await expect(box).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator(`.file-card[data-file="${String(fileId)}"] .file-card__collapsed--file`)).toContainText(
            'viewed',
        );
    });

    await test.step('Esc only closes the menu', async () => {
        await row.click({ button: 'right' });
        await expect(menu).toHaveCount(1);

        await page.keyboard.press('Escape');

        await expect(menu).toHaveCount(0);
        // The view stays put: Esc handling gave the keypress to the menu and stopped there.
        await expect(page.getByRole('tab', { name: 'Full diff', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );
    });
});
