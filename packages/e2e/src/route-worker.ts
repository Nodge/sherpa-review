import type { FakeWorker, NextRun, WorkerRun } from '@sherpa/cli/fake-worker';
import type { RouteRawResults } from '@sherpa/fixtures';
import { routeFixtures } from '@sherpa/fixtures';
import { expect } from '@playwright/test';

/**
 * Agent loop for route e2e tests. An emulated session uses the CLI bundle and submits prepared
 * model outputs from the `medium` fixture, the same outputs used by the validator's golden corpus.
 *
 * The test drives the loop, not `FakeWorker`. `worker next` waits indefinitely for a task, so
 * the test takes a task only when it knows one is available.
 */

type RouteSectionResult = RouteRawResults['sections'][number];

export function mediumRawResults(): RouteRawResults {
    const raw = routeFixtures('medium')?.rawResults ?? null;
    if (raw === null) {
        throw new Error('the medium fixture has no raw model outputs');
    }
    return raw;
}

/**
 * Model outputs for the second iteration of `medium`. The same six-stop plan, but the three sections affected
 * by the push have "why this stop changed", and the anchors are recalculated for the new iteration.
 */
export function mediumRawResultsV2(): RouteRawResults {
    const raw = routeFixtures('medium')?.rawResultsV2 ?? null;
    if (raw === null) {
        throw new Error('the medium fixture has no raw model outputs for the second pass');
    }
    return raw;
}

/** Model outputs for the `huge` performance fixture: 25 stops across 100 files. */
export function hugeRawResults(): RouteRawResults {
    const raw = routeFixtures('huge')?.rawResults ?? null;
    if (raw === null) {
        throw new Error('the huge fixture has no raw model outputs');
    }
    return raw;
}

/** Raw result text. The model submits a file, not an object (`route/fixture-support.ts`). */
export function asRawText(result: unknown): string {
    return JSON.stringify(result, null, 2);
}

/** A claimed task with its ID already parsed, so the rest of the loop needs no null checks. */
export interface RouteTask extends NextRun {
    readonly taskId: number;
}

/** Task types the server queues for an e2e session: route and chat question. */
export type TaskType = 'route.skeleton' | 'route.section' | 'chat';

/** Number of route sections the server queues for the `medium` fixture, one per plan stop. */
export const MEDIUM_SECTION_COUNT = 6;

/** Take the next task and check that it has the expected type. */
export async function takeTask(worker: FakeWorker, type: TaskType): Promise<RouteTask> {
    const run = await worker.next();
    expect(run.code, `worker next: ${run.stdout}${run.stderr}`).toBe(0);
    expect(run.type).toBe(type);
    const taskId = run.taskId;
    if (taskId === null) {
        throw new Error(`worker next did not return a task ID:\n${run.stdout}`);
    }
    return { ...run, taskId };
}

/** Section result for the task's target stops. Their indexes are read from its instructions. */
export function sectionFor(planIndexes: readonly number[]): RouteSectionResult {
    return pickStops(mediumRawResults(), planIndexes);
}

/**
 * The same for the second iteration. A separate helper, not a `sectionFor` parameter: anchors from the first pass
 * fail validation on the second iteration, so mixing up the two sets must be impossible.
 */
export function sectionForV2(planIndexes: readonly number[]): RouteSectionResult {
    return pickStops(mediumRawResultsV2(), planIndexes);
}

function pickStops(raw: RouteRawResults, planIndexes: readonly number[]): RouteSectionResult {
    const stops = raw.sections.flatMap((section) => section.stops);
    return {
        stops: planIndexes.map((planIndex) => {
            const stop = stops.find((entry) => entry.planIndex === planIndex);
            if (stop === undefined) {
                throw new Error(`the fixture has no section for stop ${String(planIndex)}`);
            }
            return stop;
        }),
    };
}

/**
 * Submit a result the server must accept. The exit code does not reveal a validator rejection.
 * The CLI prints it to stdout and exits with zero (rejection is a normal part of the loop), so the check
 * reads the response text itself.
 */
export async function submit(worker: FakeWorker, taskId: number, result: unknown): Promise<WorkerRun> {
    const run = await worker.complete(taskId, asRawText(result));
    expect(run.code, `task complete: ${run.stdout}${run.stderr}`).toBe(0);
    expect(run.stdout, 'the result must be accepted').not.toContain('was rejected');
    return run;
}

/**
 * A chat answer is submitted as is. A `chat` task result is the answer's Markdown text, not route
 * JSON (docs/protocol.md §6, the whole answer arrives in one `complete`).
 */
export async function answerChat(worker: FakeWorker, taskId: number, answer: string): Promise<WorkerRun> {
    const run = await worker.complete(taskId, answer);
    expect(run.code, `task complete: ${run.stdout}${run.stderr}`).toBe(0);
    expect(run.stdout, 'the answer must be accepted').not.toContain('was rejected');
    return run;
}

/** Take and submit `count` fill tasks in sequence. Each submits exactly the stops it requests. */
export async function fillSections(worker: FakeWorker, count = MEDIUM_SECTION_COUNT): Promise<void> {
    for (let filled = 0; filled < count; filled += 1) {
        const task = await takeTask(worker, 'route.section');
        await submit(worker, task.taskId, sectionFor(task.planIndexes));
    }
}

/**
 * The whole route: the plan and all sections of the `medium` fixture. For tests that need the route ready,
 * rather than step by step. F1 handles the same steps manually because it checks intermediate phases.
 */
export async function buildRoute(worker: FakeWorker): Promise<void> {
    const skeleton = await takeTask(worker, 'route.skeleton');
    await submit(worker, skeleton.taskId, mediumRawResults().skeleton);
    await fillSections(worker);
}

/** Number of stops in the `huge` performance fixture's plan. The server queues as many sections (section batch size is 1). */
export const HUGE_SECTION_COUNT = 25;

/**
 * The whole performance fixture route. The server fills one stop per task, so the
 * test waits for 25 tasks in sequence. This loop's duration is the report's "route building" number.
 */
export async function buildHugeRoute(worker: FakeWorker): Promise<void> {
    const raw = hugeRawResults();
    const skeleton = await takeTask(worker, 'route.skeleton');
    await submit(worker, skeleton.taskId, raw.skeleton);

    const stops = raw.sections.flatMap((section) => section.stops);
    for (let filled = 0; filled < HUGE_SECTION_COUNT; filled += 1) {
        const task = await takeTask(worker, 'route.section');
        await submit(worker, task.taskId, {
            stops: task.planIndexes.map((planIndex) => {
                const stop = stops.find((entry) => entry.planIndex === planIndex);
                if (stop === undefined) {
                    throw new Error(`the huge fixture has no section for stop ${String(planIndex)}`);
                }
                return stop;
            }),
        });
    }
}

/** Rebuild after a push: the same plan, with second-pass sections (F3, force-push). */
export async function buildRouteV2(worker: FakeWorker): Promise<void> {
    const skeleton = await takeTask(worker, 'route.skeleton');
    await submit(worker, skeleton.taskId, mediumRawResultsV2().skeleton);
    for (let filled = 0; filled < MEDIUM_SECTION_COUNT; filled += 1) {
        const task = await takeTask(worker, 'route.section');
        await submit(worker, task.taskId, sectionForV2(task.planIndexes));
    }
}
