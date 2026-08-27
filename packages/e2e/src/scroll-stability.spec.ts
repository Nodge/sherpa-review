import type { Page } from '@playwright/test';

import { expect, test } from './sherpa-fixture.js';

/**
 * Cold scrolling through a large PR. The worker parses cards as the reviewer reaches them, and
 * the arriving model changes the height of a card already rendered. The jump metric is the anchor's displacement
 * (the top visible card) relative to the viewport over several frames WITHOUT input. While
 * the reviewer leaves the wheel alone, the view must stay still. The second metric is overlap between
 * adjacent cards. A virtualizer slot whose height differs from the actual card breaks the layout
 * even when the anchor stays in place.
 *
 * Warm-up (as in `performance.spec.ts`) is forbidden here. It creates the very state in which
 * the bug does not reproduce. Each direction starts from a fresh load, otherwise scrolling down
 * would warm up the list for scrolling up.
 */

/** Anchor displacement that does not yet count as a jump, due to subpixel rect arithmetic. */
const JUMP_TOLERANCE_PX = 1;
/** Observation frames after a scroll step, enough for the worker to return models. */
const SETTLE_FRAMES = 8;
/** Scroll step is roughly one fixture card, so each step brings in a fresh, cold card. */
const STEP_PX = 900;

interface WalkReport {
    readonly steps: number;
    readonly lost: number;
    readonly jumps: number;
    readonly worst: number;
    readonly total: number;
    readonly sample: readonly { readonly index: number; readonly drift: number }[];
    readonly overlaps: number;
    readonly worstOverlap: number;
}

test('fixture-large does not jump during cold scrolling through the full diff', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');

    await openFullDiff(page, server.url);
    const down = await walk(page, 'down');

    // Fresh load: the upward pass must encounter unparsed cards arriving from above.
    await openFullDiff(page, server.url);
    const up = await walk(page, 'up');

    for (const [direction, report] of [
        ['down', down],
        ['up', up],
    ] as const) {
        const description = `${direction}: steps=${String(report.steps)}, jumps=${String(report.jumps)}, worst=${report.worst.toFixed(1)}px, total=${report.total.toFixed(1)}px, lost=${String(report.lost)}, overlaps=${String(report.overlaps)}/${report.worstOverlap.toFixed(1)}px`;
        test.info().annotations.push({ type: 'scroll-stability', description });
        console.log(`SCROLL fixture-large ${description}`);
        if (report.sample.length > 0) {
            console.log(`SCROLL sample ${direction}: ${JSON.stringify(report.sample)}`);
        }
    }

    expect(down.steps).toBeGreaterThan(20);
    expect(up.steps).toBeGreaterThan(20);
    expect(down.lost).toBe(0);
    expect(up.lost).toBe(0);
    expect(down.jumps).toBe(0);
    expect(up.jumps).toBe(0);
    // The virtualizer slot matches the actual card height. A mismatch makes adjacent cards overlap,
    // the same estimation error as a jump, visible as a broken layout.
    expect(down.overlaps).toBe(0);
    expect(up.overlaps).toBe(0);
});

/**
 * Remeasuring cards already shown. Switching modes changes the heights of all cards on screen and
 * overscan. Cards above the fold must be compensated regardless of where the reviewer
 * scroll direction, otherwise the visible text moves the moment the toggle is pressed.
 */
for (const gesture of ['up', 'down'] as const) {
    test(`switching modes after scrolling ${gesture} does not move the visible text`, async ({ page, launchSherpa }) => {
        const server = await launchSherpa('fixture-large');
        await openFullDiff(page, server.url);

        const report = await page.locator('.full-diff').evaluate(
            async (scroller, options) => {
                const nextFrame = (): Promise<void> =>
                    new Promise<void>((resolve) => {
                        requestAnimationFrame(() => {
                            resolve();
                        });
                    });
                const listTop = (): number => {
                    const toolbarBottom = document
                        .querySelector<HTMLElement>('.full-diff__toolbar')
                        ?.getBoundingClientRect().bottom;
                    return Math.max(scroller.getBoundingClientRect().top, toolbarBottom ?? 0);
                };
                const anchor = (): { index: number; offset: number } | null => {
                    const top = listTop();
                    for (const item of document.querySelectorAll<HTMLElement>('.diff-list__item')) {
                        const rect = item.getBoundingClientRect();
                        if (rect.bottom > top + 1) {
                            return { index: Number(item.dataset.index), offset: rect.top - top };
                        }
                    }
                    return null;
                };
                const offsetOf = (index: number): number | null => {
                    const item = document.querySelector<HTMLElement>(
                        `.diff-list__item[data-index="${String(index)}"]`,
                    );
                    return item === null ? null : item.getBoundingClientRect().top - listTop();
                };

                // Middle of the list with parsed cards. Remeasurement must use
                // measured heights, not the first encounter with a file.
                scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) / 2);
                for (let frame = 0; frame < 90 && document.querySelector('.file-card__loading') !== null; frame += 1) {
                    await nextFrame();
                }
                for (let frame = 0; frame < 20; frame += 1) {
                    await nextFrame();
                }

                // The last gesture sets `scrollDirection`, which the library's default depended on.
                // The toggle is pressed right after it, before the direction resets.
                scroller.scrollTop += options.gesture === 'down' ? 150 : -150;
                await nextFrame();
                const start = anchor();
                const before = document.querySelector('.diff-mode-toggle')?.textContent.trim() ?? '';
                document.querySelector<HTMLElement>('.diff-mode-toggle')?.click();

                let drift = 0;
                let lost = 0;
                for (let frame = 0; frame < options.settleFrames; frame += 1) {
                    await nextFrame();
                    const now = start === null ? null : offsetOf(start.index);
                    if (now === null || start === null) {
                        lost += 1;
                        break;
                    }
                    drift = Math.max(drift, Math.abs(now - start.offset));
                }

                return {
                    drift: Number(drift.toFixed(1)),
                    lost,
                    before,
                    after: document.querySelector('.diff-mode-toggle')?.textContent.trim() ?? '',
                };
            },
            { gesture, settleFrames: 20 },
        );

        const description = `gesture ${gesture}: drift=${report.drift.toFixed(1)}px, lost=${String(report.lost)}, "${report.before}" → "${report.after}"`;
        test.info().annotations.push({ type: 'scroll-stability', description });
        console.log(`MODE fixture-large ${description}`);

        // The mode really switched, otherwise the measurement would be of a stationary list.
        expect(report.after).toBe('⇄ side by side');
        expect(report.lost).toBe(0);
        expect(report.drift).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
    });
}

async function openFullDiff(page: Page, url: string): Promise<void> {
    // Navigate through `about:blank`. Navigating to the same address would change only the fragment, and the tab
    // would keep running with all the cards it had already parsed and measured.
    await page.goto('about:blank');
    await page.goto(url);
    await page.getByRole('tab', { name: 'Full diff', exact: true }).click();
    await expect(page.locator('.diff-list')).toBeVisible();
    await expect(page.locator('.full-diff')).toHaveAttribute('data-shown-files', '64');
    await expect(page.locator('.diff-list')).toHaveAttribute('data-collapsed-files', '15');
    await expect(page.locator('.diff-list')).toHaveAttribute('data-generated-collapsed-files', '8');
    // Wait for IBM Plex. Loading it changes every card's height at once, which would skew this measurement.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

function walk(page: Page, direction: 'down' | 'up'): Promise<WalkReport> {
    return page.locator('.full-diff').evaluate(
        async (scroller, options): Promise<WalkReport> => {
            const nextFrame = (): Promise<void> =>
                new Promise<void>((resolve) => {
                    requestAnimationFrame(() => {
                        resolve();
                    });
                });
            const listTop = (): number => {
                const toolbarBottom = document
                    .querySelector<HTMLElement>('.full-diff__toolbar')
                    ?.getBoundingClientRect().bottom;
                return Math.max(scroller.getBoundingClientRect().top, toolbarBottom ?? 0);
            };

            /** The top visible card and its offset from the bottom edge of the sticky toolbar. */
            const anchor = (): { index: number; offset: number } | null => {
                const top = listTop();
                for (const item of document.querySelectorAll<HTMLElement>('.diff-list__item')) {
                    const rect = item.getBoundingClientRect();
                    if (rect.bottom > top + 1) {
                        return { index: Number(item.dataset.index), offset: rect.top - top };
                    }
                }
                return null;
            };
            const offsetOf = (index: number): number | null => {
                const item = document.querySelector<HTMLElement>(`.diff-list__item[data-index="${String(index)}"]`);
                return item === null ? null : item.getBoundingClientRect().top - listTop();
            };

            /**
             * The largest overlap between adjacent cards. A card fills its whole slot
             * (the gap to the next card is its own padding), so once the list settles, one card's bottom
             * exactly meets the next card's top. Anything below that is height the slot did not account for.
             */
            const overlap = (): number => {
                const rendered = [...document.querySelectorAll<HTMLElement>('.diff-list__item')].sort(
                    (a, b) => Number(a.dataset.index) - Number(b.dataset.index),
                );
                let worst = 0;
                for (let i = 1; i < rendered.length; i += 1) {
                    const previous = rendered[i - 1];
                    const current = rendered[i];
                    if (previous === undefined || current === undefined) {
                        continue;
                    }
                    if (Number(current.dataset.index) !== Number(previous.dataset.index) + 1) {
                        continue;
                    }
                    worst = Math.max(
                        worst,
                        previous.getBoundingClientRect().bottom - current.getBoundingClientRect().top,
                    );
                }
                return worst;
            };

            const jumps: { index: number; drift: number }[] = [];
            let steps = 0;
            let lost = 0;
            let overlaps = 0;
            let worstOverlap = 0;

            scroller.scrollTop = options.direction === 'down' ? 0 : scroller.scrollHeight;
            await nextFrame();

            for (let guard = 0; guard < 400; guard += 1) {
                const maxScroll = scroller.scrollHeight - scroller.clientHeight;
                const from = scroller.scrollTop;
                const to =
                    options.direction === 'down'
                        ? Math.min(from + options.step, maxScroll)
                        : Math.max(from - options.step, 0);
                scroller.scrollTop = to;
                await nextFrame();
                steps += 1;

                const start = anchor();
                if (start !== null) {
                    let drift = 0;
                    for (let frame = 0; frame < options.settleFrames; frame += 1) {
                        await nextFrame();
                        const now = offsetOf(start.index);
                        if (now === null) {
                            lost += 1;
                            break;
                        }
                        drift = Math.max(drift, Math.abs(now - start.offset));
                    }
                    if (drift > options.tolerance) {
                        jumps.push({ index: start.index, drift: Number(drift.toFixed(1)) });
                    }
                }

                // Measure after the wait window. Virtualization allows overlap in the frame between a model's arrival
                // and the slot's remeasurement, but it must not persist beyond that.
                const excess = overlap();
                if (excess > options.tolerance) {
                    overlaps += 1;
                    worstOverlap = Math.max(worstOverlap, excess);
                }

                if (options.direction === 'down' ? to >= maxScroll : to <= 0) {
                    break;
                }
            }

            const drifts = jumps.map((jump) => jump.drift);
            return {
                steps,
                lost,
                jumps: jumps.length,
                worst: drifts.length === 0 ? 0 : Math.max(...drifts),
                total: drifts.reduce((sum, value) => sum + value, 0),
                sample: jumps.slice(0, 10),
                overlaps,
                worstOverlap: Number(worstOverlap.toFixed(1)),
            };
        },
        { direction, step: STEP_PX, settleFrames: SETTLE_FRAMES, tolerance: JUMP_TOLERANCE_PX },
    );
}
