import type { Locator, Page } from '@playwright/test';

import { diffOf, expect, test } from './sherpa-fixture.js';

/**
 * Images in the diff: an image card replaces the "binary file not shown" notice,
 * bytes come through the real blob endpoint, and 2-up / Swipe / Onion Skin / Diff modes switch
 * on a live page. A web worker computes the difference, so the test checks the screen,
 * while unit tests cover the pure function.
 */

const BANNER = 'services/orders/src/ui/assets/edit-window-banner.png';
const ICON = 'services/orders/src/ui/assets/countdown-icon.svg';

/** Find a file card by path: the full diff has two dozen, and we need one specific card. */
function fileCard(page: Page, path: string): Locator {
    return page.locator('.file-card').filter({ has: page.locator(`.file-card__path[title="${path}"]`) });
}

/**
 * The full-diff list is virtualized: a card enters the DOM only when the list
 * scrolls to it. The `#file=` URL parameter drives it, just as a file link does.
 */
async function openFile(page: Page, fileId: string, path: string): Promise<Locator> {
    await page.evaluate((id) => {
        const params = new URLSearchParams(location.hash.slice(1));
        // Clear it first: navigating to the same file again would leave the URL unchanged and fire no event.
        params.delete('file');
        location.hash = params.toString();
        params.set('file', id);
        location.hash = params.toString();
    }, fileId);

    const card = fileCard(page, path);
    await expect(card).toHaveCount(1);
    await card.scrollIntoViewIfNeeded();
    return card;
}

function modeButton(card: Locator, label: string): Locator {
    return card.locator('.image-card__modes').getByRole('button', { name: label, exact: true });
}

test('images in the diff: modes, pixel diff, downloads and marks', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-medium');
    const blobs: { status: number; contentType: string | undefined }[] = [];
    page.on('response', (response) => {
        if (response.url().includes('/api/ui/review/blob')) {
            blobs.push({ status: response.status(), contentType: response.headers()['content-type'] });
        }
    });

    await page.goto(server.url);
    const files = await diffOf(page, server);
    const idOf = (path: string): string => {
        const file = files.find((candidate) => candidate.path === path);
        if (file === undefined) {
            throw new Error(`no file ${path} in the medium fixture`);
        }
        return file.fileId;
    };
    await page.getByRole('tab', { name: 'Full diff', exact: true }).click();

    let banner = await openFile(page, idOf(BANNER), BANNER);

    await test.step('a raster change appears as an image card instead of a notice', async () => {
        await expect(banner.locator('.image-card__modes')).toBeVisible();
        await expect(banner).not.toContainText('binary file not shown');

        const sides = banner.locator('img.image-card__image');
        await expect(sides).toHaveCount(2);
        // The bytes arrived and decoded: both sides have the actual 48 × 32 dimensions from the fixture.
        await expect
            .poll(() => sides.evaluateAll((images) => images.map((image) => (image as HTMLImageElement).naturalWidth)))
            .toEqual([48, 48]);

        expect(blobs.length).toBeGreaterThan(0);
        expect(blobs.every((blob) => blob.status === 200)).toBe(true);
        expect(blobs.some((blob) => blob.contentType === 'image/png')).toBe(true);
    });

    await test.step('Swipe: the keyboard moves the divider', async () => {
        await modeButton(banner, 'Swipe').click();

        const divider = banner.getByRole('slider', { name: 'Comparison divider' });
        await expect(divider).toHaveAttribute('aria-valuenow', '50');

        await divider.focus();
        await page.keyboard.press('ArrowRight');

        await expect(divider).toHaveAttribute('aria-valuenow', '52');
    });

    await test.step('Onion Skin: the slider controls the opacity of the top side', async () => {
        await modeButton(banner, 'Onion Skin').click();

        const slider = banner.locator('.image-card__slider input[type="range"]');
        await expect(slider).toHaveValue('50');
        await slider.fill('80');

        await expect(banner.locator('.image-card__clip')).toHaveCSS('opacity', '0.8');
    });

    await test.step('Diff: the difference is computed and the summary shows a nonzero percentage', async () => {
        await modeButton(banner, 'Diff').click();

        const canvas = banner.getByRole('img', { name: `${BANNER} — pixel diff` });
        await expect(canvas).toBeVisible();
        // The canvas has the combined bounds of both sides, so `putImageData` reached it.
        await expect(canvas).toHaveAttribute('width', '48');
        await expect(canvas).toHaveAttribute('height', '32');
        // The rectangle moved and changed color, so the percentage must be nonzero.
        await expect(banner.locator('.image-card__overlay .image-card__meta')).toContainText(
            /\d+(?:\.\d+)? % of pixels changed/u,
        );
        await expect(banner.locator('.image-card__overlay .image-card__meta')).not.toContainText(/(?<![\d.])0 % of pixels changed/u);
        // Both sides have the same size: no size mismatch notice should appear.
        await expect(banner).not.toContainText('sizes differ');
    });

    await test.step('back to 2-up: both sides are shown side by side again', async () => {
        await modeButton(banner, '2-up').click();

        await expect(banner.locator('img.image-card__image')).toHaveCount(2);
        await expect(banner.getByRole('img', { name: `${BANNER} — pixel diff` })).toHaveCount(0);
    });

    await test.step('svg with a patch: Text mode shows lines and overlays are disabled', async () => {
        const icon = await openFile(page, idOf(ICON), ICON);

        for (const label of ['Swipe', 'Onion Skin', 'Diff']) {
            await expect(modeButton(icon, label)).toBeDisabled();
            await expect(modeButton(icon, label)).toHaveAttribute('title', 'both sides are needed');
        }

        await modeButton(icon, 'Text').click();
        await expect(icon.locator('.diff-rows')).toContainText('<svg');
    });

    await test.step('Download saves the file under its own name', async () => {
        banner = await openFile(page, idOf(BANNER), BANNER);
        const download = page.waitForEvent('download');
        await banner.getByRole('link', { name: 'Download', exact: true }).first().click();

        expect((await download).suggestedFilename()).toBe('edit-window-banner.png');
    });

    // Comment before marking: Viewed collapses the card along with its menu.
    await test.step('"Comment on the file" opens a composer with a file label', async () => {
        await banner.getByRole('button', { name: 'File actions', exact: true }).click();
        await page.getByRole('menu').getByRole('menuitem', { name: 'Comment on the file', exact: true }).click();

        await expect(banner.locator('.thread-composer')).toBeVisible();
        await expect(banner).toContainText('file comment · edit-window-banner.png');
    });

    await test.step('Viewed on an image marks the file', async () => {
        const toggle = banner.getByRole('button', { name: 'Mark viewed', exact: true });
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');

        await toggle.click();

        await expect(banner.getByRole('button', { name: 'Viewed', exact: true })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await expect(banner.locator('.file-card__collapsed--file')).toContainText('viewed');
    });
});
