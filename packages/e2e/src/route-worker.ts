import type { FakeWorker, NextRun, WorkerRun } from '@sherpa/cli/fake-worker';
import type { RouteRawResults } from '@sherpa/fixtures';
import { routeFixtures } from '@sherpa/fixtures';
import { expect } from '@playwright/test';

/**
 * Agent loop for route e2e tests. An emulated session uses the CLI bundle and submits prepared
 * model outputs from the `medium` fixture, the same outputs used by the validator's golden corpus.
 *
 * The test writes the loop, rather than `FakeWorker`: `worker next` long-polls for four minutes, so
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

/** Raw result text. The model submits a file, not an object (`route/fixture-support.ts`). */
export function asRawText(result: unknown): string {
    return JSON.stringify(result, null, 2);
}

/** A claimed task with its ID already parsed, so the rest of the loop needs no null checks. */
export interface RouteTask extends NextRun {
    readonly taskId: number;
}

/** Take the next task and check that it has the expected type. */
export async function takeTask(worker: FakeWorker, type: 'route.skeleton' | 'route.section'): Promise<RouteTask> {
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
    const sections = mediumRawResults().sections;
    return {
        stops: planIndexes.map((planIndex) => {
            const stop = sections.flatMap((section) => section.stops).find((entry) => entry.planIndex === planIndex);
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
