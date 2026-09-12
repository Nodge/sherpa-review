import type { Locator, Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

/**
 * Selecting lines while a selection is already active (docs/design/SPEC-elements.md §2.14). The live range
 * follows only a drag that starts in the gutter. Dragging over lines from the code column
 * or the popover selects other text and leaves the line range alone.
 */
test('the active selection survives text selection and is replaced by a new gutter drag', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Full diff', exact: true }).click();
    await expect(card(page).locator('.diff-row[data-key="a18"]')).toBeAttached();

    await test.step('a gutter drag selects a range', async () => {
        await dragBetween(page, gutter(page, 'a3'), gutter(page, 'a6'));
        await expect(page.locator('.selection-popover__count')).toBeVisible();
        expect(await selectedKeys(page)).toEqual(['a3', 'a4', 'a5', 'a6']);
    });

    await test.step('selecting code text across several lines does not extend the range', async () => {
        await dragBetween(page, code(page, 'a16'), code(page, 'a18'));
        expect(await page.evaluate(() => String(getSelection()).length)).toBeGreaterThan(0);
        expect(await selectedKeys(page)).toEqual(['a3', 'a4', 'a5', 'a6']);
        await expect(page.locator('.selection-popover__count')).toBeVisible();
    });

    await test.step('a drag from the popover onto lines does not extend the range', async () => {
        await dragBetween(page, page.locator('.selection-popover__count'), gutter(page, 'a20'));
        expect(await selectedKeys(page)).toEqual(['a3', 'a4', 'a5', 'a6']);
        await expect(page.locator('.selection-popover__count')).toBeVisible();
    });

    await test.step('a new gutter drag replaces the range', async () => {
        await dragBetween(page, gutter(page, 'a10'), gutter(page, 'a12'));
        expect(await selectedKeys(page)).toEqual(['a10', 'a11', 'a12']);
        await expect(page.locator('.selection-popover__count')).toHaveText('3 lines selected');
    });
});

function card(page: Page): Locator {
    return page.locator('.file-card').filter({ has: page.locator('.diff-row[data-key="a18"]') }).first();
}

function gutter(page: Page, key: string): Locator {
    return card(page).locator(`.diff-row[data-key="${key}"] .diff-row__gutter`).first();
}

function code(page: Page, key: string): Locator {
    return card(page).locator(`.diff-row[data-key="${key}"] .diff-row__code`);
}

function selectedKeys(page: Page): Promise<string[]> {
    return card(page)
        .locator('.diff-row.is-selected')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-key') ?? ''));
}

async function dragBetween(page: Page, from: Locator, to: Locator): Promise<void> {
    await from.scrollIntoViewIfNeeded();
    const start = await from.boundingBox();
    const end = await to.boundingBox();
    if (start === null || end === null) {
        throw new Error('the drag target elements have not rendered');
    }
    // Code column: start and end inside the text, away from the left edge.
    await page.mouse.move(start.x + Math.min(start.width / 2, 40), start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.x + Math.min(end.width / 2, 60), end.y + end.height / 2, { steps: 6 });
    await page.mouse.up();
}
