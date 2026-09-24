import type { Locator, Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

interface GapGeometry {
    readonly upLeft: number;
    readonly downLeft: number;
    readonly counterLeft: number;
    readonly upWidth: number;
    readonly upHeight: number;
    readonly gapHeight: number;
    /** Counter top and bottom relative to the row top. Outside means the counter moved to another grid row. */
    readonly counterTop: number;
    readonly counterBottom: number;
}

/** Hidden-line count label with English plural forms, matching `diff.gap.hiddenCount` in the UI dictionary. */
function hiddenLabel(count: number): string {
    const one = new Intl.PluralRules('en-US').select(count) === 'one';
    // English has two forms: `one` for 1 and `other` for zero and every count above one.
    if (one) {
        return `${String(count)} line hidden`;
    }
    if (count === 0) {
        return `${String(count)} lines hidden`;
    }
    return `${String(count)} lines hidden`;
}

for (const mode of ['unified', 'split'] as const) {
    test(`gap expands context in the chosen direction without moving the grid or scroll position: ${mode}`, async ({
        page,
        launchSherpa,
    }) => {
        const server = await launchSherpa('fixture-medium');
        await page.goto(server.url);
        await openFullDiff(page, mode);
        await checkDirection(page, mode, 'up');

        await page.reload();
        await openFullDiff(page, mode);
        await checkDirection(page, mode, 'down');
    });
}

async function openFullDiff(page: Page, mode: 'unified' | 'split'): Promise<void> {
    await page.getByRole('tab', { name: 'Full diff', exact: true }).click();
    // The diff mode is global and survives reloads, so inspect
    // what is rendered instead of the stored selection.
    await expect(page.locator('.diff-rows').first()).toBeVisible();
    if ((await page.locator(`.diff-rows--${mode}`).count()) === 0) {
        await page.locator('.diff-mode-toggle').click();
    }
    await expect(page.locator(`.diff-rows--${mode}`).first()).toBeVisible();
    await expect.poll(() => page.locator('.diff-gap[data-edge="inner"]').count()).toBeGreaterThan(0);
}

async function checkDirection(page: Page, mode: 'unified' | 'split', direction: 'up' | 'down'): Promise<void> {
    const gap = await findInnerGap(page, 21);
    await gap.scrollIntoViewIfNeeded();
    await expect(gap).toBeVisible();

    const initialHidden = Number(await gap.getAttribute('data-hidden'));
    const adjacent = await adjacentNewLine(gap, direction === 'up' ? 'previous' : 'next');
    const beforeGeometry = await gapGeometry(gap);
    // The counter shares a grid row with the targets. In split mode its column is left of the down target,
    // and auto-placement once dropped it into the second row, leaving clipped text outside the row.
    expect(beforeGeometry.counterTop).toBeGreaterThanOrEqual(0);
    expect(beforeGeometry.counterBottom).toBeLessThanOrEqual(beforeGeometry.gapHeight);
    const beforeScroll = await page.locator('.full-diff').evaluate((element) => element.scrollTop);
    const target = gap.locator(`button[data-direction="${direction}"]`);

    await expect(target).toHaveAttribute(
        'aria-label',
        `load 20 lines ${direction === 'up' ? 'up' : 'down'}, ${hiddenLabel(initialHidden)}`,
    );
    // The target spans the whole line-number column, whose width depends on the card's line-number digit count:
    // compare with the neighboring code row column instead of a fixed number.
    const widths = await targetAndGutterWidth(target, mode, direction);
    expect(widths.target).toBeCloseTo(widths.gutter, 1);
    expect(widths.target).toBeGreaterThanOrEqual(24);
    await expect(target).toHaveCSS('height', '24px');
    if (direction === 'up') {
        await gap.focus();
        await page.keyboard.press('ArrowRight');
        const down = gap.locator('button[data-direction="down"]');
        await expect(down).toHaveClass(/is-active/);
        await expect(down).toHaveAttribute('aria-checked', 'true');
        await expect(gap).toHaveAttribute('aria-activedescendant', await down.getAttribute('id') ?? '');
        await page.keyboard.press('ArrowLeft');
        await expect(target).toHaveClass(/is-active/);
        await expect(target).toHaveAttribute('aria-checked', 'true');
    }
    await target.hover();
    await expect(gap.locator('.diff-gap__counter')).toContainText(
        new RegExp(`\\+20 lines ${direction === 'up' ? 'up' : 'down'} · ${String(initialHidden)} unchanged`),
    );
    // Hover changes only the target background (SPEC-changes-2026-09-20.md §5). The adjacent counter
    // keeps the dark theme's `--text-dim-strong` (packages/ui/src/styles/tokens.css).
    await expect(gap.locator('.diff-gap__counter')).toHaveCSS('color', 'rgb(218, 228, 243)');
    if (direction === 'down') {
        // Hover leaves the keyboard selection alone. Only ←/→ switches the arrow.
        await gap.focus();
        await page.keyboard.press('ArrowRight');
        await expect(target).toHaveClass(/is-active/);
        await page.keyboard.press('Enter');
    } else {
        await target.click();
    }

    const remaining = initialHidden - 20;
    await expect(gap).toHaveAttribute('data-hidden', String(remaining));
    const revealed = await immediateContextNewLine(gap, direction === 'up' ? 'previous' : 'next');
    expect(revealed).toBe(direction === 'up' ? adjacent + 20 : adjacent - 20);
    expect(await page.locator('.full-diff').evaluate((element) => element.scrollTop)).toBe(beforeScroll);
    expect(await gapGeometry(gap)).toEqual(beforeGeometry);
    await expect(gap.locator('.diff-gap__counter')).toHaveText(`${String(remaining)} unchanged lines`);
    await expect(gap.locator('.diff-gap__counter')).toHaveCSS('pointer-events', 'none');
}

/**
 * Width of the target and its line-number column, measured on a code row in the same card:
 * up is the first column, down is the new-line column (unified) or the right-side line-number column (split).
 */
async function targetAndGutterWidth(
    target: Locator,
    mode: 'unified' | 'split',
    direction: 'up' | 'down',
): Promise<{ readonly target: number; readonly gutter: number }> {
    const column = direction === 'up' ? 0 : mode === 'unified' ? 1 : 3;
    return target.evaluate((element, index) => {
        const row = element.closest('.diff-rows')?.querySelector('.diff-row');
        if (row === null || row === undefined) {
            throw new Error('No code row next to the gap');
        }
        const tracks = getComputedStyle(row).gridTemplateColumns.split(' ').map(Number.parseFloat);
        const gutter = tracks[index];
        if (gutter === undefined) {
            throw new Error(`Code row has no column ${String(index)}`);
        }
        return { target: element.getBoundingClientRect().width, gutter };
    }, column);
}

async function findInnerGap(page: Page, minimumHidden: number): Promise<Locator> {
    const key = await page.locator('.diff-gap[data-edge="inner"]').evaluateAll((elements, minimum) => {
        const candidate = elements.find((element) => Number(element.getAttribute('data-hidden')) >= minimum);
        return candidate?.getAttribute('data-gap-key') ?? null;
    }, minimumHidden);
    if (key === null) {
        const hidden = await page.locator('.diff-gap[data-edge="inner"]').evaluateAll((elements) =>
            elements.map((element) => element.getAttribute('data-hidden')),
        );
        throw new Error(
            `No visible inner gap with remaining lines >= ${String(minimumHidden)}. Visible: ${hidden.join(', ')}`,
        );
    }
    return page.locator(`.diff-gap[data-gap-key="${key}"]`).first();
}

async function adjacentNewLine(gap: Locator, direction: 'previous' | 'next'): Promise<number> {
    return gap.evaluate((element, side) => {
        const parseNewLine = (key: string | null): number | null => {
            if (key === null) {
                return null;
            }
            if (key.startsWith('c')) {
                return Number(key.slice(1).split(':')[1]);
            }
            return key.startsWith('a') ? Number(key.slice(1)) : null;
        };
        let current = side === 'previous' ? element.previousElementSibling : element.nextElementSibling;
        while (current !== null) {
            const keys = [current.getAttribute('data-key'), ...[...current.querySelectorAll('[data-key]')].map((node) => node.getAttribute('data-key'))];
            const value = keys.map(parseNewLine).find((candidate) => candidate !== null) ?? null;
            if (value !== null) {
                return value;
            }
            current = side === 'previous' ? current.previousElementSibling : current.nextElementSibling;
        }
        throw new Error(`No line ${side === 'previous' ? 'above' : 'below'} the gap`);
    }, direction);
}

async function immediateContextNewLine(gap: Locator, direction: 'previous' | 'next'): Promise<number> {
    return gap.evaluate((element, side) => {
        const sibling = side === 'previous' ? element.previousElementSibling : element.nextElementSibling;
        const context = sibling?.matches('[data-key^="c"]') === true
            ? sibling
            : sibling?.querySelector('[data-key^="c"]');
        const key = context?.getAttribute('data-key') ?? null;
        if (key === null) {
            throw new Error('Expected a context line next to the gap');
        }
        const value = Number(key.slice(1).split(':')[1]);
        if (!Number.isFinite(value)) {
            throw new Error(`Context line has no new line number: ${key}`);
        }
        return value;
    }, direction);
}

async function gapGeometry(gap: Locator): Promise<GapGeometry> {
    return gap.evaluate((element) => {
        const up = element.querySelector<HTMLElement>('.diff-gap__slot--up');
        const down = element.querySelector<HTMLElement>('.diff-gap__slot--down');
        const counter = element.querySelector<HTMLElement>('.diff-gap__counter');
        if (up === null || down === null || counter === null) {
            throw new Error('Could not measure gap columns');
        }
        const gapRect = element.getBoundingClientRect();
        const upRect = up.getBoundingClientRect();
        const downRect = down.getBoundingClientRect();
        const counterRect = counter.getBoundingClientRect();
        return {
            upLeft: upRect.left,
            downLeft: downRect.left,
            counterLeft: counterRect.left,
            upWidth: upRect.width,
            upHeight: upRect.height,
            gapHeight: gapRect.height,
            counterTop: counterRect.top - gapRect.top,
            counterBottom: counterRect.bottom - gapRect.top,
        };
    });
}
