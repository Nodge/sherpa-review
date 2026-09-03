import type { Locator, Page } from '@playwright/test';
import {
    HUGE_CHANGED_LINE_COUNT,
    HUGE_FILE_COUNT,
    HUGE_PARSED_FILE_COUNT,
    HUGE_PARSED_LINE_COUNT,
} from '@sherpa/fixtures';

import { buildHugeRoute } from './route-worker.js';
import { expect, test } from './sherpa-fixture.js';

const AVERAGE_BUDGET_MS = 16.7;
const P95_BUDGET_MS = 33;
const SCROLL_STEP_PX = 300;

/**
 * The frame-time budget on `fixture-huge` does not fail the run yet: T12 only measures. T13 adds optimizations
 * (line virtualization, a worker pool, card unmounting). The spec reports
 * `within budget` / `over budget` and fails only on breakage: the diff did not parse or the route
 * did not build. Switching to `true` is T13's task.
 */
// The type is widened to boolean on purpose. Otherwise the literal narrows to `false` and the linter treats
// budget checks as dead code.
const HUGE_BUDGET_ENFORCED = false as boolean;

test('fixture-large meets the frame-time budget when scrolling the full diff', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');
    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Full diff', exact: true }).click();

    await expect(page.getByRole('button', { name: 'All 64', exact: true })).toBeVisible();
    await expect(page.locator('.full-diff')).toHaveAttribute('data-shown-files', '64');
    await expect(page.locator('.diff-list')).toBeVisible();

    const parsedFiles = await warmParsedFiles(page.locator('.full-diff'));
    expect(parsedFiles).toBe(64);

    const metrics = await scrollFrames(page.locator('.full-diff'));

    const description = `avg=${metrics.average.toFixed(2)} ms/frame, p95=${metrics.p95.toFixed(2)} ms/frame, frames=${String(metrics.frames)}`;
    test.info().annotations.push({ type: 'performance', description });
    console.log(`PERF fixture-large: ${description}`);

    expect(metrics.frames).toBeGreaterThan(20);
    expect(metrics.average).toBeLessThanOrEqual(AVERAGE_BUDGET_MS);
    expect(metrics.p95).toBeLessThanOrEqual(P95_BUDGET_MS);
});

test('fixture-huge: full diff first frame, worker parsing and scroll frame time', async ({
    page,
    launchSherpa,
}) => {
    // One hundred files and 25 000 lines: warmup alone takes minutes, so the shared 120 s timeout is too short.
    test.setTimeout(600_000);
    const server = await launchSherpa('fixture-huge');
    const scroller = page.locator('.full-diff');

    // Select the view in the URL: clicking the tab would add click latency to the time to first frame.
    await page.goto(`${server.url}&view=diff`);
    await expect(scroller).toHaveAttribute('data-shown-files', String(HUGE_FILE_COUNT));
    await expect(page.locator('.diff-list')).toBeVisible();

    // (a) From navigationStart to the first card that has rendered lines.
    const firstFrameMs = await firstDiffFrame(page);
    const heapBefore = await usedHeapMb(page);

    // (c) Cold scroll: the worker parses cards as they come into view, without warmup.
    const cold = await scrollFrames(scroller);

    // Warmup counts mounted cards: all 100, including those collapsed for a reason.
    const parsedFiles = await warmParsedFiles(scroller);
    expect(parsedFiles).toBe(HUGE_FILE_COUNT);

    // (b) Parsing: worker request → response round-trip measurements recorded by `diff/client.ts`.
    const parse = await parseMeasures(page);
    // (d) Warm scroll: the same method as on `fixture-large`.
    const warm = await scrollFrames(scroller);

    const domNodes = await page.evaluate(() => document.querySelectorAll('*').length);
    const heapAfter = await usedHeapMb(page);

    // A file above the collapse threshold starts collapsed (SPEC §2.13). The fixture has exactly one.
    await scroller.evaluate((element) => {
        element.scrollTop = 0;
    });
    await expect(page.locator('.file-card__collapsed')).toHaveCount(1);
    await expect(page.locator('.file-card__collapsed')).toContainText('open the file');

    const lines = [
        `measured load=${String(HUGE_PARSED_FILE_COUNT)}/${String(HUGE_FILE_COUNT)} files, ` +
            `${String(HUGE_PARSED_LINE_COUNT)}/${String(HUGE_CHANGED_LINE_COUNT)} changed lines ` +
            `(collapsed viewed/generated files do not request parsing)`,
        `first-diff-frame=${firstFrameMs.toFixed(0)} ms`,
        `parse total=${parse.total.toFixed(0)} ms, avg=${parse.average.toFixed(2)}, p95=${parse.p95.toFixed(2)}, max=${parse.max.toFixed(2)}, n=${String(parse.count)}`,
        frameLine('cold scroll', cold),
        frameLine('warm scroll', warm),
        `dom nodes=${String(domNodes)}`,
        `heap=${heapBefore ?? 'n/a'} → ${heapAfter ?? 'n/a'} MB`,
        budgetVerdict(warm),
    ];
    report('fixture-huge diff', lines);

    expect(cold.frames).toBeGreaterThan(20);
    expect(warm.frames).toBeGreaterThan(20);
    expect(parse.count).toBe(HUGE_PARSED_FILE_COUNT);
    if (HUGE_BUDGET_ENFORCED) {
        expect(warm.average).toBeLessThanOrEqual(AVERAGE_BUDGET_MS);
        expect(warm.p95).toBeLessThanOrEqual(P95_BUDGET_MS);
    }
});

test('fixture-huge: building a 25-stop route and scroll frame time', async ({ page, launchSherpa }) => {
    test.setTimeout(600_000);
    const server = await launchSherpa('fixture-huge');
    const scroller = page.locator('main.route');

    await page.goto(server.url);
    expect((await server.worker.register('claude-code')).code).toBe(0);
    await page.getByRole('tab', { name: 'Route', exact: true }).click();

    const startedAt = Date.now();
    await buildHugeRoute(server.worker);
    // 25 planned stops plus the synthetic Other stop.
    await expect(page.locator('[data-stop]')).toHaveCount(26, { timeout: 60_000 });
    const buildMs = Date.now() - startedAt;

    // (e) Cold route scroll: cards mount as they appear on screen.
    const cold = await scrollFrames(scroller);
    const domNodes = await page.evaluate(() => document.querySelectorAll('*').length);
    const warm = await scrollFrames(scroller);
    const heap = await usedHeapMb(page);

    report('fixture-huge route', [
        `build=${(buildMs / 1000).toFixed(1)} s (25 sections through the CLI bundle)`,
        frameLine('cold scroll', cold),
        frameLine('warm scroll', warm),
        `dom nodes after full pass=${String(domNodes)}`,
        `heap=${heap ?? 'n/a'} MB`,
        budgetVerdict(warm),
    ]);

    expect(cold.frames).toBeGreaterThan(5);
    expect(warm.frames).toBeGreaterThan(5);
    if (HUGE_BUDGET_ENFORCED) {
        expect(warm.average).toBeLessThanOrEqual(AVERAGE_BUDGET_MS);
        expect(warm.p95).toBeLessThanOrEqual(P95_BUDGET_MS);
    }
});

interface FrameMetrics {
    readonly average: number;
    readonly p95: number;
    readonly max: number;
    readonly frames: number;
    /** Interval between adjacent rAF calls: includes browser work after our frame. */
    readonly intervalAverage: number;
    readonly intervalP95: number;
    readonly intervalMax: number;
    readonly elapsedMs: number;
}

/**
 * Frame work cost during scrolling: `performance.now()` around the `scrollTop` assignment and
 * forced layout. This measures frame work, rather than the interval between vsync calls. On a
 * headless machine, the interval measures browser scheduling rather than our code.
 *
 * A second series collects intervals between adjacent rAF calls. On a cold list the first series
 * is almost zero: card parsing and mounting happen after our frame and fall outside the measurement
 * window, but they do count toward the interval.
 */
function scrollFrames(scroller: Locator): Promise<FrameMetrics> {
    return scroller.evaluate(async (element, step): Promise<FrameMetrics> => {
        const samples: number[] = [];
        const intervals: number[] = [];
        element.scrollTop = 0;
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
                resolve();
            });
        });

        const startedPass = performance.now();
        await new Promise<void>((resolve) => {
            const maxScroll = element.scrollHeight - element.clientHeight;
            let previousFrameAt: number | null = null;
            const frame = (): void => {
                const startedAt = performance.now();
                if (previousFrameAt !== null) {
                    intervals.push(startedAt - previousFrameAt);
                }
                previousFrameAt = startedAt;

                element.scrollTop = Math.min(element.scrollTop + step, maxScroll);
                element.getBoundingClientRect();
                samples.push(performance.now() - startedAt);

                // Capture the bound once: on a cold list, height grows as cards are measured,
                // so a loop using the live height would never finish.
                if (element.scrollTop >= maxScroll) {
                    resolve();
                    return;
                }
                requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
        });

        const stats = (values: readonly number[]): { average: number; p95: number; max: number } => {
            const sorted = [...values].sort((left, right) => left - right);
            const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
            return {
                average: values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length,
                p95: sorted[p95Index] ?? Number.POSITIVE_INFINITY,
                max: sorted.at(-1) ?? Number.POSITIVE_INFINITY,
            };
        };
        const work = stats(samples);
        const interval = stats(intervals);
        return {
            average: work.average,
            p95: work.p95,
            max: work.max,
            frames: samples.length,
            intervalAverage: interval.average,
            intervalP95: interval.p95,
            intervalMax: interval.max,
            elapsedMs: performance.now() - startedPass,
        };
    }, SCROLL_STEP_PX);
}

function frameLine(label: string, metrics: FrameMetrics): string {
    return (
        `${label} avg=${metrics.average.toFixed(2)}, p95=${metrics.p95.toFixed(2)}, max=${metrics.max.toFixed(2)}, ` +
        `frames=${String(metrics.frames)}; rAF interval avg=${metrics.intervalAverage.toFixed(2)}, ` +
        `p95=${metrics.intervalP95.toFixed(2)}, max=${metrics.intervalMax.toFixed(2)}; pass=${(metrics.elapsedMs / 1000).toFixed(1)} s`
    );
}

interface ParseMetrics {
    readonly total: number;
    readonly average: number;
    readonly p95: number;
    readonly max: number;
    readonly count: number;
}

/** `sherpa:diff-parse` measurements: one per file sent to the worker (cache hits are not measured). */
function parseMeasures(page: Page): Promise<ParseMetrics> {
    return page.evaluate((): ParseMetrics => {
        const durations = performance
            .getEntriesByName('sherpa:diff-parse', 'measure')
            .map((entry) => entry.duration)
            .sort((left, right) => left - right);
        const p95Index = Math.max(0, Math.ceil(durations.length * 0.95) - 1);
        const total = durations.reduce((sum, duration) => sum + duration, 0);
        return {
            total,
            average: durations.length === 0 ? 0 : total / durations.length,
            p95: durations[p95Index] ?? 0,
            max: durations.at(-1) ?? 0,
            count: durations.length,
        };
    });
}

/** Time when the first card renders its rows, measured from `navigationStart`. */
async function firstDiffFrame(page: Page): Promise<number> {
    await expect
        .poll(() => page.evaluate(() => performance.getEntriesByName('sherpa:first-diff-frame').length), {
            timeout: 60_000,
        })
        .toBeGreaterThan(0);
    return page.evaluate(() => performance.getEntriesByName('sherpa:first-diff-frame')[0]?.startTime ?? 0);
}

/** Some Chromium builds lack `performance.memory`. Without it, the metric is `n/a`. */
function usedHeapMb(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
        return memory === undefined ? null : (memory.usedJSHeapSize / (1024 * 1024)).toFixed(1);
    });
}

function budgetVerdict(metrics: FrameMetrics): string {
    const within = metrics.average <= AVERAGE_BUDGET_MS && metrics.p95 <= P95_BUDGET_MS;
    return `${within ? 'within budget' : 'over budget'} (avg ≤ ${String(AVERAGE_BUDGET_MS)} ms, p95 ≤ ${String(P95_BUDGET_MS)} ms)`;
}

function report(label: string, lines: readonly string[]): void {
    for (const line of lines) {
        test.info().annotations.push({ type: 'performance', description: `${label}: ${line}` });
        console.log(`PERF ${label}: ${line}`);
    }
}

async function warmParsedFiles(scroller: Locator): Promise<number> {
    return scroller.evaluate(async (element) => {
        const seen = new Set<string>();
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        const waitForVisibleModels = async (): Promise<void> => {
            for (let attempt = 0; attempt < 240; attempt += 1) {
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
            throw new Error('Visible cards did not finish parsing within 240 frames');
        };

        const stride = Math.max(200, Math.floor(element.clientHeight / 2));
        let top = 0;
        while (top < element.scrollHeight - element.clientHeight) {
            element.scrollTop = top;
            await nextFrame();
            await waitForVisibleModels();
            top += stride;
        }
        element.scrollTop = element.scrollHeight;
        await nextFrame();
        await waitForVisibleModels();
        element.scrollTop = 0;
        await nextFrame();
        return seen.size;
    });
}
