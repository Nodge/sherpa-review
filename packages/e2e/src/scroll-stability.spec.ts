import type { Page } from '@playwright/test';

import { mediumRawResults, sectionFor, submit, takeTask } from './route-worker.js';
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
/** docs/design/README.md "Interactions": a route jump target lands at −150px from the container edge. */
const ROUTE_JUMP_OFFSET_PX = 150;

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
 * in the overscan area. Cards above the fold must be compensated for regardless of the reviewer's last
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
        expect(report.after).toBe('side by side');
        expect(report.lost).toBe(0);
        expect(report.drift).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
    });
}

test('the line composer in the middle of a large diff opens and closes without a jump', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-large');
    await openFullDiff(page, server.url);

    const anchor = await page.locator('.full-diff').evaluate(async (scroller) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) / 2);
        for (let frame = 0; frame < 90 && document.querySelector('.file-card__loading') !== null; frame += 1) {
            await nextFrame();
        }
        for (let frame = 0; frame < 12; frame += 1) {
            await nextFrame();
        }
        const toolbarBottom = document.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom ?? 0;
        const row = [...document.querySelectorAll<HTMLElement>('.diff-row[tabindex="0"]')].find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.top >= toolbarBottom + 1 && rect.bottom <= window.innerHeight - 1;
        });
        const item = row?.closest<HTMLElement>('.diff-list__item') ?? null;
        if (row === undefined || item === null) {
            throw new Error('No visible focusable line found in the middle of fixture-large');
        }
        row.focus();
        return {
            index: Number(item.dataset.index),
            offset: item.getBoundingClientRect().top - toolbarBottom,
        };
    });

    await page.keyboard.press('c');
    await expect(page.locator('.diff-line-composer')).toBeVisible();
    const openedDrift = await observeItemDrift(page, anchor);

    await page.locator('.diff-line-composer').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.diff-line-composer')).toHaveCount(0);
    const closedDrift = await observeItemDrift(page, anchor);

    test.info().annotations.push({
        type: 'scroll-stability',
        description: `line composer: open=${openedDrift.toFixed(1)}px, close=${closedDrift.toFixed(1)}px`,
    });
    expect(openedDrift).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
    expect(closedDrift).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
});

test('a line thread expands and collapses without a jump', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');
    await openFullDiff(page, server.url);

    // Expanding changes a row's height in the middle of a long diff. The row itself must stay in place.
    const anchor = await page.locator('.full-diff').evaluate(async (scroller) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        const settle = async (): Promise<void> => {
            for (let frame = 0; frame < 90 && document.querySelector('.file-card__loading') !== null; frame += 1) {
                await nextFrame();
            }
            for (let frame = 0; frame < 12; frame += 1) {
                await nextFrame();
            }
        };
        const toolbarBottom = (): number =>
            document.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom ?? 0;
        /** Clearance from the sticky card header. Under it, the marker is visible but not a fair click target. */
        const HEADER_RESERVE = 80;
        const visibleMarker = (): HTMLElement | null =>
            [...document.querySelectorAll<HTMLElement>('.thread-marker')].find((candidate) => {
                const rect = candidate.getBoundingClientRect();
                return rect.top >= toolbarBottom() + HEADER_RESERVE && rect.bottom <= window.innerHeight - 1;
            }) ?? null;

        // Threads in fixture-large belong to specific files. Scroll down screen by screen until a marker appears.
        let marker = visibleMarker();
        for (let screen = 0; screen < 40 && marker === null; screen += 1) {
            const bottom = scroller.scrollHeight - scroller.clientHeight;
            if (scroller.scrollTop >= bottom) {
                break;
            }
            scroller.scrollTop = Math.min(scroller.scrollTop + Math.round(scroller.clientHeight * 0.8), bottom);
            await settle();
            marker = visibleMarker();
        }
        const row = marker?.closest<HTMLElement>('.diff-row') ?? null;
        const item = marker?.closest<HTMLElement>('.diff-list__item') ?? null;
        if (row === null || item === null) {
            throw new Error('No visible line with a thread marker found in the full diff of fixture-large');
        }
        return {
            index: Number(item.dataset.index),
            key: row.dataset.key ?? '',
            offset: row.getBoundingClientRect().top - toolbarBottom(),
        };
    });

    const marker = page.locator(`${rowSelector(anchor)} .thread-marker`);
    const openBefore = (await marker.getAttribute('aria-expanded')) === 'true';

    await marker.click();
    await expect(marker).toHaveAttribute('aria-expanded', String(!openBefore));
    const toggled = await observeRowDrift(page, anchor);

    await marker.click();
    await expect(marker).toHaveAttribute('aria-expanded', String(openBefore));
    const restored = await observeRowDrift(page, anchor);

    test.info().annotations.push({
        type: 'scroll-stability',
        description: `thread marker: toggle=${toggled.drift.toFixed(1)}px/${toggled.overlap.toFixed(1)}px, back=${restored.drift.toFixed(1)}px/${restored.overlap.toFixed(1)}px`,
    });
    // The row stays in place, and the virtualizer slot keeps up with the card's new height.
    expect(toggled.drift).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
    expect(restored.drift).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
    expect(toggled.overlap).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
    expect(restored.overlap).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
});

interface RowAnchor {
    readonly index: number;
    readonly key: string;
    readonly offset: number;
}

/** A row is identified by "virtualizer slot + row key". Row keys are unique only within a card. */
function rowSelector(anchor: RowAnchor): string {
    return `.diff-list__item[data-index="${String(anchor.index)}"] .diff-row[data-key="${anchor.key}"]`;
}

/** Anchor row displacement and adjacent card overlap over 20 frames after toggling a thread. */
async function observeRowDrift(page: Page, anchor: RowAnchor): Promise<{ drift: number; overlap: number }> {
    return page.locator('.full-diff').evaluate(
        async (_scroller, target: RowAnchor): Promise<{ drift: number; overlap: number }> => {
            const nextFrame = (): Promise<void> =>
                new Promise<void>((resolve) => {
                    requestAnimationFrame(() => {
                        resolve();
                    });
                });
            const selector = `.diff-list__item[data-index="${String(target.index)}"] .diff-row[data-key="${target.key}"]`;
            const overlap = (): number => {
                const rendered = [...document.querySelectorAll<HTMLElement>('.diff-list__item')].sort(
                    (a, b) => Number(a.dataset.index) - Number(b.dataset.index),
                );
                let worst = 0;
                for (let i = 1; i < rendered.length; i += 1) {
                    const previous = rendered[i - 1];
                    const current = rendered[i];
                    if (
                        previous === undefined ||
                        current === undefined ||
                        Number(current.dataset.index) !== Number(previous.dataset.index) + 1
                    ) {
                        continue;
                    }
                    worst = Math.max(
                        worst,
                        previous.getBoundingClientRect().bottom - current.getBoundingClientRect().top,
                    );
                }
                return worst;
            };
            let drift = 0;
            let worstOverlap = 0;
            for (let frame = 0; frame < 20; frame += 1) {
                await nextFrame();
                const toolbarBottom =
                    document.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom ?? 0;
                const row = document.querySelector<HTMLElement>(selector);
                if (row === null) {
                    throw new Error('The anchor row left the DOM while remeasuring the thread');
                }
                drift = Math.max(drift, Math.abs(row.getBoundingClientRect().top - toolbarBottom - target.offset));
                worstOverlap = Math.max(worstOverlap, overlap());
            }
            return { drift: Number(drift.toFixed(1)), overlap: Number(worstOverlap.toFixed(1)) };
        },
        anchor,
    );
}

async function observeItemDrift(
    page: Page,
    anchor: { readonly index: number; readonly offset: number },
): Promise<number> {
    return page.locator('.full-diff').evaluate(
        async (_scroller, target) => {
            const nextFrame = (): Promise<void> =>
                new Promise<void>((resolve) => {
                    requestAnimationFrame(() => {
                    resolve();
                });
                });
            let worst = 0;
            for (let frame = 0; frame < 20; frame += 1) {
                await nextFrame();
                const toolbarBottom =
                    document.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom ?? 0;
                const item = document.querySelector<HTMLElement>(
                    `.diff-list__item[data-index="${String(target.index)}"]`,
                );
                if (item === null) {
                    throw new Error('The anchor card left the DOM while remeasuring the composer');
                }
                worst = Math.max(worst, Math.abs(item.getBoundingClientRect().top - toolbarBottom - target.offset));
            }
            return Number(worst.toFixed(1));
        },
        anchor,
    );
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

/**
 * "Scrolling follows collapse": marking the file
 * the reviewer is reading moves the view to the next file. Marking the last file and clearing a mark
 * do not move the view.
 */
test('marking the top file moves the view to the next one', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');
    await openFullDiff(page, server.url);

    const start = await page.locator('.full-diff').evaluate(async (scroller) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        const toolbarBottom = (): number =>
            document.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom ?? 0;

        scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) / 2);
        for (let frame = 0; frame < 90 && document.querySelector('.file-card__loading') !== null; frame += 1) {
            await nextFrame();
        }
        for (let frame = 0; frame < 20; frame += 1) {
            await nextFrame();
        }

        // A tall expanded card. The reviewer has read halfway through and presses the toggle in the sticky header.
        const item = [...document.querySelectorAll<HTMLElement>('.diff-list__item')]
            .sort((left, right) => Number(left.dataset.index) - Number(right.dataset.index))
            .find(
                (candidate) =>
                    candidate.querySelector('.file-card__collapsed--file') === null &&
                    candidate.getBoundingClientRect().height > 500,
            );
        if (item === undefined) {
            throw new Error('a tall expanded card is required in the middle of fixture-large');
        }
        const index = Number(item.dataset.index);
        scroller.scrollTop += item.getBoundingClientRect().top - toolbarBottom() + 200;
        for (let frame = 0; frame < 12; frame += 1) {
            await nextFrame();
        }
        return { index, scrollTop: scroller.scrollTop };
    });

    await page
        .locator(`.diff-list__item[data-index="${String(start.index)}"] .file-card__viewed`)
        .click();

    const after = await page.locator('.full-diff').evaluate(async (scroller, marked) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        for (let frame = 0; frame < 40; frame += 1) {
            await nextFrame();
        }
        const toolbarBottom =
            document.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom ?? 0;
        const items = [...document.querySelectorAll<HTMLElement>('.diff-list__item')].sort(
            (left, right) => Number(left.dataset.index) - Number(right.dataset.index),
        );
        const top = items.find((candidate) => candidate.getBoundingClientRect().bottom > toolbarBottom + 1);
        if (top === undefined) {
            throw new Error('no cards remain on screen after marking viewed');
        }
        const markedItem = items.find((candidate) => Number(candidate.dataset.index) === marked);
        return {
            topIndex: Number(top.dataset.index),
            offset: Number((top.getBoundingClientRect().top - toolbarBottom).toFixed(1)),
            scrollTop: scroller.scrollTop,
            markedCollapsed: markedItem?.querySelector('.file-card__collapsed--file') !== null,
        };
    }, start.index);

    test.info().annotations.push({
        type: 'scroll-stability',
        description: `advance: ${String(start.index)} → ${String(after.topIndex)}, offset=${after.offset.toFixed(1)}px`,
    });

    expect(after.markedCollapsed).toBe(true);
    // The view moves from the marked file to the next one, with its header just below the sticky toolbar
    // (`scrollPaddingStart` = its height). `scrollTop` itself decreases because the collapsed
    // card pulls the next one up by more than the reviewer has scrolled into it.
    expect(after.topIndex).toBeGreaterThan(start.index);
    expect(Math.abs(after.offset)).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
});

test('marking the last file and clearing a mark do not move the view', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');
    await openFullDiff(page, server.url);

    // The fixture's last file is generated, so it starts as read and collapsed. Expand
    // it and clear its mark so the test marks the list's last file from a clean state.
    const index = await page.locator('.full-diff').evaluate(async (scroller) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        scroller.scrollTop = scroller.scrollHeight;
        for (let frame = 0; frame < 60; frame += 1) {
            await nextFrame();
        }
        const index = Math.max(
            ...[...document.querySelectorAll<HTMLElement>('.diff-list__item')].map((item) =>
                Number(item.dataset.index),
            ),
        );
        document
            .querySelector<HTMLElement>(`.diff-list__item[data-index="${String(index)}"]`)
            ?.querySelector<HTMLElement>('.file-card__collapsed--file')
            ?.click();
        for (let frame = 0; frame < 30; frame += 1) {
            await nextFrame();
        }
        return index;
    });

    const toggle = page.locator(`.diff-list__item[data-index="${String(index)}"] .file-card__viewed`);
    if ((await toggle.getAttribute('aria-pressed')) === 'true') {
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    }

    const before = await placeUnderToolbar(page, index);
    await toggle.click();
    const marked = await settleScroll(page, index);

    test.info().annotations.push({
        type: 'scroll-stability',
        description: `last file: scrollTop ${before.scrollTop.toFixed(1)} → ${marked.scrollTop.toFixed(1)}, height ${before.height.toFixed(1)} → ${marked.height.toFixed(1)}`,
    });

    expect(marked.collapsed).toBe(true);
    // The view does not move forward because there is no next file and no jump was requested. It moves back only
    // as far as the document itself shrank, since the collapsed card was last.
    expect(marked.scrollTop).toBeLessThanOrEqual(before.scrollTop + JUMP_TOLERANCE_PX);
    expect(before.scrollTop - marked.scrollTop).toBeLessThanOrEqual(
        before.height - marked.height + JUMP_TOLERANCE_PX,
    );

    await toggle.click();
    const restored = await settleScroll(page, index);
    expect(restored.collapsed).toBe(false);
    // Clearing a mark does not request a scroll. The card grows downwards, the document above it stays in place.
    expect(Math.abs(restored.scrollTop - marked.scrollTop)).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
});

/**
 * Place the card below the sticky toolbar and return the position used to measure the jump. `depth` is
 * how far the reviewer has read. The header moves that far under the toolbar while remaining sticky.
 */
function placeUnderToolbar(
    page: Page,
    index: number,
    depth = 0,
): Promise<{ scrollTop: number; height: number }> {
    return page.locator('.full-diff').evaluate(async (scroller, { target, depth }) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        const itemOf = (): HTMLElement | null =>
            document.querySelector<HTMLElement>(`.diff-list__item[data-index="${String(target)}"]`);
        const toolbarBottom = (): number =>
            document.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom ?? 0;

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const item = itemOf();
            if (item === null) {
                throw new Error('the card left the DOM before marking viewed');
            }
            scroller.scrollTop += item.getBoundingClientRect().top - toolbarBottom() + depth;
            for (let frame = 0; frame < 12; frame += 1) {
                await nextFrame();
            }
        }
        const item = itemOf();
        if (item === null) {
            throw new Error('the card left the DOM before marking viewed');
        }
        return { scrollTop: scroller.scrollTop, height: item.getBoundingClientRect().height };
    }, { target: index, depth });
}

/** Card position and collapsed state after remeasurements settle. `offset` is measured from the toolbar edge. */
function settleScroll(
    page: Page,
    index: number,
): Promise<{ scrollTop: number; height: number; collapsed: boolean; offset: number }> {
    return page.locator('.full-diff').evaluate(async (scroller, target) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        for (let frame = 0; frame < 40; frame += 1) {
            await nextFrame();
        }
        const item = document.querySelector<HTMLElement>(`.diff-list__item[data-index="${String(target)}"]`);
        if (item === null) {
            throw new Error('the card left the DOM after marking viewed');
        }
        const toolbarBottom =
            document.querySelector<HTMLElement>('.full-diff__toolbar')?.getBoundingClientRect().bottom ?? 0;
        return {
            scrollTop: scroller.scrollTop,
            height: item.getBoundingClientRect().height,
            collapsed: item.querySelector('.file-card__collapsed--file') !== null,
            offset: item.getBoundingClientRect().top - toolbarBottom,
        };
    }, index);
}

/**
 * Collapse from an external mark (another tab, progress reload, stop coverage) is
 * a remeasurement while the reviewer reads, not a jump requested by the view. The screen must stay on the card
 * being read. The collapse reason is still `viewed`, and the list anchor must not depend on it.
 */
test('an external viewed mark collapses the card being read without moving its header', async ({ page, launchSherpa }) => {
    const server = await launchSherpa('fixture-large');
    await openFullDiff(page, server.url);

    const target = await page.locator('.full-diff').evaluate(async (scroller) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) / 2);
        for (let frame = 0; frame < 90 && document.querySelector('.file-card__loading') !== null; frame += 1) {
            await nextFrame();
        }
        for (let frame = 0; frame < 20; frame += 1) {
            await nextFrame();
        }
        const item = [...document.querySelectorAll<HTMLElement>('.diff-list__item')]
            .sort((left, right) => Number(left.dataset.index) - Number(right.dataset.index))
            .find(
                (candidate) =>
                    candidate.querySelector('.file-card__collapsed--file') === null &&
                    candidate.getBoundingClientRect().height > 500,
            );
        const fileId = item?.querySelector<HTMLElement>('.file-card[data-file]')?.dataset.file;
        if (item === undefined || fileId === undefined) {
            throw new Error('a tall expanded card is required in the middle of fixture-large');
        }
        return { index: Number(item.dataset.index), fileId };
    });

    // The reviewer has read halfway through the card. Its header sticks to the toolbar, and its top is already above it,
    // exactly the geometry in which collapsing without an anchor pulls everything below upwards.
    const before = await placeUnderToolbar(page, target.index, 400);

    // The mark bypasses the view, as if sent from another tab. It returns to this tab over SSE.
    const token = await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('t') ?? '');
    const response = await page.request.post(new URL('/api/ui/review/file-viewed', server.url).toString(), {
        headers: { authorization: `Bearer ${token}` },
        data: { fileId: target.fileId, viewed: true },
    });
    expect(response.ok()).toBe(true);

    const item = `.diff-list__item[data-index="${String(target.index)}"]`;
    await expect(page.locator(`${item} .file-card__collapsed--file`)).toHaveCount(1);
    const after = await settleScroll(page, target.index);

    test.info().annotations.push({
        type: 'scroll-stability',
        description: `foreign viewed: offset=${after.offset.toFixed(1)}px, height ${before.height.toFixed(1)} → ${after.height.toFixed(1)}`,
    });

    expect(after.collapsed).toBe(true);
    // The card collapsed under the cursor. Its header stayed below the sticky toolbar.
    expect(Math.abs(after.offset)).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
});

test('route: marking a stop places the next one at −150px from the container edge', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const raw = mediumRawResults();

    await page.goto(server.url);
    await page.getByRole('tab', { name: 'Route', exact: true }).click();
    expect((await server.worker.register('claude-code')).code).toBe(0);
    const skeleton = await takeTask(server.worker, 'route.skeleton');
    await submit(server.worker, skeleton.taskId, raw.skeleton);
    for (const sectionIndex of raw.sections.keys()) {
        const task = await takeTask(server.worker, 'route.section');
        expect(task.planIndexes, `section ${String(sectionIndex + 1)}`).toHaveLength(1);
        await submit(server.worker, task.taskId, sectionFor(task.planIndexes));
    }
    await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    await page.locator('[data-stop="s01"] .route-stop__viewed').click();

    // The jump takes ~320ms and is corrected once more after settle. Measure when everything has settled.
    const geometry = await page.locator('.route').evaluate(async (container) => {
        const nextFrame = (): Promise<void> =>
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => {
                    resolve();
                });
            });
        for (let frame = 0; frame < 90; frame += 1) {
            await nextFrame();
        }
        const section = container.querySelector<HTMLElement>('[data-stop="s02"]');
        if (section === null) {
            throw new Error('the fixture route has no stop s02');
        }
        return {
            offset: Number((section.getBoundingClientRect().top - container.getBoundingClientRect().top).toFixed(1)),
            scrollTop: container.scrollTop,
            maxScroll: container.scrollHeight - container.clientHeight,
        };
    });

    test.info().annotations.push({
        type: 'scroll-stability',
        description: `route jump: s02 offset=${geometry.offset.toFixed(1)}px, scrollTop=${geometry.scrollTop.toFixed(1)}/${geometry.maxScroll.toFixed(1)}`,
    });

    expect(Math.abs(geometry.offset - ROUTE_JUMP_OFFSET_PX)).toBeLessThanOrEqual(JUMP_TOLERANCE_PX);
});
