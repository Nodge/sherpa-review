import type { Locator, Page } from '@playwright/test';

import { buildRoute, buildRouteV2 } from './route-worker.js';
import { advanceIteration, expect, test } from './sherpa-fixture.js';

/**
 * The full key map from docs/design/SPEC-elements.md §5: one check per map row, plus
 * chord cancellation and Esc handling order. A fake worker builds the route. Without it, half the map is unavailable.
 */

const MOD_KEY = process.platform === 'darwin' ? 'Meta' : 'Control';
const DRAFT = 'E2E keyboard: draft from the c key.';
const REPLY = 'E2E keyboard: reply from the r key.';

test('keyboard: the SPEC-elements §5 map on fixture-medium', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    await test.step('the route is ready', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Route', exact: true }).click();
        expect((await worker.register('claude-code')).code).toBe(0);
        await buildRoute(worker);
        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('[data-stop]')).toHaveCount(7);
    });

    await test.step('⌘K opens the palette and Esc closes it', async () => {
        await page.keyboard.press(`${MOD_KEY}+KeyK`);
        await expect(palette(page)).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(palette(page)).toHaveCount(0);
    });

    await test.step('1 / 2 / 3 switch views', async () => {
        await page.keyboard.press('3');
        await expectView(page, 'Full diff');

        await page.keyboard.press('1');
        await expectView(page, 'Overview');

        await page.keyboard.press('2');
        await expectView(page, 'Route');
    });

    await test.step('g o / g r / g d chords navigate between views', async () => {
        await page.keyboard.press('g');
        await page.keyboard.press('d');
        await expectView(page, 'Full diff');

        await page.keyboard.press('g');
        await page.keyboard.press('o');
        await expectView(page, 'Overview');

        await page.keyboard.press('g');
        await page.keyboard.press('r');
        await expectView(page, 'Route');
    });

    await test.step('the chord is canceled by a timeout or an unrelated key', async () => {
        // The one-second timeout expired: `d` now toggles the mode instead of completing the chord.
        await page.keyboard.press('g');
        await page.waitForTimeout(1300);
        await page.keyboard.press('3');
        await expectView(page, 'Full diff');
        await page.keyboard.press('2');
        await expectView(page, 'Route');

        // An unrelated key cancels the chord and performs its own action: `x` collapses the focused stop.
        const stop = page.locator('[data-stop="s01"]');
        await stop.scrollIntoViewIfNeeded();
        await focusStop(page, 's01');
        await page.keyboard.press('g');
        await page.keyboard.press('x');
        await expect(stop.locator('.route-collapsed')).toHaveCount(1);
        await expectView(page, 'Route');

        await focusStop(page, 's01');
        await page.keyboard.press('x');
        await expect(stop.locator('.route-collapsed')).toHaveCount(0);
    });

    await test.step('j / k navigate between route stops', async () => {
        await scrollRouteToTop(page);

        await page.keyboard.press('j');
        const afterNext = await settledRouteScroll(page);
        expect(afterNext).toBeGreaterThan(0);

        await page.keyboard.press('k');
        expect(await settledRouteScroll(page)).toBeLessThan(afterNext);
    });

    await test.step('n / p navigate between unviewed stops', async () => {
        await scrollRouteToTop(page);

        await page.keyboard.press('n');
        const afterNext = await settledRouteScroll(page);
        expect(afterNext).toBeGreaterThan(0);

        await page.keyboard.press('p');
        expect(await settledRouteScroll(page)).toBeLessThan(afterNext);
    });

    await test.step('v marks the focused stop', async () => {
        const toggle = page.locator('[data-stop="s02"] button.route-stop__viewed');
        await toggle.scrollIntoViewIfNeeded();
        await focusStop(page, 's02');
        await page.keyboard.press('v');
        await expect(toggle).toHaveAttribute('aria-pressed', 'true');

        await focusStop(page, 's02');
        await page.keyboard.press('v');
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    });

    await test.step('c comments on the focused line and ⌘⏎ saves the draft', async () => {
        await scrollRouteToTop(page);
        const stop = page.locator('[data-stop="s01"]');
        const line = stop.locator('.diff-row[tabindex="0"]').first();
        await line.scrollIntoViewIfNeeded();
        await line.focus();
        await page.keyboard.press('c');

        const composer = stop.locator('.diff-line-composer');
        await expect(composer).toBeVisible();
        const textbox = stop.getByRole('textbox', { name: 'New comment' });
        await textbox.fill(DRAFT);
        await page.keyboard.press(`${MOD_KEY}+Enter`);
        await expect(textbox).toHaveCount(0, { timeout: 6_000 });
        await expect(stop.getByText(DRAFT, { exact: true })).toBeVisible();
    });

    await test.step('r replies to the focused thread', async () => {
        // An unpublished draft of our own cannot take replies, so use someone else's thread: Reply is
        // a link below every published message (SPEC-changes-2026-09-20 §3).
        const repliable = page
            .locator('[data-stop] .thread')
            .filter({ has: page.getByRole('button', { name: 'Reply', exact: true }) })
            .first();
        await repliable.scrollIntoViewIfNeeded();
        const threadId = await repliable.getAttribute('data-thread-id');
        const thread = page.locator(`[data-stop] .thread[data-thread-id="${String(threadId)}"]`);
        await thread.focus();
        await page.keyboard.press('r');

        const reply = thread.getByRole('textbox', { name: 'Thread reply' });
        await expect(reply).toBeVisible();
        await reply.fill(REPLY);
        await page.keyboard.press(`${MOD_KEY}+Enter`);
        await expect(reply).toHaveCount(0, { timeout: 6_000 });
        await expect(thread.getByText(REPLY, { exact: true })).toBeVisible();
    });

    await test.step('f on the route opens the palette in file mode', async () => {
        await page.locator('.route-toolbar').click();
        await page.keyboard.press('f');
        await expect(palette(page)).toBeVisible();
        await expect(palette(page).getByRole('textbox')).toHaveAttribute('placeholder', 'File…');

        await page.keyboard.press('Escape');
        await expect(palette(page)).toHaveCount(0);
    });

    await test.step('Find file in the palette does not leave file mode active on the next open', async () => {
        await page.keyboard.press(`${MOD_KEY}+KeyK`);
        await palette(page).getByRole('textbox').fill('Find a file');
        await page.keyboard.press('Enter');
        await expect(palette(page).getByRole('textbox')).toHaveAttribute('placeholder', 'File…');

        await page.keyboard.press('Escape');
        await expect(palette(page)).toHaveCount(0);

        await page.keyboard.press(`${MOD_KEY}+KeyK`);
        await expect(palette(page).getByRole('textbox')).not.toHaveAttribute('placeholder', 'File…');
        await page.keyboard.press('Escape');
        await expect(palette(page)).toHaveCount(0);
    });

    await test.step('t switches the preset', async () => {
        await page.keyboard.press('t');
        await expect(page.getByRole('button', { name: 'Full tour', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await page.keyboard.press('t');
        await expect(page.getByRole('button', { name: 'Triage', exact: true })).toHaveAttribute('aria-pressed', 'true');
    });

    await test.step('/ opens the palette in diff search mode', async () => {
        await page.keyboard.press('/');
        await expect(palette(page)).toBeVisible();
        await expect(palette(page).getByRole('textbox')).toHaveValue('/');

        await page.keyboard.press('Escape');
        await expect(palette(page)).toHaveCount(0);
    });

    await test.step('? opens the shortcuts sheet and Esc closes it', async () => {
        await page.keyboard.press('?');
        const cheatsheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
        await expect(cheatsheet).toBeVisible();
        // The shortcuts sheet uses the active scope registry: it has route commands, but no file commands.
        await expect(cheatsheet).toContainText('Next stop');
        await expect(cheatsheet).not.toContainText('Next file');
        await expect(cheatsheet.locator('kbd').first()).toHaveText('⌘K');

        await page.keyboard.press('Escape');
        await expect(cheatsheet).toHaveCount(0);
    });

    await test.step('a without a selection opens the chat with a question about the PR', async () => {
        await page.keyboard.press('a');
        await expect(page.locator('.chat-panel')).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'Question to the agent' })).toBeFocused();

        await page.getByRole('button', { name: 'Close chat', exact: true }).click();
        await expect(page.locator('.chat-panel')).toHaveCount(0);
    });

    await test.step('j / k / n / p navigate between files in the full diff', async () => {
        await page.keyboard.press('3');
        await expectView(page, 'Full diff');
        await expect(page.locator('.file-card').first()).toBeVisible();
        await scrollDiffToTop(page);

        await page.keyboard.press('j');
        const afterNext = await settledDiffScroll(page);
        expect(afterNext).toBeGreaterThan(0);

        await page.keyboard.press('k');
        expect(await settledDiffScroll(page)).toBeLessThan(afterNext);

        await scrollDiffToTop(page);
        await page.keyboard.press('n');
        const afterUnread = await settledDiffScroll(page);
        expect(afterUnread).toBeGreaterThan(0);

        await page.keyboard.press('p');
        expect(await settledDiffScroll(page)).toBeLessThan(afterUnread);
    });

    await test.step('thread marker: tab stop, Enter and Space, collapsed thread leaves the DOM', async () => {
        const marker = page.locator('.file-card .thread-marker').first();
        await marker.scrollIntoViewIfNeeded();
        await expect(marker).toBeVisible();
        const lines = page.locator('.file-card .thread-line');
        // All threads except resolved ones are expanded by default (docs/decisions.md, 2026-09-21).
        await expect(marker).toHaveAttribute('aria-expanded', 'true');
        const open = await lines.count();
        expect(open).toBeGreaterThan(0);

        await marker.focus();
        await expect(marker).toBeFocused();

        await page.keyboard.press('Enter');
        await expect(marker).toHaveAttribute('aria-expanded', 'false');
        await expect(lines).toHaveCount(open - 1);

        await page.keyboard.press('Space');
        await expect(marker).toHaveAttribute('aria-expanded', 'true');
        await expect(lines).toHaveCount(open);
    });

    await test.step('Esc handling: palette above a selection, then the selection itself', async () => {
        await scrollDiffToTop(page);
        await dragSelectFirstLines(page);
        await expect(page.locator('.selection-popover__count')).toBeVisible();

        await page.keyboard.press(`${MOD_KEY}+KeyK`);
        await expect(palette(page)).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(palette(page)).toHaveCount(0);
        await expect(page.locator('.selection-popover__count')).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(page.locator('.selection-popover__count')).toHaveCount(0);
    });

    await test.step('d switches the diff mode', async () => {
        // The toggle names the mode the diff is currently rendered in, so check against it.
        const toggle = page.locator('.diff-mode-toggle');
        await expect(toggle).toBeEnabled();
        const before = await toggle.textContent();

        await page.keyboard.press('d');
        await expect.poll(() => toggle.textContent()).not.toBe(before);

        await page.keyboard.press('d');
        await expect.poll(() => toggle.textContent()).toBe(before);
    });

    await test.step('v in the tree marks the file under the pointer viewed', async () => {
        const tree = page.getByRole('tree', { name: 'File tree' });
        const row = page.locator('.file-tree__row--file').first();
        await row.click();
        await tree.focus();
        await page.keyboard.press('v');
        await expect(page.locator('.file-tree__row--file.is-cursor .file-tree__read')).toHaveAttribute(
            'aria-pressed',
            'true',
        );
    });

    await test.step('e expands context for the focused hunk', async () => {
        // Marking the file in the previous step collapsed the card and started scrolling to the target:
        // while the list moves, the virtualizer removes the rows we found from the DOM.
        await settledDiffScroll(page);
        await scrollDiffToTop(page);
        await settledDiffScroll(page);

        const { file, key, hidden, rowKey } = await findInnerGap(page, 21);
        // Address the row by its own key, rather than its position next to the gap: the locator survives
        // list rerenders, and Playwright finds the current element when it retries.
        const row = page.locator(`[data-file="${file}"] [data-key="${rowKey}"][tabindex="0"]`).first();
        await row.scrollIntoViewIfNeeded();
        await expect(row).toBeVisible();
        await row.focus();
        await page.keyboard.press('e');

        await expect.poll(() => gapHidden(page, file, key)).toBeLessThan(hidden);
    });

    await test.step('⌘⏎ opens the ship menu and Esc closes it', async () => {
        await page.keyboard.press(`${MOD_KEY}+Enter`);
        const menu = page.getByRole('listbox', { name: 'Ship mode' });
        await expect(menu).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
    });

    await test.step('⌘⇧⏎ submits request changes', async () => {
        await page.keyboard.press(`${MOD_KEY}+Shift+Enter`);
        await expect(page.locator('.review-complete')).toBeVisible({ timeout: 20_000 });
    });
});

test('keyboard: w toggles the what is new filter on the second pass', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Route', exact: true }).click();
    expect((await worker.register('claude-code')).code).toBe(0);
    await buildRoute(worker);
    await expect(page.locator('[data-stop]')).toHaveCount(7);

    await advanceIteration(page, server);
    await page
        .locator('.iteration-banner[aria-label="Route is stale"] button.iteration-banner__action')
        .click();
    await buildRouteV2(worker);
    await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
    await expect(page.locator('[data-stop]')).toHaveCount(7);

    await page.locator('.route-toolbar').click();
    await page.keyboard.press('w');
    await expect(page.locator('.route-toolbar__filters button.route-change-chip')).toHaveText(
        'Showing changes since the previous pass',
    );

    await page.keyboard.press('w');
    await expect(page.locator('.route-toolbar__filters button.route-change-chip')).toHaveCount(0);
});

function palette(page: Page): Locator {
    return page.getByRole('dialog', { name: 'Command palette' });
}

async function expectView(page: Page, label: string): Promise<void> {
    await expect(page.getByRole('tab', { name: label, exact: true })).toHaveAttribute('aria-selected', 'true');
}

/** Focus inside a stop section: `v`/`x` commands use the focused `[data-stop]`. */
async function focusStop(page: Page, stopId: string): Promise<void> {
    await page.locator(`[data-stop="${stopId}"] button`).first().focus();
}

function routeScroller(page: Page): Locator {
    return page.locator('.route');
}

async function routeScrollTop(page: Page): Promise<number> {
    return routeScroller(page).evaluate((element) => element.scrollTop);
}

/** Return to the top: scrolling from the previous jump may pull the container back, so retry. */
async function scrollRouteToTop(page: Page): Promise<void> {
    await expect
        .poll(async () => {
            await routeScroller(page).evaluate((element) => {
                element.scrollTop = 0;
            });
            return routeScrollTop(page);
        })
        .toBeLessThan(5);
}

/** Scrolling after a jump: it adjusts over several frames, so measure once it settles. */
async function settled(read: () => Promise<number>): Promise<number> {
    let last = Number.NaN;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const value = await read();
        if (value === last) {
            return value;
        }
        last = value;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return last;
}

async function settledRouteScroll(page: Page): Promise<number> {
    return settled(() => routeScrollTop(page));
}

async function settledDiffScroll(page: Page): Promise<number> {
    return settled(() => diffScrollTop(page));
}

async function diffScrollTop(page: Page): Promise<number> {
    return page.locator('.full-diff').evaluate((element) => element.scrollTop);
}

async function scrollDiffToTop(page: Page): Promise<void> {
    await expect
        .poll(async () => {
            await page.locator('.full-diff').evaluate((element) => {
                element.scrollTop = 0;
            });
            return diffScrollTop(page);
        })
        .toBeLessThan(5);
}

interface InnerGap {
    /** Gap and row keys are unique only within a file, so the address always includes the file. */
    readonly file: string;
    readonly key: string;
    readonly hidden: number;
    /** The key of the first focusable row below the gap, which is the row `e` will act on. */
    readonly rowKey: string;
}

/**
 * The first visible internal gap with at least `minimumHidden` lines left (as in the F spec
 * for context), and the row below it. The list is virtualized and renders asynchronously, so
 * the lookup waits instead of reading the DOM once.
 */
async function findInnerGap(page: Page, minimumHidden: number): Promise<InnerGap> {
    const probe = async (): Promise<InnerGap | null> =>
        page.locator('.full-diff').evaluate((root, minimum) => {
            for (const gap of root.querySelectorAll('.diff-gap[data-edge="inner"]')) {
                const hidden = Number(gap.getAttribute('data-hidden'));
                const file = gap.closest('[data-file]')?.getAttribute('data-file') ?? '';
                if (!(hidden >= minimum) || file === '') {
                    continue;
                }
                for (let node = gap.nextElementSibling; node !== null; node = node.nextElementSibling) {
                    const focusable = node.matches('[tabindex="0"][data-key]')
                        ? node
                        : node.querySelector('[tabindex="0"][data-key]');
                    if (focusable !== null) {
                        return {
                            file,
                            key: gap.getAttribute('data-gap-key') ?? '',
                            hidden,
                            rowKey: focusable.getAttribute('data-key') ?? '',
                        };
                    }
                }
            }
            return null;
        }, minimumHidden);

    await expect
        .poll(async () => (await probe()) !== null, {
            message: `no visible gap with >= ${String(minimumHidden)} lines left`,
        })
        .toBe(true);
    const found = await probe();
    if (found === null) {
        throw new Error(`gap with >= ${String(minimumHidden)} lines left disappeared from the DOM`);
    }
    return found;
}

/** Lines left in the gap. A gap that disappears is fully expanded: zero, not a missing number. */
async function gapHidden(page: Page, file: string, key: string): Promise<number> {
    return page
        .locator(`[data-file="${file}"] .diff-gap[data-gap-key="${key}"]`)
        .evaluateAll((elements) => (elements[0] === undefined ? 0 : Number(elements[0].getAttribute('data-hidden'))));
}

/** Drag along the gutter across three lines of one card, as in F2. */
async function dragSelectFirstLines(page: Page): Promise<void> {
    const card = page
        .locator('.file-card')
        .filter({ has: page.locator('.diff-row[data-key]') })
        .first();
    const rows = card.locator('.diff-row[data-key]');
    await rows.nth(0).scrollIntoViewIfNeeded();
    const from = await rows.nth(0).locator('.diff-row__gutter').first().boundingBox();
    const to = await rows.nth(2).locator('.diff-row__gutter').first().boundingBox();
    if (from === null || to === null) {
        throw new Error('the lines to select have not rendered');
    }
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
    await page.mouse.up();
}
