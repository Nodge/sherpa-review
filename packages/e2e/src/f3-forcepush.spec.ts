import type { Page } from '@playwright/test';
import {
    MEDIUM_DIFF_ID,
    MEDIUM_DIFF_ID_V2,
    MEDIUM_DIFF_ID_V3,
    MEDIUM_HEAD_COMMIT,
    MEDIUM_HEAD_COMMIT_V2,
    MEDIUM_HEAD_COMMIT_V3,
} from '@sherpa/fixtures';

import { buildRoute, buildRouteV2 } from './route-worker.js';
import type { SherpaServerHandle } from './sherpa-fixture.js';
import {
    advanceIteration,
    diffOf,
    expect,
    fragmentParam,
    progressOf,
    seenRangeKeys,
    test,
} from './sherpa-fixture.js';

/**
 * F3, continued (M4-T15): the second push rewrote the first, a force-push. The iteration the route
 * was built on disappears from the host, and all Sherpa knows about it is the locally saved
 * patch. The route stays readable, progress carries over past the missing iteration,
 * and the UI never offers a slice to it. After rebuilding, its snapshot becomes read-only,
 * marked to say the commit is no longer in the PR.
 *
 * Live integration through the CLI bundle: 2 route generations exceed the default 120 s.
 */
test.setTimeout(240_000);

const V1_SHORT = MEDIUM_HEAD_COMMIT.slice(0, 7);
const V2_SHORT = MEDIUM_HEAD_COMMIT_V2.slice(0, 7);
const V3_SHORT = MEDIUM_HEAD_COMMIT_V3.slice(0, 7);

/** Stops the reviewer marks in the first iteration. The push touches s02 and leaves the rest unchanged. */
const MARKED_STOPS = ['s01', 's02', 's04', 's05'] as const;

/** The only file rewritten by the force-push. Only its lines carry over differently afterward. */
const README = 'services/orders/README.md';

/** Read ranges in all files except the one rewritten by the force-push. */
function outsideReadme(keys: readonly string[]): string[] {
    return keys.filter((key) => !key.startsWith(`${README}:`));
}

/** Slice v1 → v3 files in order: `SLICE_V1_V2` plus the README rewritten by the force-push. */
const SLICE_V1_V3_PATHS = [
    'services/orders/src/domain/policies/edit-policy.ts',
    'services/orders/src/api/handlers.ts',
    'services/orders/src/api/rejection-status.ts',
    'services/orders/src/payments/card-token.ts',
    'pnpm-lock.yaml',
    README,
];

test('F3 force-push: route iteration disappears, route stays readable, progress carries over past it', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    await test.step('first-pass route built on iteration 9f3c1ab', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Route', exact: true }).click();
        expect((await worker.register('claude-code')).code).toBe(0);
        await buildRoute(worker);

        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('[data-stop]')).toHaveCount(7);
    });

    await test.step('reviewer marks 4 of 7 stops as viewed', async () => {
        for (const stopId of MARKED_STOPS) {
            const toggle = page.locator(`[data-stop="${stopId}"] button.route-stop__viewed`);
            await toggle.scrollIntoViewIfNeeded();
            await toggle.click();
            await expect(toggle).toHaveAccessibleName('Viewed');
        }
        await expect(page.locator('.coverage__stops')).toHaveText('4 of 7 stops viewed');
    });

    let carriedToV2: string[] = [];
    await test.step('first push: route stale, progress carried over to a71d4e2', async () => {
        await advanceIteration(page, server);

        const banner = page.locator('.banner-slot .iteration-banner[aria-label="Route is stale"]');
        await expect(banner.locator('.iteration-banner__line')).toHaveText(
            `The route was built for ${V1_SHORT}, the PR is already at ${V2_SHORT} — 1 new iteration; ` +
                'stops 02, 03 and 06 are affected',
        );

        // Carryover runs after the server fetches and saves the new iteration patch. Wait for it,
        // or a second push would leave v2 absent from storage entirely.
        await expect
            .poll(async () => (await seenRangeKeys(page, server, MEDIUM_DIFF_ID_V2)).length, { timeout: 30_000 })
            .toBeGreaterThan(0);
        carriedToV2 = await seenRangeKeys(page, server, MEDIUM_DIFF_ID_V2);
    });

    let markedOnV2: string[] = [];
    await test.step('rebuild on a71d4e2 and one more mark on the second iteration itself', async () => {
        await page.locator('.iteration-banner[aria-label="Route is stale"] button.iteration-banner__action').click();
        await buildRouteV2(worker);
        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('.coverage__stops')).toHaveText('3 of 7 stops viewed');

        const toggle = page.locator('[data-stop="s02"] button.route-stop__viewed');
        await toggle.scrollIntoViewIfNeeded();
        await toggle.click();
        await expect(toggle).toHaveAccessibleName('Viewed');
        await expect(page.locator('.coverage__stops')).toHaveText('4 of 7 stops viewed');

        const afterMark = await seenRangeKeys(page, server, MEDIUM_DIFF_ID_V2);
        markedOnV2 = afterMark.filter((key) => !carriedToV2.includes(key));
        expect(markedOnV2.length, 'marking s02 must add ranges from the second iteration itself').toBeGreaterThan(0);
    });

    await test.step('force-push: banner names both sides and says nothing about stops', async () => {
        await advanceIteration(page, server);

        const banner = page.locator('.banner-slot .iteration-banner[aria-label="Route is stale"]');
        await expect(banner).toBeVisible();
        // Affected stops are calculated from the a71d4e2 → c4f9b17 slice, but the host no longer has
        // that iteration. The failure is permanent, so the stop list will never appear in the banner.
        await expect(banner.locator('.iteration-banner__line')).toHaveText(
            `The route was built for ${V2_SHORT}, the PR is already at ${V3_SHORT} — 1 new iteration`,
        );
        await expect(banner.locator('button.iteration-banner__secondary')).toHaveText(
            `Open the ${V3_SHORT} diff without a route`,
        );
    });

    await test.step('picker keeps the vanished iteration snapshot but offers no slice to it', async () => {
        await page.locator('button.snapshot-pill--button[aria-haspopup="menu"]').click();
        const menu = page.locator('[role="menu"][aria-label="Snapshots and iterations"]');
        await expect(menu.locator('.snapshot-picker__section')).toHaveText([
            'Snapshots',
            'Iterations without a route',
            'Show changes since iteration…',
        ]);

        // The second-pass snapshot remains the current PR route. The force-push removed its iteration,
        // but the reviewer does not have to rebuild the route and keeps reading it until rebuilding.
        const snapshots = menu.locator('.snapshot-picker__row[data-snapshot]');
        await expect(snapshots).toHaveCount(2);
        await expect(snapshots.nth(0)).toHaveText(new RegExp(`^${V2_SHORT} · .* · current$`));
        await expect(snapshots.nth(1)).toHaveText(new RegExp(`^${V1_SHORT} · .* · stale$`));

        await expect(menu.locator('.snapshot-picker__row[data-diff]')).toHaveText(
            `${V3_SHORT} · active iteration · no route`,
        );

        // The review host refuses to calculate a slice with a gone iteration, so it has no row.
        await expect(menu.locator(`.snapshot-picker__row[data-slice="${MEDIUM_DIFF_ID_V2}"]`)).toHaveCount(0);
        await expect(menu.locator('.snapshot-picker__row[data-slice]')).toHaveText(
            new RegExp(`^${V1_SHORT} · .* · → ${V3_SHORT}$`),
        );

        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
    });

    await test.step('route of the missing iteration is readable because the server has its patch', async () => {
        await expect(page.locator('[data-stop]')).toHaveCount(7);
        await expect(page.locator('.file-card[data-file]').first()).toBeVisible();
        await expect(page.locator('.coverage__stops')).toHaveText('4 of 7 stops viewed');

        // The host no longer returns the iteration. Its diff comes from local patch storage (brief §4a).
        const stored = await diffOf(page, server, MEDIUM_DIFF_ID_V2);
        expect(stored.length).toBeGreaterThan(0);
    });

    await test.step('progress carries over to c4f9b17 from the first iteration, not the missing one', async () => {
        await expect
            .poll(async () => (await seenRangeKeys(page, server, MEDIUM_DIFF_ID_V3)).length, { timeout: 30_000 })
            .toBeGreaterThan(0);

        // Carryover starts from the latest iteration with progress, a71d4e2. The host permanently
        // the host refuses permanently, and carryover falls back to 9f3c1ab (M4-T6 + T16 decision).
        // Marks made on a71d4e2 itself are lost. That is the cost of a force-push.
        const carriedToV3 = await seenRangeKeys(page, server, MEDIUM_DIFF_ID_V3);
        expect(outsideReadme(carriedToV3)).toEqual(outsideReadme(carriedToV2));
        for (const key of markedOnV2) {
            expect(carriedToV3, 'a mark from the second iteration does not carry over to the third').not.toContain(key);
        }
        // Carryover used the 9f3c1ab → c4f9b17 slice, which also includes the force-push change.
        // The read README range 43–52 split around the line it added.
        expect(carriedToV3.filter((key) => key.startsWith(`${README}:new`))).toEqual([
            `${README}:new:25-27`,
            `${README}:new:43-47`,
            `${README}:new:50-53`,
        ]);
        expect(carriedToV2).toContain(`${README}:new:43-52`);

        // Stop marks are keyed by snapshot and carried over when it is frozen. The route was not
        // rebuilt on c4f9b17, so marked stops stayed with snapshot a71d4e2.
        expect((await progressOf(page, server, MEDIUM_DIFF_ID_V3)).stops).toEqual([]);
        expect((await progressOf(page, server, MEDIUM_DIFF_ID_V2)).stops).toEqual([
            { stopId: 's01', viewed: true },
            { stopId: 's02', viewed: true },
            { stopId: 's04', viewed: true },
            { stopId: 's05', viewed: true },
        ]);
    });
});

test('F3 force-push: the 9f3c1ab → c4f9b17 slice shows changes across the missing iteration', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    await test.step('route built on 9f3c1ab, one stop marked', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Route', exact: true }).click();
        expect((await worker.register('claude-code')).code).toBe(0);
        await buildRoute(worker);
        await expect(page.locator('[data-stop]')).toHaveCount(7);

        const toggle = page.locator('[data-stop="s01"] button.route-stop__viewed');
        await toggle.scrollIntoViewIfNeeded();
        await toggle.click();
        await expect(toggle).toHaveAccessibleName('Viewed');
    });

    await test.step('2 consecutive pushes: the second rewrites the first', async () => {
        await advanceIteration(page, server);
        // The second iteration patch must reach storage before the force-push. Otherwise the server
        // never learns about it and has nothing to mark `gone`.
        await expect
            .poll(async () => (await seenRangeKeys(page, server, MEDIUM_DIFF_ID_V2)).length, { timeout: 30_000 })
            .toBeGreaterThan(0);

        await advanceIteration(page, server);
        await expect(
            page.locator('.banner-slot .iteration-banner[aria-label="Route is stale"] .iteration-banner__line'),
        ).toHaveText(
            `The route was built for ${V1_SHORT}, the PR is already at ${V3_SHORT} — 1 new iteration; ` +
                'stops 02, 03, 05 and 06 are affected',
        );
    });

    await test.step('the gone iteration is in the picker but has no slice to it', async () => {
        await page.locator('button.snapshot-pill--button[aria-haspopup="menu"]').click();
        const menu = page.locator('[role="menu"][aria-label="Snapshots and iterations"]');
        await expect(menu.locator(`.snapshot-picker__row[data-diff="${MEDIUM_DIFF_ID_V2}"]`)).toHaveText(
            `${V2_SHORT} · commit no longer in the PR · no route`,
        );
        await expect(menu.locator('.snapshot-picker__row[data-slice]')).toHaveCount(1);

        await menu.locator(`.snapshot-picker__row[data-slice="${MEDIUM_DIFF_ID}"]`).click();
        await expect.poll(() => fragmentParam(page, 'base')).toBe(MEDIUM_DIFF_ID);
        await expect.poll(() => fragmentParam(page, 'head')).toBe(MEDIUM_DIFF_ID_V3);
    });

    await test.step('Route tab explains that no route is built for a slice', async () => {
        // The no-route slice screen replaces the entire workspace: neither a header with a pill,
        // nor a banner slot, only an explanation and a way to open the reader.
        const empty = page.locator('main.route-empty#view-route');
        await expect(empty.locator('.invitation-card__title')).toHaveText('No route for a slice');
        await expect(empty.locator('button.invitation-card__primary')).toHaveText('To the full diff');
        await empty.locator('button.invitation-card__primary').click();
    });

    await test.step('the reader identifies the slice through its pill, banner, and interdiff files', async () => {
        await expect(page.getByRole('tab', { name: 'Full diff', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(page.locator('button.snapshot-pill--button')).toHaveText(`slice ${V1_SHORT} → ${V3_SHORT}`);
        const banner = page.locator('.banner-slot .iteration-banner[aria-label="Read-only"]');
        await expect(banner.locator('.iteration-banner__line')).toHaveText(
            `You are looking at the slice between iterations ${V1_SHORT} → ${V3_SHORT} · read-only`,
        );
        await expect(banner.locator('button.iteration-banner__action')).toHaveText('To the active iteration');

        // The card list is virtualized. The screen shows the start of the slice, while the All filter
        // counter in the file panel gives its full size.
        const visible = await page
            .locator('.file-card .file-card__path')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title')));
        expect(visible.length).toBeGreaterThan(0);
        expect(SLICE_V1_V3_PATHS.slice(0, visible.length)).toEqual(visible);
        await expect(
            page.locator('.file-panel__chip', { hasText: 'All' }).locator('.file-panel__chip-count'),
        ).toHaveText(String(SLICE_V1_V3_PATHS.length));

        // Only the force-push touched README. The slice across the missing iteration includes it.
        await page.locator('.file-panel__input').fill('README');
        await expect(page.locator('.file-tree__row .file-tree__label')).toHaveAttribute('title', README);
        await page.locator('.file-panel__input').fill('');
    });

    await test.step('Overview tab explains that no overview is built for a slice', async () => {
        await page.getByRole('tab', { name: 'Overview', exact: true }).click();
        const empty = page.locator('main.route-empty#view-overview');
        await expect(empty.locator('.invitation-card__title')).toHaveText('No overview for a slice');
        await empty.locator('button.invitation-card__primary').click();
    });

    await test.step('"To the active iteration" returns the tab to c4f9b17', async () => {
        await page
            .locator('.banner-slot .iteration-banner[aria-label="Read-only"] button.iteration-banner__action')
            .click();

        await expect.poll(() => fragmentParam(page, 'base')).toBeNull();
        await expect.poll(() => fragmentParam(page, 'head')).toBeNull();
        await expect(page.locator('.banner-slot .iteration-banner[aria-label="Read-only"]')).toHaveCount(0);
        await expect(page.locator('button.snapshot-pill--button')).toHaveText(`snapshot ${V1_SHORT} · stale`);
    });
});

test('F3 force-push: route rebuilt on c4f9b17, missing iteration snapshot stays read-only', async ({
    page,
    launchSherpa,
}) => {
    const server = await launchSherpa('fixture-medium');
    const worker = server.worker;

    await test.step('first route built directly on the second iteration', async () => {
        await page.goto(server.url);
        await page.getByRole('tab', { name: 'Route', exact: true }).click();
        // There is no route yet, so the first push is silent. Generation starts on a71d4e2,
        // and the whole scenario takes 2 generations instead of 3.
        await advanceIteration(page, server);
        await waitForActiveIteration(page, server, MEDIUM_DIFF_ID_V2);

        expect((await worker.register('claude-code')).code).toBe(0);
        await buildRouteV2(worker);
        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('[data-stop]')).toHaveCount(7);
        await expect(page.locator('button.snapshot-pill--button')).toHaveText(`snapshot ${V2_SHORT} · current`);
    });

    await test.step('one stop marked as viewed', async () => {
        const toggle = page.locator('[data-stop="s01"] button.route-stop__viewed');
        await toggle.scrollIntoViewIfNeeded();
        await toggle.click();
        await expect(toggle).toHaveAccessibleName('Viewed');
        await expect(page.locator('.coverage__stops')).toHaveText('1 of 7 stops viewed');
    });

    await test.step('force-push removes the route iteration, route rebuilt on c4f9b17', async () => {
        await advanceIteration(page, server);
        const stale = page.locator('.banner-slot .iteration-banner[aria-label="Route is stale"]');
        await expect(stale.locator('.iteration-banner__line')).toHaveText(
            `The route was built for ${V2_SHORT}, the PR is already at ${V3_SHORT} — 1 new iteration`,
        );

        await stale.locator('button.iteration-banner__action').click();
        // The second-pass results are valid on the third iteration too. The force-push only rewrote
        // README, which has no anchors. Stops land on the same lines in the same files.
        await buildRouteV2(worker);
        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('button.snapshot-pill--button')).toHaveText(`snapshot ${V3_SHORT} · current`);
    });

    await test.step('picker marks the missing iteration snapshot as "commit no longer in PR"', async () => {
        await page.locator('button.snapshot-pill--button[aria-haspopup="menu"]').click();
        const menu = page.locator('[role="menu"][aria-label="Snapshots and iterations"]');
        const snapshots = menu.locator('.snapshot-picker__row[data-snapshot]');
        await expect(snapshots).toHaveCount(2);
        await expect(snapshots.nth(0)).toHaveText(new RegExp(`^${V3_SHORT} · .* · current$`));
        await expect(snapshots.nth(1)).toHaveText(new RegExp(`^${V2_SHORT} · .* · commit no longer in the PR$`));

        await snapshots.nth(1).click();
        await expect(menu).toHaveCount(0);
    });

    await test.step('missing iteration snapshot can be read but not edited', async () => {
        await expect.poll(() => fragmentParam(page, 'snapshot')).not.toBeNull();
        await expect(page.locator('button.snapshot-pill--button')).toHaveText(
            `snapshot ${V2_SHORT} · commit no longer in the PR`,
        );

        const banner = page.locator('.banner-slot .iteration-banner[aria-label="Read-only"]');
        await expect(banner.locator('.iteration-banner__line')).toHaveText(
            new RegExp(`^You are looking at snapshot ${V2_SHORT} · .+ · read-only · the commit is no longer in the PR$`),
        );

        // The host no longer has the iteration. Both the route and its diff come from the local patch.
        await expect(page.locator('[data-stop]')).toHaveCount(7);
        await expect(page.locator('.file-card[data-file]').first()).toBeVisible();
        await expect(page.locator('.coverage__stops')).toHaveText('1 of 7 stops viewed');

        // Marks belong to the active iteration. In the missing iteration, the control is visible but disabled.
        const toggle = page.locator('[data-stop="s01"] button.route-stop__viewed');
        await expect(toggle).toHaveAccessibleName('Viewed');
        await expect(toggle).toBeDisabled();
        await expect(toggle).toHaveAttribute('title', 'only in the active iteration');
    });

    await test.step('"To the current one" returns to the active iteration route', async () => {
        const banner = page.locator('.banner-slot .iteration-banner[aria-label="Read-only"]');
        await expect(banner.locator('button.iteration-banner__action')).toHaveText('To the current one');
        await banner.locator('button.iteration-banner__action').click();

        await expect.poll(() => fragmentParam(page, 'snapshot')).toBeNull();
        await expect(banner).toHaveCount(0);
        await expect(page.locator('button.snapshot-pill--button')).toHaveText(`snapshot ${V3_SHORT} · current`);
        await expect(page.locator('[data-stop="s01"] button.route-stop__viewed')).toBeEnabled();
    });
});

/**
 * Waits for the named iteration to become active on the server. With no route, the tab has no way
 * to identify it: there is no snapshot pill yet, and the only observable sign is the `fileId` of the active
 * diff `fileId`, and each iteration has its own IDs.
 */
async function waitForActiveIteration(page: Page, server: SherpaServerHandle, diffId: string): Promise<void> {
    const expected = (await diffOf(page, server, diffId)).map((file) => file.fileId).toSorted();
    await expect
        .poll(async () => (await diffOf(page, server)).map((file) => file.fileId).toSorted(), { timeout: 30_000 })
        .toEqual(expected);
}
