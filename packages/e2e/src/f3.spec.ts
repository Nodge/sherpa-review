import type { Page } from '@playwright/test';
import { MEDIUM_DIFF_ID, MEDIUM_HEAD_COMMIT, MEDIUM_HEAD_COMMIT_V2 } from '@sherpa/fixtures';

import { answerChat, buildRoute, buildRouteV2, takeTask } from './route-worker.js';
import type { SherpaServerHandle } from './sherpa-fixture.js';
import {
    advanceIteration,
    diffOf,
    expect,
    fragmentParam,
    progressOf,
    sherpaAuth,
    test,
} from './sherpa-fixture.js';

/**
 * F3 (brief §7): the author pushed another commit while the reviewer was reading. The route declares itself
 * stale, rebuilding carries over progress, "what is new" shows 3 rebuilt
 * stops, notes move with the code (one loses its anchor), and the conversation
 * on rewritten lines stays readable on the old commit.
 *
 * First live integration of UI (M4-T8…T12) and server (M4-T4/T6/T7) on fixtures: 2 full
 * route generations and 3 chat exchanges through the CLI bundle exceed the default 120 s.
 */
test.setTimeout(240_000);

const V1_SHORT = MEDIUM_HEAD_COMMIT.slice(0, 7);
const V2_SHORT = MEDIUM_HEAD_COMMIT_V2.slice(0, 7);

const EDIT_WINDOW = 'services/orders/src/domain/edit-window.ts';
const HANDLERS = 'services/orders/src/api/handlers.ts';

/**
 * 3 anchored questions. The first 2 are in a file the second push leaves unchanged, so their
 * notes move to the new iteration with zero offset. The third sits exactly on lines
 * rewritten by the push, so its note has no anchor in the new iteration.
 */
const QUESTIONS = [
    {
        path: EDIT_WINDOW,
        start: 24,
        end: 32,
        label: 'edit-window.ts:24–32',
        text: 'Why does dispatch close the window before the deadline?',
        answer: 'Courier dispatch closes the window even within the thirty minutes. The order is already packed, so it is too late to change its contents.',
    },
    {
        path: EDIT_WINDOW,
        start: 29,
        end: 38,
        label: 'edit-window.ts:29–38',
        text: 'What does remainingMs return for a closed window?',
        answer: 'For a closed window, `remainingMs` returns zero. The state is checked before subtracting the time.',
    },
    {
        path: HANDLERS,
        start: 48,
        end: 54,
        label: 'handlers.ts:48–54',
        text: 'Why is remainingMs included in the 409 rejection body?',
        answer: 'The client shows a countdown, so the remaining time is sent along with the rejection code.',
    },
] as const;

/** Stops the reviewer marks before the push. The push leaves 3 unchanged and touches s02. */
const MARKED_STOPS = ['s01', 's02', 's04', 's05'] as const;
/** The push rebuilds these: 02 and 03 changed, 06 was built anew (`route-medium-v2`). */
const CHANGED_STOPS = ['s02', 's03', 's06'] as const;
/** The thread the model named as the reason stop 03 changed. */
const CHANGE_THREAD = '4820242';
/** Bot thread on `payments/card-token.ts`. The file left the PR with the second push. */
const DEPARTED_THREAD = '4820260';

test('F3: push while reading → stale route → rebuild with progress and note carryover', async ({
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

    await test.step('3 anchored questions become 3 notes', async () => {
        for (const question of QUESTIONS) {
            const fileId = await fileIdOf(page, server, question.path);
            const asked = await page.request.post(new URL('/api/ui/review/chat/ask', server.url).href, {
                headers: sherpaAuth(server),
                data: {
                    text: question.text,
                    anchor: {
                        fileId,
                        path: question.path,
                        side: 'new',
                        start: question.start,
                        end: question.end,
                    },
                },
            });
            expect(asked.status(), await asked.text()).toBe(200);

            const task = await takeTask(worker, 'chat');
            await answerChat(worker, task.taskId, question.answer);
        }

        await page.locator('.agent-pill').click();
        await expect(page.locator('.chat-panel__notes')).toHaveText('Notes 3');
        await page.getByRole('button', { name: 'Close chat', exact: true }).click();
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

    await test.step('author pushes: stale banner arrives over SSE without reload', async () => {
        await advanceIteration(page, server);

        const banner = page.locator('.banner-slot .iteration-banner[aria-label="Route is stale"]');
        await expect(banner).toBeVisible();
        // `affectedStopIds` are calculated after the interdiff and arrive in a second notification.
        await expect(banner.locator('.iteration-banner__line')).toHaveText(
            `The route was built for ${V1_SHORT}, the PR is already at ${V2_SHORT} — 1 new iteration; ` +
                'stops 02, 03 and 06 are affected',
        );
        await expect(banner.locator('button.iteration-banner__action')).toHaveText('Rebuild the route');
        await expect(banner.locator('button.iteration-banner__secondary')).toHaveText(
            `Open the ${V2_SHORT} diff without a route`,
        );

        // Until rebuilding, the tab stays on the snapshot iteration. The diff stays unchanged, stop
        // stops do not drift, and marks stay in place (task breakdown decision 10).
        await expect(page.locator('.route-drift')).toHaveCount(0);
        await expect(page.locator('.coverage__stops')).toHaveText('4 of 7 stops viewed');

        // Progress carries over to the new iteration asynchronously. Rebuilding uses that progress.
        await expect
            .poll(async () => (await seenRangeCount(page, server)) > 0, { timeout: 30_000 })
            .toBe(true);
    });

    await test.step('"Rebuild route": agent submits the second pass', async () => {
        await page.locator('.iteration-banner[aria-label="Route is stale"] button.iteration-banner__action').click();
        await buildRouteV2(worker);

        await expect(page.locator('.route-skeleton-card')).toHaveCount(0);
        await expect(page.locator('[data-stop]')).toHaveCount(7);
    });

    await test.step('second-pass banner: progress carried over, affected stop marks cleared', async () => {
        const banner = page.locator('.banner-slot .iteration-banner[aria-label="Route rebuilt"]');
        await expect(banner.locator('.iteration-banner__line')).toHaveText(`The route was rebuilt for ${V2_SHORT}.`);
        await expect(banner.locator('.iteration-banner__note')).toHaveText(
            'Progress carried over: 3 of 7 stops are unchanged and remain viewed. ' +
                'Comments on changed ranges are pinned to the old commit',
        );

        for (const stopId of ['s01', 's04', 's05']) {
            await expect(page.locator(`[data-stop="${stopId}"] button.route-stop__viewed`)).toHaveAttribute(
                'aria-pressed',
                'true',
            );
        }
        for (const stopId of CHANGED_STOPS) {
            await expect(page.locator(`[data-stop="${stopId}"] button.route-stop__viewed`)).toHaveAttribute(
                'aria-pressed',
                'false',
            );
        }
        await expect(page.locator('.coverage__stops')).toHaveText('3 of 7 stops viewed');
        // The diff was reread on the new iteration. Second-pass anchors match its code again.
        await expect(page.locator('.coverage__legend-text')).toHaveText(
            '871 changed lines · 95% explained · 41 lines not explained',
        );
        // A distant stop's diff column is removed from the DOM (M5-T13). Scroll to the unmarked
        // stop to inspect it. Cards return near the viewport.
        const changed = page.locator(`[data-stop="${CHANGED_STOPS[0]}"]`);
        await changed.scrollIntoViewIfNeeded();
        await expect(changed.locator('.file-card[data-file]').first()).toBeVisible();
    });

    await test.step('"What is new since the last pass" leaves 3 stops on screen', async () => {
        // The top visible stop survives the filter with a marker (SPEC §2.7). To make that stop
        // 01, scroll the route to the start, since automatic marks moved it to their next stop.
        await page.locator('[data-stop="s01"]').scrollIntoViewIfNeeded();
        await page
            .locator('.iteration-banner[aria-label="Route rebuilt"] button.iteration-banner__action')
            .click();

        await expect.poll(() => fragmentParam(page, 'routeFilter')).toBe('new');
        await expect(page.locator('.route-toolbar__filters button.route-change-chip')).toHaveText(
            'Showing changes since the previous pass',
        );
        await expect(page.locator('section.route-stop[data-stop-change]')).toHaveCount(3);
        await expect(page.locator('[data-stop="s01"] .route-stop__kept')).toHaveText(
            'kept in view — outside the current filter',
        );
        for (const stopId of ['s04', 's05', 'other']) {
            await expect(page.locator(`[data-stop="${stopId}"]`)).toHaveCount(0);
        }

        await expect(page.locator('[data-stop="s02"] .route-stop__badge--changed')).toHaveText('changed');
        await expect(page.locator('[data-stop="s03"] .route-stop__badge--changed')).toHaveText('changed');
        await expect(page.locator('[data-stop="s06"] .route-stop__badge--new')).toHaveText('new');
    });

    await test.step('stop 03 change explanation links to the thread that caused it', async () => {
        const change = page.locator('[data-stop="s03"] .route-stop__change');
        await expect(change.locator('.route-stop__change-label')).toHaveText('why this stop changed');
        await expect(change.locator('.route-stop__change-body')).toContainText(
            'remaining time moved to api/rejection-status.ts',
        );

        const link = change.locator('button.route-stop__change-thread');
        await expect(link).toHaveText('thread at line 49');
        await link.click();

        await expect(page.getByRole('tab', { name: 'Full diff', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect.poll(() => fragmentParam(page, 'thread')).toBe(CHANGE_THREAD);
        await expect(page.locator(`#thread-${CHANGE_THREAD}`)).toBeVisible();
    });

    await test.step('notes: 2 moved with the code, the third lost its anchor', async () => {
        await page.getByRole('tab', { name: 'Route', exact: true }).click();
        await page.locator('.route-toolbar__filters button.route-change-chip').click();
        await expect(page.locator('.route-toolbar__filters')).toHaveCount(0);

        await page.locator('.agent-pill').click();
        const panel = page.locator('aside.chat-panel[aria-label="Chat with the agent"]');
        await expect(panel.locator('.chat-panel__notes')).toHaveText('Notes 3');
        // The push left `edit-window.ts` untouched: its anchors moved to the new iteration with zero offset,
        // and navigation from the chat to the note is available.
        for (const question of QUESTIONS.filter((entry) => entry.path === EDIT_WINDOW)) {
            const note = panel.locator('button.chat-message__note', { hasText: question.label });
            await expect(note).toHaveText(`◆ Pinned by a note at ${question.label}`);
            await expect(note).toBeEnabled();
        }
        await expect(panel.locator('span.chat-message__note-lost')).toHaveText(
            'anchor lost after the push · handlers.ts:48–54',
        );
        const lost = panel.locator('button.chat-message__note', { hasText: 'handlers.ts' });
        await expect(lost).toBeDisabled();
        await expect(lost).toHaveAttribute('title', 'anchor lost — the note has no code in this iteration');
    });

    await test.step('the lost-notes banner sits below the second-pass banner', async () => {
        const more = page.locator('.banner-slot button.banner-slot__more');
        await expect(more).toHaveText('+1 notice');
        await more.click();

        const banner = page.locator('.banner-slot .iteration-banner[aria-label="Notes lost their anchor"]');
        await expect(banner.locator('.iteration-banner__line')).toHaveText(
            '1 note lost its anchor after the new push',
        );
        await expect(banner.locator('button.iteration-banner__action')).toHaveText('View');
    });

    await test.step('an outdated thread opens at its commit and returns to the current one', async () => {
        await page.getByRole('tab', { name: 'Full diff', exact: true }).click();
        const thread = page.locator(`#thread-${CHANGE_THREAD}`);
        await thread.scrollIntoViewIfNeeded();
        await expect(thread.locator('span.thread__chip--pinned')).toHaveText(`pinned to ${V1_SHORT}`);
        await expect(thread.locator('span.thread__chip--pinned')).toHaveAttribute('title', MEDIUM_HEAD_COMMIT);

        await thread.locator('button.thread__pin-action').click();

        await expect.poll(() => fragmentParam(page, 'diff')).toBe(MEDIUM_DIFF_ID);
        await expect.poll(() => fragmentParam(page, 'thread')).toBe(CHANGE_THREAD);
        const readOnly = page.locator('.banner-slot .iteration-banner[aria-label="Read-only"]');
        await expect(readOnly.locator('.iteration-banner__line')).toHaveText(
            new RegExp(`^You are looking at the previous iteration ${V1_SHORT} · .+ · read-only$`),
        );
        await expect(page.locator(`#thread-${CHANGE_THREAD}`)).toBeVisible();
        // Marks belong to the active iteration: the control is visible in a previous one, but cannot be clicked.
        const viewed = page.locator('.file-card button.viewed-toggle').first();
        await expect(viewed).toBeDisabled();
        await expect(viewed).toHaveAttribute('title', 'only in the active iteration');

        await readOnly.locator('button.iteration-banner__action').click();
        await expect.poll(() => fragmentParam(page, 'diff')).toBeNull();
        await expect(readOnly).toHaveCount(0);
    });

    await test.step('threads on files removed from the PR form a separate group', async () => {
        // A review bot wrote the thread, and bots are hidden by default (SPEC §2.8).
        await page.locator('.thread-chips button.thread-chip', { hasText: 'Bots' }).click();

        const outside = page.locator('.thread-outside__toggle');
        await expect(outside).toHaveText('1 thread on files no longer in this PR');
        await outside.click();
        await expect(page.locator(`#thread-${DEPARTED_THREAD}`)).toBeVisible();
    });
});

/** The active iteration file's `fileId`: a question anchor addresses the file by it (chat contract). */
async function fileIdOf(page: Page, server: SherpaServerHandle, path: string): Promise<string> {
    const file = (await diffOf(page, server)).find((entry) => entry.path === path);
    if (file === undefined) {
        throw new Error(`no file ${path} in the active iteration`);
    }
    return file.fileId;
}

/** The number of read ranges in the active iteration shows whether carryover has arrived. */
async function seenRangeCount(page: Page, server: SherpaServerHandle): Promise<number> {
    const { files } = await progressOf(page, server);
    return files.reduce((total, file) => total + file.seenRanges.length, 0);
}
