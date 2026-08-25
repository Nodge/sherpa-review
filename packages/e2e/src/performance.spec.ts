import type { Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

const AVERAGE_BUDGET_MS = 16.7;
const P95_BUDGET_MS = 33;
const SCROLL_STEP_PX = 300;

test('fixture-large meets the frame-time budget when scrolling the full diff', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');
    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Full diff', exact: true }).click();

    await expect(page.getByRole('button', { name: 'All 64', exact: true })).toBeVisible();
    await expect(page.locator('.full-diff__count')).toHaveText('64 files');
    await expect(page.locator('.diff-list')).toBeVisible();

    const parsedFiles = await warmParsedFiles(page);
    expect(parsedFiles).toBe(64);

    const metrics = await page.locator('.diff-list').evaluate(async (scroller, step) => {
        const samples: number[] = [];
        scroller.scrollTop = 0;
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
                resolve();
            });
        });

        await new Promise<void>((resolve) => {
            const maxScroll = scroller.scrollHeight - scroller.clientHeight;
            const frame = (): void => {
                const startedAt = performance.now();
                scroller.scrollTop = Math.min(scroller.scrollTop + step, maxScroll);
                scroller.getBoundingClientRect();
                samples.push(performance.now() - startedAt);

                if (scroller.scrollTop >= maxScroll) {
                    resolve();
                    return;
                }
                requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
        });

        const sorted = [...samples].sort((left, right) => left - right);
        const average = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
        const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
        return {
            average,
            p95: sorted[p95Index] ?? Number.POSITIVE_INFINITY,
            frames: samples.length,
        };
    }, SCROLL_STEP_PX);

    const description = `avg=${metrics.average.toFixed(2)} ms/frame, p95=${metrics.p95.toFixed(2)} ms/frame, frames=${String(metrics.frames)}`;
    test.info().annotations.push({ type: 'performance', description });
    console.log(`PERF fixture-large: ${description}`);

    expect(metrics.frames).toBeGreaterThan(20);
    expect(metrics.average).toBeLessThanOrEqual(AVERAGE_BUDGET_MS);
    expect(metrics.p95).toBeLessThanOrEqual(P95_BUDGET_MS);
});

async function warmParsedFiles(page: Page): Promise<number> {
    return page.locator('.diff-list').evaluate(async (scroller) => {
        const seen = new Set<string>();
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        const waitForVisibleModels = async (): Promise<void> => {
            for (let attempt = 0; attempt < 120; attempt += 1) {
                document.querySelectorAll<HTMLElement>('.file-card[data-file]').forEach((card) => {
                    const parseError = Array.from(card.querySelectorAll<HTMLElement>('.file-card__notice')).find(
                        (notice) => notice.textContent.trimStart().startsWith('diff failed to parse'),
                    );
                    if (parseError !== undefined) {
                        const fileId = card.dataset.file ?? 'unknown fileId';
                        const path = card.querySelector<HTMLElement>('.file-card__path')?.title;
                        throw new Error(
                            `Card ${path ?? fileId} (${fileId}) failed with a parser error: ${parseError.textContent.trim()}`,
                        );
                    }

                    const fileId = card.dataset.file;
                    if (fileId !== undefined) {
                        seen.add(fileId);
                    }
                });
                if (document.querySelector('.file-card__loading') === null) {
                    return;
                }
                await nextFrame();
            }
            throw new Error('Visible cards did not parse within 120 frames');
        };

        const stride = Math.max(200, Math.floor(scroller.clientHeight / 2));
        let top = 0;
        while (top < scroller.scrollHeight - scroller.clientHeight) {
            scroller.scrollTop = top;
            await nextFrame();
            await waitForVisibleModels();
            top += stride;
        }
        scroller.scrollTop = scroller.scrollHeight;
        await nextFrame();
        await waitForVisibleModels();
        scroller.scrollTop = 0;
        await nextFrame();
        return seen.size;
    });
}
